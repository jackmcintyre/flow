# Bloat gate (knip) — keeping dead code out

CI runs [`knip`](https://knip.dev) on every PR and push (`pnpm knip`, wired into
`.github/workflows/ci.yml`). The build **fails** if it finds:

- **Unused files** — a `.ts` under `src/` that nothing reachable imports.
- **Unused exports / types** — an exported symbol that is used *nowhere* (not in
  another module and not within its own file). Over-exports that are still used
  inside their own file are tolerated (`ignoreExportsUsedInFile: true`) — the
  goal is to catch genuinely-dead surface, not to force churn on internal helpers.
- **Unused / unlisted dependencies** — a `package.json` dep nothing imports, or
  an import with no declared dep.

Config lives in `plugins/flow/knip.json`. Real entrypoints that nothing imports
(the CLI, the MCP server `main`, the externally-invoked `workflows/*.workflow.js`
scripts) are declared as entries / ignored so they aren't false-flagged.

## What the gate CANNOT catch — review discipline required

knip is a **static** analyser. It sees the import graph, not the runtime call
graph. The blind spot that matters here:

> **Registered-but-uncalled MCP tools.** Every crew tool is wired into the server
> via `registerAllTools` in `src/tools/register.ts`. Because that registration
> *imports* the tool, knip considers the tool "used" — even if **no runtime path
> ever calls it**. Such a tool is dead code that the gate will happily pass.

This is exactly how `recordAgentInvoke` and `recordPrCloseAction` survived as dead
code for months: registered, type-checked, tested in isolation, but never invoked
by any drain/skill/gate path (the stories that were going to call them were mooted
by the stateless-workflow pivot). They were removed in the 2026-05-30 de-cruft pass.

**Reviewer checklist for any new tool / dynamically-dispatched code:**

1. Is there a *runtime* caller — a skill, a workflow, the auto-merge gate, the
   dev/reviewer session runners — that actually invokes this, or is it only
   registered + unit-tested? "Registered + tested" is **not** "used."
2. If it's intentionally ahead of its caller (forward-authored for a later epic),
   say so in a comment and treat it as a tracked debt, not as shipped capability.

If you must keep an export that is genuinely unused today but is an intentional
contract (e.g. a documented failure-mode error class), mark it with a `@public`
JSDoc tag — knip honours that and leaves it out of the gate. Use this sparingly
and always with a comment explaining why.
