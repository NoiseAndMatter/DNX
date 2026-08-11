/**
 * The +Drive library: the presets and kits an instrument holds, independent of any project.
 *
 * ## Two collections, one shape
 *
 * The manual's data structure has three things on the +Drive — projects, presets and kits — and the
 * last two are the *library*, available to every project:
 *
 * | | path | banks | per bank | total |
 * |---|---|---|---|---|
 * | presets | `/soundbanks/<bank>` | A–H | 256 | **2,048** |
 * | kits | `/kits/<bank>` | A–H | 128 | **1,024** |
 *
 * Both list identically, so they get one function and a `LibraryKind` rather than two nearly-equal
 * ones. `listProjects` stays separate: a project is not library material — it is the thing a library
 * is loaded *into* — and giving all three one function would suggest an interchangeability the
 * device does not have.
 *
 * ## What the listing tells you, and what it does not
 *
 * The size is the object's, not the file's: **every** kit slot lists 10,752 whether it holds a kit
 * or not, and a preset slot lists 302 either way. Occupancy comes from the name and the permission
 * mask, never from the size — a mistake this project has made once already and recorded.
 *
 * A stored file is that object wrapped in the ordinary container: 31-byte header, body, 12-byte
 * trailer. So reading one and taking `payload` gives bytes that drop straight into a pool slot or a
 * pattern's kit record.
 *
 * ## The 302 above came off a **Digitone 1**, and no preset bank has been listed on a DN2
 *
 * 302 is the DN1's sound-object size; the DN2's is 359. Every `/soundbanks` listing this project
 * has taken, and the one preset it has read off a drive, came from a Digitone 1 — that file
 * declares container kind 9 and format `"0097"`, which is the DN1 project signature. The kit
 * figures, by contrast, were measured on a DN2.
 *
 * So **what a Digitone II's own preset library holds is genuinely unknown**: 359 if it stores its
 * native sound, 302 if the +Drive preset format is shared across the family. One `List` of
 * `/soundbanks/A` on a DN2 settles it and nothing else does.
 *
 * Nothing here depends on the answer — `readLibraryObject` returns whatever length the file
 * declares, and `librarian/poolwrite.ts` fits either into a pool, converting a DN1 preset on the
 * way into a DN2 project. The point of writing it down is that the number is *assumed*, and a
 * reader who found `302` beside a DN2 heading would have no way to tell.
 */

import { type ApiTransport, readStoredFile } from "./storagesession.js";
import { parsePayload } from "../project/container.js";
import { type Entry, StorageCode, listRequest, parseListing } from "./storage.js";
import { type ApiFrame, RESPONSE_BIT } from "./api.js";

/** The two library collections, named the way the manual names them. */
export type LibraryKind = "preset" | "kit";

/** Bank letters. Both collections use `A`–`H`; a kit bank also answers to its index. */
export const BANKS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

export const LIBRARY_ROOT: Record<LibraryKind, string> = {
  preset: "/soundbanks",
  kit: "/kits",
};

/** How many slots a bank of each kind holds — observed on hardware, not assumed. */
export const BANK_SIZE: Record<LibraryKind, number> = {
  preset: 256,
  kit: 128,
};

export interface LibraryEntry {
  /** 1-based, and the thing a path addresses: `/kits/A/1`. */
  index: number;
  name: string;
  /** True when a preset or kit is actually saved here. */
  occupied: boolean;
  /**
   * False for a slot the device protects.
   *
   * An occupied kit slot reads as not writable — the instrument marks saved work — so this is not
   * simply the inverse of `occupied` and must not be treated as one.
   */
  writable: boolean;
  /** The object's size, constant across a collection. Not the stored file's length. */
  size: number;
}

export interface LibraryBank {
  kind: LibraryKind;
  bank: string;
  path: string;
  entries: LibraryEntry[];
  /** Occupied entries, which is what a browser wants to show first. */
  used: number;
}

export interface ListLibraryOptions {
  msgId?: number;
  timeoutMs?: number;
}

