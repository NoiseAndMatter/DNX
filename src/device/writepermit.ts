/**
 * The token that says a write went through the safe path.
 *
 * ## Why a token rather than a rule in a document
 *
 * `dumpwrite.ts` and `storagewrite.ts` are careful modules. Between them they refuse a wrong
 * length, a wrong slot, a wrong storage version, an occupied +Drive slot and an entry that never
 * came from a listing. What neither of them can check is the thing that actually protects someone's
 * work: **was a copy taken first, was the person told, and was the result read back**.
 *
 * Those are properties of a *sequence*, not of a message, so they cannot live where the message is
 * built. They live in `safewrite.ts`. And a sequence enforced only by convention is a sequence that
 * holds until somebody adds a fourth write path in a hurry — which is exactly how this codebase
 * ended up with two message-id allocators and four format facts written down twice.
 *
 * So the primitives ask for a permit, and only `safewrite.ts` can produce one.
 *
 * ## What this actually guarantees, stated honestly
 *
 * `brand` is `declare const`: it exists in the type system and never at runtime, and it is **not
 * exported**, so no other module can name it. That means no object literal, no `{}`, and no
 * structurally-similar value satisfies `WritePermit`. A new caller that reaches for
 * `writeChangedRecords` or `writeStoredFile` gets a compile error naming the field it cannot fill,
 * at the call site, in the editor.
 *
 * What it does not stop is `as unknown as WritePermit`. TypeScript has no way to stop that, and
 * pretending otherwise would be the same false confidence this module exists to replace. That is
 * the second layer's job: `test/safewrite.test.ts` scans the source tree and fails if any module
 * other than `safewrite.ts` imports a primitive that mutates an instrument. The permit stops the
 * accident; the test stops the shortcut.
 *
 * ## Precedent
 *
 * `storage.ts` already does this with `FREEZES`, for a request that froze a Digitone 1 three times.
 * The difference is deliberate: `FREEZES` is exported, because it means *"I have read the warning"*
 * and anyone may honestly say so. This one is not exported, because it means *"the backup, the
 * confirmation and the read-back all happened"* — and only the code that performed them can say
 * that truthfully.
 */

declare const brand: unique symbol;

/**
 * Proof that a write came through `safeWriteRecords` or `safeWriteFile`.
 *
 * Not constructible outside `safewrite.ts`. Passed down to the primitive rather than checked by it:
 * the primitive has no way to verify a backup happened, so the type is the whole check.
 */
export interface WritePermit {
  readonly [brand]: "safe-write";
}
