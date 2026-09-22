# `@noiseandmatter/dnx-core`

The part of [DNX](../../README.md) that is not a web page: Elektron Digitone 1 and Digitone II
project formats, the codecs, the +Drive and dump protocols, the expansion and librarian
operations, the analysis model, and the write safeguards.

It is here rather than in a repository of its own so that the format knowledge and the tests that
prove it against a corpus of real projects stay beside each other, and so a change to the core and
to DNX lands in one pull request. A separate repository is the right move later, if this grows
consumers with their own release rhythm.

## The rule it keeps

**Platform-free.** No DOM, no Node, no filesystem, no `node:` imports, and no module-level mutable
state outside a shrinking allowlist. The only host globals it may use are the handful declared in
[`types/core-host.d.ts`](../../types/core-host.d.ts) — `TextDecoder`, `TextEncoder`, `setTimeout`,
`clearTimeout`, `atob` — which a browser, Node and Android's JavaScript hosts all provide.

It also reads no clock and no randomness it was not handed. Where an output is not a function of
its inputs — a new project's identity, a backup's timestamp — the source is a parameter or an
option with a default, never a reach for a global.

Three things enforce this, and none of them is a convention:

- `tsconfig.core.json` compiles this package with the ES library alone. No DOM, no `@types/node`.
- `test/layers.test.ts` reads the import graph and fails on anything reaching out of the package.
- `test/determinism.test.ts` fails on a clock or a dice roll that is not a seam's default.

## How it talks to an instrument

Through an injected transport, never a global. The seam is one small interface a host implements:

```ts
interface SysexPort {
  send(bytes: Uint8Array): void;
  subscribe(listener: (bytes: Uint8Array) => void): () => void;
  close(): void;
}
```

The core builds the message-id correlation, the `+Drive` session and the dump reader on top of it,
so a second host never re-implements reply matching. That matching has produced a false finding
before, which is why it is not something a host is asked to get right.

Writes take a `gate` as a **required** option for the same reason: the switch that arms writing is
the host's, the core cannot know what one looks like, and an optional gate is one a host forgets
with no symptom at all.

## Not published yet

`private: true`, deliberately. The `exports` map points at TypeScript sources, which is what DNX
and its tests consume directly; publishing needs a build step emitting JavaScript and declarations,
and that step does not exist. A `package.json` that claims to be installable and is not is worse
than one that says it is not ready.

Licence: AGPL-3.0-or-later, like DNX.
