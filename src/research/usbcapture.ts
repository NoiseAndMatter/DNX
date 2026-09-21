/**
 * Reading a Wireshark/USBPcap capture back into SysEx — **including the half we have never seen**.
 *
 * ## Why this exists
 *
 * Every byte we know about the Digitone's storage API was decoded from the device's **replies**.
 * Web MIDI can listen on an input while Elektron Transfer holds the ports, so we saw what the
 * instrument said and never what Transfer asked. That asymmetry cost three frozen devices and six
 * wrong theories about `0x54` and `0x55`.
 *
 * USBPcap captures the wire itself, below the MIDI layer, so a capture of Transfer doing one
 * project download contains **its requests**. That is the last unobserved half of this protocol —
 * and the only route to the write side, where `0x5a`, `0x5b` and `0x5c` acknowledge mutations whose
 * arguments nobody has seen.
 *
 * `docs/device-probing.md` rule 0a-prime says native first. This is what earns its turn *after*
 * that: the listing, `0x03`, `Query` and `DirList` have each been asked and each ruled out.
 *
 * ## What has to be undone
 *
 * A capture is not SysEx. It is three layers:
 *
 * 1. **pcapng** — a block file format. Section headers, interface descriptions, packet blocks.
 * 2. **USBPcap** — a pseudo-header on every packet: which bus, which device, which endpoint, which
 *    direction, and how many bytes of payload follow.
 * 3. **USB-MIDI** — the payload is a run of **4-byte event packets**, and a SysEx message is
 *    fragmented across as many of them as it takes.
 *
 * Only after all three does `capture.ts`, `api.ts` and `storage.ts` become useful again — and then
 * every tool we already have works on Transfer's traffic unchanged.
 *
 * ## Direction is the whole point
 *
 * Host→device and device→host are separated and kept apart. A capture that merged them would be
 * exactly as useless as the Web MIDI captures we already have: it is *the requests* that are new.
 */

export class CaptureFormatError extends Error {}

/** One USB transfer, reduced to what a MIDI reader needs. */
export interface UsbPacket {
  /** True when the instrument sent it; false when the host did. */
  fromDevice: boolean;
  bus: number;
  device: number;
  /** Endpoint address including the direction bit. */
  endpoint: number;
  /** 0 isochronous, 1 interrupt, 2 control, 3 bulk. USB-MIDI is bulk. */
  transfer: number;
  data: Uint8Array;
}

const LINKTYPE_USBPCAP = 249;

// pcapng block types, from the specification.
const SECTION_HEADER = 0x0a0d0d0a;
const INTERFACE_DESCRIPTION = 0x00000001;
const SIMPLE_PACKET = 0x00000003;
const ENHANCED_PACKET = 0x00000006;

/** Byte-order magic in a section header. Read big-endian, a little-endian file gives this. */
const BYTE_ORDER_MAGIC = 0x1a2b3c4d;

/**
 * Pull the USB packets out of a `.pcapng`.
 *
 * Only `LINKTYPE_USBPCAP` interfaces are read. A capture taken on the wrong interface — an Ethernet
 * one, say — is **refused rather than skipped**, because "0 packets" and "you captured the wrong
 * thing" look identical otherwise, and that is a mistake worth twenty minutes of a person's evening.
 */
export function parsePcapng(file: Uint8Array): UsbPacket[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const packets: UsbPacket[] = [];
  /** Link type per interface, in declaration order — an EPB refers to interfaces by that index. */
  const linkTypes: number[] = [];
  let little = true;
  let at = 0;
  let sawSection = false;

  while (at + 8 <= file.length) {
    const type = view.getUint32(at, little);
    // A section header is self-describing: its magic tells us the byte order of everything after.
    if (type === SECTION_HEADER || (!sawSection && view.getUint32(at, false) === SECTION_HEADER)) {
      little = view.getUint32(at + 8, true) === BYTE_ORDER_MAGIC;
      sawSection = true;
    } else if (!sawSection) {
      throw new CaptureFormatError(
        "this does not start with a pcapng section header — if Wireshark saved it as .pcap " +
          "(the older format) re-save it as pcapng, which is the default",
      );
    }

    const length = view.getUint32(at + 4, little);
    if (length < 12 || at + length > file.length) {
      // A capture stopped mid-write ends here. Everything before it is still good, and saying so
      // beats refusing the whole file.
      break;
    }

    if (type === INTERFACE_DESCRIPTION) linkTypes.push(view.getUint16(at + 8, little));
    else if (type === ENHANCED_PACKET) {
      const interfaceId = view.getUint32(at + 8, little);
      const captured = view.getUint32(at + 20, little);
      if (linkTypes[interfaceId] === LINKTYPE_USBPCAP) {
        const packet = readUsbPcap(file.subarray(at + 28, at + 28 + captured), little);
        if (packet) packets.push(packet);
      }
    } else if (type === SIMPLE_PACKET) {
      const captured = length - 16;
      if (linkTypes[0] === LINKTYPE_USBPCAP) {
        const packet = readUsbPcap(file.subarray(at + 12, at + 12 + captured), little);
        if (packet) packets.push(packet);
      }
    }

    at += length;
  }

  if (linkTypes.length > 0 && !linkTypes.includes(LINKTYPE_USBPCAP)) {
    throw new CaptureFormatError(
      `no USB interface in this capture — it holds link type(s) ${[...new Set(linkTypes)].join(", ")}, ` +
        `not ${LINKTYPE_USBPCAP} (USBPcap). Capture on the USBPcap interface for the hub the ` +
        `instrument is plugged into.`,
    );
  }
  return packets;
}

