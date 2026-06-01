/**
 * `shortHandle` — a zero-dependency pure helper for producing human-friendly
 * story-ID display handles from full story refs.
 *
 * For a `native:<ULID>` ref the full source-id is a 26-character ULID which is
 * unreadable on operator surfaces. This helper returns only the first 8
 * characters of the ULID, which is unique enough for display.
 *
 * For any other ref (e.g. `bmad:8.18`) the local part (the substring after the
 * first `:`) is already concise and human-readable, so it is returned verbatim.
 *
 * Pure — no imports, no side-effects, no async.
 */
/**
 * Return a short human-friendly display handle for a story ref.
 *
 * - `native:<ULID>` → first 8 characters of the ULID (e.g. `"01KT1NR9"`)
 * - Any other ref  → the local part after the first `:` (e.g. `"8.18"`)
 *
 * @param ref - The full story ref (e.g. `"native:01KT1NR9F6133VHY601SF3BD5N"` or `"bmad:8.18"`).
 * @returns A non-empty short handle string.
 */
export function shortHandle(ref) {
    const colon = ref.indexOf(":");
    const localPart = colon === -1 ? ref : ref.slice(colon + 1);
    if (ref.startsWith("native:")) {
        return localPart.slice(0, 8);
    }
    return localPart;
}
