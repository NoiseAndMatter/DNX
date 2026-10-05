/**
 * The Waverider store's error type, on its own so every module can throw it.
 *
 * A one-class module earns its place here by what it prevents: the superblock, the index, the
 * validation and the conversion all need to throw this, and putting it in any one of them makes
 * the other three import that one for a reason that has nothing to do with its job. That is how a
 * codec ends up depending on a validator.
 */
export class WaveriderError extends Error {}
