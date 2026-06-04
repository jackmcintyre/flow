/**
 * Integration tests for `buildPersonaSpawnPrompt` — briefing budget cap
 * Story native:01KT6QSW4W7SMAHAT4EAKCCC65 (AC1).
 *
 * Covers:
 *  (AC1-a) When lessons <= budget, all lessons appear in the always-shown index.
 *  (AC1-b) When lessons > budget, only the top-budgeted lessons appear in the index.
 *  (AC1-c) The always-shown index is ordered by use_count descending then last_used_at desc.
 *  (AC1-d) Overflow lessons are moved to the archived store (not in the persona file).
 *  (AC1-e) The persona file Knowledge body is updated (overflow removed) after assembly.
 */
export {};
