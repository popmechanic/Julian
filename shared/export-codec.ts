// shared/export-codec.ts — lossless JSON carriage for mergeable content (issue #48).
//
// A deleted cell/value in TinyBase's mergeable CRDT is a stamp whose value slot
// is `undefined`. JSON has no undefined: stringify collapses it to null inside
// arrays, and a restore via setMergeableContent then resurrects the deletion as
// a live-looking value. This codec carries undefined across the JSON boundary
// as an explicit marker so exports round-trip losslessly and a retraction stays
// verifiable in the artifact.
//
// The marker is '￼' (object replacement character) — the same convention
// TinyBase's own ws-synchronizer wire protocol uses for undefined, so the
// export format agrees with the substrate's native wire encoding. The known
// (and inherited) ambiguity: a cell whose entire value IS this lone character
// would be mangled — but such a cell cannot survive TinyBase's own sync either.
//
// decodeUndefined additionally maps null → undefined: no live cell or value can
// legitimately be null in mergeable content (cells are string|number|boolean),
// so a null can only be a pre-fix export's collapsed deletion. This keeps the
// sealed pre-August-26 archives restorable — and heals them of the phantom bug.

export const UNDEFINED_MARKER = '￼';

const walk = (node: unknown, replace: (leaf: unknown) => unknown): unknown => {
  if (Array.isArray(node)) return node.map((item) => walk(item, replace));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = walk(value, replace);
    }
    return out;
  }
  return replace(node);
};

/** Prepare mergeable content for JSON serialization: undefined → marker. */
export const encodeUndefined = (content: unknown): unknown =>
  walk(content, (leaf) => (leaf === undefined ? UNDEFINED_MARKER : leaf));

/** Reverse of encodeUndefined, applied after JSON.parse and before
 * setMergeableContent. Also accepts legacy (pre-fix) exports where the
 * deletion arrived as null. */
export const decodeUndefined = (content: unknown): unknown =>
  walk(content, (leaf) => (leaf === UNDEFINED_MARKER || leaf === null ? undefined : leaf));
