/**
 * Unit tests for AC-heading regex widening (Story 5.17 AC1).
 *
 * Covers the four canonical AC heading shapes (strict, tagged, descriptive,
 * descriptive+tagged) plus regressions for (user-surface) tag mapping and
 * a real-world punctuation example, plus a negative case pinning the
 * intentional strictness around the em-dash separator.
 *
 * The em-dash used throughout is U+2014 (`—`), NOT a hyphen-minus (U+002D),
 * en-dash (U+2013), or double-hyphen.
 */
export {};
