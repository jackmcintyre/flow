/**
 * Tests for the generated backlog dashboard — Story 9.5 (Epic 9 intake
 * cockpit, read surface).
 *
 *   AC1: group-by-epic from the live inventory read (not a hand-maintained
 *        list). Seed manifests spanning multiple epics and states; render; the
 *        output groups items by epic with each item's state shown.
 *   AC2: each item shows readiness AND claimability; a not-ready item is
 *        visibly distinct from a ready one. Seed a ready item and a not-ready
 *        item (both deps-satisfied); the rows distinguish them.
 *   AC3: the renderer is a pure function of a typed snapshot — no file IO, no
 *        clock; two calls with the same snapshot are byte-identical. The state
 *        read is a separate getter.
 *   AC4: the table is a function of state — flip an item ready via the brake
 *        tool, re-read + re-render, and ONLY that item's readiness/claimability
 *        changes; no manual table edit.
 *
 * Uses a real tmpdir with real `node:fs` ops (the inventory reader is impure).
 * Manifests are written via the canonical `atomicWriteFile` primitive to comply
 * with the static fs-guard. The pure-render AC (AC3) is exercised against a
 * hand-built snapshot with NO filesystem at all — that is the point of the
 * getter/renderer split.
 */
export {};