/**
 * The USBPcap pseudo-header.
 *
 * ```
 *  0  u16  headerLen     — where the payload starts; control transfers add fields
 *  2  u64  irpId
 * 10  u32  status
 * 14  u16  function
 * 16  u8   info          — bit 0 set means device → host
 * 17  u16  bus
 * 19  u16  device
 * 21  u8   endpoint      — bit 7 set means IN
 * 22  u8   transfer      — 0 iso, 1 interrupt, 2 control, 3 bulk
 * 23  u32  dataLength
 * ```
 *
 * `headerLen` is honoured rather than assumed to be 27, because control transfers carry a longer
 * one. Reading the payload at a fixed offset works until the first control transfer and then
 * silently yields eight bytes of header as if they were MIDI.
 */
function readUsbPcap(packet: Uint8Array, little: boolean): UsbPacket | undefined {
  if (packet.length < 27) return undefined;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const headerLen = view.getUint16(0, little);
  const dataLength = view.getUint32(23, little);
  if (headerLen > packet.length) return undefined;

  const data = packet.subarray(headerLen, headerLen + Math.min(dataLength, packet.length - headerLen));
  if (data.length === 0) return undefined;

  const info = packet[16]!;
  const endpoint = packet[21]!;
  return {
    // Two independent statements of the same fact. `info` bit 0 is USBPcap's own PDO→FDO flag and
    // the endpoint's bit 7 is USB's IN flag; either alone is enough, and taking both means a
    // capture where they disagree is read as device traffic rather than silently as a request.
    fromDevice: (info & 0x01) !== 0 || (endpoint & 0x80) !== 0,
    bus: view.getUint16(17, little),
    device: view.getUint16(19, little),
    endpoint,
    transfer: packet[22]!,
    data,
  };
}

/** SysEx reassembled from a capture, split by who sent it. */
export interface UsbMidiTraffic {
  /** **The half no capture of ours has ever contained.** */
  toDevice: Uint8Array[];
  fromDevice: Uint8Array[];
  /** Event packets whose code index number is not a SysEx one — notes, clock, whatever else. */
  otherEvents: number;
  /** Bytes left in a SysEx that never reached its `F7`. */
  danglingBytes: number;
}

/**
 * Undo USB-MIDI framing and put the SysEx back together.
 *
 * Every event packet is four bytes: a header byte carrying `cable << 4 | CIN`, then up to three
 * MIDI bytes. The **code index number** says how many of those three count and whether the message
 * ends here:
 *
 * | CIN | Meaning |
 * |---|---|
 * | `0x4` | SysEx starts or continues — all three bytes |
 * | `0x5` | SysEx ends with one byte (also single-byte system common) |
 * | `0x6` | SysEx ends with two bytes |
 * | `0x7` | SysEx ends with three bytes |
 *
 * A 2.7 MB project read is hundreds of thousands of these, so the accumulation is per direction and
 * per cable, and nothing is copied until a message completes.
 */
export function reassembleUsbMidi(packets: readonly UsbPacket[]): UsbMidiTraffic {
  const toDevice: Uint8Array[] = [];
  const fromDevice: Uint8Array[] = [];
  /** Partial SysEx per `direction:cable`, since two cables can interleave on one endpoint. */
  const building = new Map<string, number[]>();
  let otherEvents = 0;

  for (const packet of packets) {
    // Bulk and interrupt only. A control transfer is enumeration, not music, and feeding its setup
    // bytes to a MIDI parser produces confident nonsense.
    if (packet.transfer !== 3 && packet.transfer !== 1) continue;
    const out = packet.fromDevice ? fromDevice : toDevice;

    for (let i = 0; i + 4 <= packet.data.length; i += 4) {
      const header = packet.data[i]!;
      const cin = header & 0x0f;
      const key = `${packet.fromDevice ? "d" : "h"}:${header >> 4}`;

      const take = SYSEX_BYTES[cin];
      if (take === undefined) {
        // A wholly empty event packet is padding, not traffic: USB-MIDI pads a transfer up to its
        // packet size with zeroes, and counting those as "other events" would report tens of
        // thousands of messages that were never sent.
        if (header !== 0 || packet.data[i + 1] !== 0) otherEvents++;
        continue;
      }

      let message = building.get(key);

      // **`0x5` means two different things**, and only context separates them: "SysEx ends with one
      // byte" *and* "single-byte system common". With no SysEx in progress it is the latter — an
      // `F6` tune request, say — and treating it as a terminator would emit a one-byte message that
      // was never sent. `0xF` (single byte, the clock this capture is full of) is unambiguous and
      // never reaches here.
      if (message === undefined && cin === 0x5) {
        otherEvents++;
        continue;
      }

      if (!message) {
        message = [];
        building.set(key, message);
      }
      for (let b = 1; b <= take; b++) message.push(packet.data[i + b]!);

      // CIN 0x4 continues; everything else in the table ends the message.
      if (cin !== 0x4) {
        out.push(Uint8Array.from(message));
        building.delete(key);
      }
    }
  }

  let danglingBytes = 0;
  for (const partial of building.values()) danglingBytes += partial.length;

  return { toDevice, fromDevice, otherEvents, danglingBytes };
}

/** How many of an event packet's three data bytes belong to a SysEx, by code index number. */
const SYSEX_BYTES: Readonly<Record<number, number>> = { 0x4: 3, 0x5: 1, 0x6: 2, 0x7: 3 };

/** Concatenate messages into the `.syx` form every other tool here already reads. */
export function toSyx(messages: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const m of messages) total += m.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const m of messages) {
    out.set(m, at);
    at += m.length;
  }
  return out;
}
