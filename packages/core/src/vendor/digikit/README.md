# digikit's sample client, vendored

These files are digikit's own host client for its card store. DNX does not keep a second
implementation. The owner wants one writer, shared with digikit.

- Source: ElekLabs/digikit, commit `11ad79ee`, `packages/dk-session/src/`.
- Licence: AGPL-3.0-or-later, the same as DNX.
- Files: `samples.ts`, `dksample.ts`, `dkupload-core.ts`, `rpcfiles.ts`, `gen_proto.ts`,
  `emu-usb-transport.ts`.
- One change: each relative import ends in `.js`, not `.ts`. DNX's web build emits JavaScript, and
  `tsc` does not rewrite the extension. A `sed` makes the change, and nothing else differs.

The converter is `dksample.wasm`. It is built from `packages/dksample` at the same commit:

```
cargo build --manifest-path packages/dksample/Cargo.toml --locked --offline --release --lib --target wasm32-unknown-unknown
```

To update, copy the files again from a newer commit, apply the same `sed`, and change the commit
here. Do not edit these files by hand. Fix a fault in digikit, then copy again.