/** The path of one bank. */
export function bankPath(kind: LibraryKind, bank: string): string {
  return `${LIBRARY_ROOT[kind]}/${bank}`;
}

/** The path of one slot, which is what `readStoredFile` takes. */
export function slotPath(kind: LibraryKind, bank: string, index: number): string {
  return `${bankPath(kind, bank)}/${index}`;
}

/**
 * List one bank.
 *
 * Asks for the whole directory rather than paging, as `listProjects` does and for the same reason:
 * a bare path returns every entry, and paging is for callers who want a window.
 */
export async function listLibraryBank(
  transport: ApiTransport,
  kind: LibraryKind,
  bank: string,
  options: ListLibraryOptions = {},
): Promise<LibraryBank> {
  const msgId = options.msgId ?? 1;
  const path = bankPath(kind, bank);
  const reply = expectList(
    await transport.request(listRequest(msgId, path), msgId, options.timeoutMs ?? 5_000),
  );

  const entries = parseListing(reply.body)
    .entries
    .filter((e) => e.kind === "file")
    .map(toLibraryEntry)
    .sort((a, b) => a.index - b.index);

  return { kind, bank, path, entries, used: entries.filter((e) => e.occupied).length };
}

function toLibraryEntry(entry: Entry): LibraryEntry {
  return {
    index: entry.index,
    name: entry.name,
    occupied: entry.occupied ?? false,
    writable: entry.writable ?? false,
    size: entry.size ?? 0,
  };
}

function expectList(frame: ApiFrame): ApiFrame {
  const wanted = StorageCode.List | RESPONSE_BIT;
  if (frame.code !== wanted) {
    throw new Error(
      `expected 0x${wanted.toString(16)} to a listing and got 0x${frame.code.toString(16)}`,
    );
  }
  return frame;
}

/**
 * A one-line summary of a bank, for a browser's bank strip.
 *
 * The count is what makes a bank worth clicking — the same reasoning the pattern grid's bank tabs
 * are built on. An empty bank shows nothing rather than a zero, because a row of zeroes is noise.
 */
export function describeBank(bank: LibraryBank): string {
  return bank.used === 0
    ? `${bank.bank} — empty`
    : `${bank.bank} — ${bank.used} of ${bank.entries.length}`;
}

/**
 * Read one library object and hand back the part a project holds.
 *
 * A stored file is the object inside the ordinary container — 31-byte header, body, 12-byte
 * trailer — and **the body is byte-for-byte what sits in a pool slot or a pattern's kit record of
 * the same family**. So the unwrapping happens once, here, and callers never see a file length
 * where they expect an object length. That distinction has already cost this project one bug: 302
 * against 345 looked like a mystery until the container was recognised.
 *
 * **The length is reported, not asserted.** It is the caller's business whether a 302-byte body
 * belongs where it is going — see the note at the top of this file about which device that 302 was
 * measured on, and `librarian/poolwrite.ts` for what happens when the families differ.
 */
export async function readLibraryObject(
  transport: ApiTransport,
  kind: LibraryKind,
  bank: string,
  index: number,
  options: ListLibraryOptions = {},
): Promise<{ body: Uint8Array; declared: number; fileBytes: number }> {
  const path = slotPath(kind, bank, index);
  const file = await readStoredFile(path, {
    transport,
    ...(options.msgId === undefined ? {} : { msgId: options.msgId }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const payload = parsePayload(file.bytes);
  const body = file.bytes.subarray(HEADER_SIZE, HEADER_SIZE + payload.storedLength);
  // Checked rather than assumed: the declared length and what is actually there are two
  // independent statements, and a short body written into a slot would corrupt its neighbour.
  if (body.length !== payload.storedLength) {
    throw new Error(
      `${path} declares ${payload.storedLength} bytes of object and carries ${body.length}`,
    );
  }
  return { body, declared: payload.storedLength, fileBytes: file.bytes.length };
}

/** Where the container header ends and the object begins. */
const HEADER_SIZE = 31;