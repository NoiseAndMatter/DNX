/**
 * The audio readers' error type, on its own so each reader can throw it.
 *
 * The readers serve two callers, the Waverider importer and the sample library, so their error
 * belongs to neither. A caller that wants its own type wraps this one.
 */
export class AudioError extends Error {}
