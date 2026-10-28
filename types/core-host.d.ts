/**
 * The host globals the platform-free core may use, and nothing else.
 *
 * `tsconfig.core.json` checks the core folders of `src/` with the ES library alone: no DOM and no
 * `@types/node`. Browsers, Node and Android's JavaScript hosts all provide what is declared here,
 * so core code that compiles against this file runs on each of them. A global missing from this
 * file is a global some host may not have; add one only after checking that every host does.
 *
 * Only the shapes core actually calls are declared, which keeps the file from growing into a copy
 * of the DOM library.
 */

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  readonly encoding: string;
  decode(input?: ArrayBufferView | ArrayBuffer, options?: { stream?: boolean }): string;
}

declare class TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}

type HostTimer = number | { readonly __hostTimer: unique symbol };

declare function setTimeout(handler: (...args: any[]) => void, timeout?: number): HostTimer;
declare function clearTimeout(id: HostTimer | undefined): void;
declare function atob(data: string): string;

/*
 * For digikit's vendored client (`vendor/digikit/`): the converter is WebAssembly, uploads and
 * VERIFY use SHA-256, and a reply wait can be cancelled. Browsers and Node 20 and later provide
 * all of these.
 */

type BufferSource = ArrayBufferView | ArrayBuffer;

declare namespace WebAssembly {
  class Memory {
    readonly buffer: ArrayBuffer;
  }
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  function instantiate(
    bytes: BufferSource,
    imports?: Record<string, unknown>,
  ): Promise<{ instance: Instance }>;
}

declare const crypto: {
  readonly subtle: { digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer> };
};

declare class AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}
