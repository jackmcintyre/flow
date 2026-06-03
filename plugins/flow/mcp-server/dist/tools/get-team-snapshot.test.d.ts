/**
 * Story native:01KT6Q8PSDZQKM57VFRHFJ3RP4 — structured lesson storage in
 * role PERSONA.md Knowledge sections.
 *
 * AC1 (integration): each lesson line shows its kind and source_ref in
 *   /flow:team — not just bare lesson text.
 *
 * AC2 (integration): pre-existing flat bullets are migrated to KnowledgeEntry
 *   with kind="pattern" and text intact — no lessons are lost.
 *
 * Both ACs exercise `extractKnowledgeEntries` and `renderTeamSnapshot` in
 * isolation (pure functions — no IO, no tmp dirs, no MCP transport).
 */
export {};
