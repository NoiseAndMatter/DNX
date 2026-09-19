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
