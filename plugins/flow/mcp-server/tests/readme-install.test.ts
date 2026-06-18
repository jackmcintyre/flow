/**
 * Story 1.10 — README rewrite: AC3 (command-literal allowlist) + AC4
 * (Markdown-validity + internal-link integrity) for
 * `plugins/flow/docs/README-install.md`.
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface AC
 * convention this story is the first non-self-referential consumer of.
 *
 * - AC3: every slash-command literal that appears inside a fenced code
 *   block tagged ```bash``` or ```text``` in the README must be on the
 *   operator-verified allowlist below. The allowlist is explicit (NOT
 *   generated from the README) — the smoke gate in ship-story pins each
 *   literal to a `user_surface_verified` event ID in the story run log
 *   before PR open. A literal in the README that's missing from the
 *   allowlist OR an allowlist entry missing from the README both fail
 *   the test, with distinct diagnostics.
 *
 * - AC4 part 1: README parses as valid Markdown via remark-parse. A
 *   single parse failure fails the test.
 *
 * - AC4 part 2: every relative link in the parsed AST resolves to a
 *   file on disk (or, for in-document anchors, to an existing heading
 *   slug). External links (with a scheme) are skipped — out of scope.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/ -> mcp-server -> flow -> plugins -> repo root
const REPO_ROOT = resolve(HERE, "../../../..");
const README_PATH = resolve(REPO_ROOT, "plugins/flow/docs/README-install.md");
const README_DIR = dirname(README_PATH);

/**
 * Operator-verified slash-command allowlist for the README.
 *
 * The smoke step in ship-story (Story 1.8 gate) runs each of these
 * literals verbatim in a real Claude Code session and records a
 * `user_surface_verified` event with the observed UI/toast/output.
 * If the smoke step finds that a different literal works (e.g.
 * `/plugin marketplace add .` instead of `./`), this allowlist AND
 * the README copy must be updated in the same change.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  "/plugin marketplace add ./",
  "/plugin install flow@flow",
  "/reload-plugins",
  "/flow:dashboard",
]);

interface CodeNode {
  type: "code";
  lang?: string | null;
  value: string;
  position?: { start: { line: number } };
}

interface LinkNode {
  type: "link";
  url: string;
  children: Array<{ type: string; value?: string }>;
  position?: { start: { line: number } };
}

interface HeadingNode {
  type: "heading";
  depth: number;
  children: Array<{ type: string; value?: string }>;
}

type AnyNode =
  | CodeNode
  | LinkNode
  | HeadingNode
  | { type: string; children?: AnyNode[] };

function walk(node: AnyNode, visitor: (n: AnyNode) => void): void {
  visitor(node);
  const children = (node as { children?: AnyNode[] }).children;
  if (Array.isArray(children)) {
    for (const c of children) walk(c, visitor);
  }
}

function slugify(text: string): string {
  // Standard GitHub-flavoured heading-slug: lowercase, strip non-alphanum
  // (keep dashes), collapse whitespace to single dashes.
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function headingText(h: HeadingNode): string {
  return h.children
    .map((c) => (typeof c.value === "string" ? c.value : ""))
    .join("");
}

describe("README-install.md user-surface contract (Story 1.10)", () => {
  const raw = readFileSync(README_PATH, "utf8");
  const tree = unified().use(remarkParse).parse(raw) as unknown as AnyNode;

  const codeBlocks: CodeNode[] = [];
  const links: LinkNode[] = [];
  const headingSlugs = new Set<string>();
  walk(tree, (n) => {
    if (n.type === "code") codeBlocks.push(n as CodeNode);
    else if (n.type === "link") links.push(n as LinkNode);
    else if (n.type === "heading") {
      headingSlugs.add(slugify(headingText(n as HeadingNode)));
    }
  });

  describe("AC4 — Markdown parses", () => {
    it("README-install.md parses without errors via remark-parse", () => {
      // `unified().parse(...)` throws on hard parse failure; reaching this
      // point with a populated AST is the assertion.
      expect(tree).toBeTruthy();
      expect((tree as { type: string }).type).toBe("root");
      expect(
        (tree as { children?: unknown[] }).children?.length ?? 0,
      ).toBeGreaterThan(0);
    });
  });

  describe("AC3 — every slash-command literal is on the operator-verified allowlist", () => {
    // Build a map of found-literal -> first fenced block (line + lang) it
    // appeared in, scanning only ```bash``` and ```text``` blocks.
    const SLASH_LITERAL_RE = /^\s*(\/[a-z][\w:-]*(?:[^\n]*)?)\s*$/;
    const found = new Map<string, { lang: string; line: number }>();

    for (const block of codeBlocks) {
      const lang = (block.lang ?? "").toLowerCase();
      if (lang !== "bash" && lang !== "text") continue;
      const line = block.position?.start.line ?? 0;
      for (const rawLine of block.value.split("\n")) {
        const m = rawLine.match(SLASH_LITERAL_RE);
        if (!m) continue;
        const literal = m[1].trim();
        if (!found.has(literal)) {
          found.set(literal, { lang, line });
        }
      }
    }

    it("every literal found in bash/text fenced blocks is on the allowlist", () => {
      const unexpected: string[] = [];
      for (const [literal, where] of found) {
        if (!ALLOWLIST.has(literal)) {
          unexpected.push(
            `  - "${literal}" (in ${where.lang} block starting at line ${where.line})`,
          );
        }
      }
      expect(
        unexpected,
        unexpected.length === 0
          ? ""
          : `Slash-command literals in the README that are NOT on the operator-verified allowlist:\n${unexpected.join(
              "\n",
            )}\n\nAllowlist (operator-verified via Story 1.8 smoke gate):\n${[...ALLOWLIST].map((s) => `  - "${s}"`).join("\n")}\n\nIf the literal is correct, add it to ALLOWLIST in tests/readme-install.test.ts AND ensure a user_surface_verified event records the operator running it.`,
      ).toEqual([]);
    });

    it("every allowlist entry actually appears in the README", () => {
      const missing: string[] = [];
      for (const literal of ALLOWLIST) {
        if (!found.has(literal)) {
          missing.push(`  - "${literal}"`);
        }
      }
      expect(
        missing,
        missing.length === 0
          ? ""
          : `Allowlist entries missing from the README — silent removal of a documented command would be a user-surface regression:\n${missing.join(
              "\n",
            )}`,
      ).toEqual([]);
    });
  });

  describe("AC1 — Expected-confirmation blocks reference real UI surfaces (observed Claude Code 2.1.145)", () => {
    // For the slash-command steps (3a, 3b, 4, 6), the README must describe
    // the actual single-line toast text Claude Code 2.1.145 emits, rather
    // than the earlier (incorrect) "TUI panel" framing. We check that the
    // verbatim toast / error substrings appear in the README body.
    const REQUIRED_UI_SUBSTRINGS: ReadonlyArray<{
      ac: string;
      needle: string;
    }> = [
      // Step 3a — single-line toast
      {
        ac: "step 3a shows the verbatim marketplace-added toast",
        needle: "Successfully added marketplace",
      },
      // Step 3b — single-line install toast pointing at /reload-plugins
      {
        ac: "step 3b shows the verbatim installed toast",
        needle: "✓ Installed flow",
      },
      {
        ac: "step 3b surfaces the next-step pointer to /reload-plugins",
        needle: "Run /reload-plugins to apply",
      },
      // Step 4 — /reload-plugins is the apply step (no restart needed)
      {
        ac: "step 4 shows the verbatim reload toast prefix",
        needle: "Reloaded:",
      },
      {
        ac: "step 4 explicitly states no Claude Code restart is required",
        needle: "no Claude Code restart is required",
      },
      // Step 6 — known-limitation error (Story 3.3 parks the adapter detect)
      {
        ac: "step 6 documents the verbatim parked-adapter error toast",
        needle: "bmad adapter: detect lands in Story 3.3",
      },
      {
        ac: "step 6 points at Story 3.3 as the lift",
        needle: "Story 3.3",
      },
    ];

    for (const { ac, needle } of REQUIRED_UI_SUBSTRINGS) {
      it(`README contains the user-surface phrase for: ${ac}`, () => {
        expect(
          raw.includes(needle),
          `Expected README to contain "${needle}" — this anchors the user-surface description for ${ac}.`,
        ).toBe(true);
      });
    }
  });

  describe("AC2 — README content matches observed Claude Code 2.1.145 reality", () => {
    // Step 3a — single-line toast after `/plugin marketplace add ./`
    it("step 3a covers the marketplace-added toast after /plugin marketplace add ./", () => {
      expect(raw).toMatch(/\/plugin marketplace add \.\//);
      expect(raw).toMatch(/Successfully added marketplace: flow/);
    });

    // Step 3b — single-line install toast pointing at /reload-plugins
    it("step 3b covers /plugin install flow@flow and the /reload-plugins pointer", () => {
      expect(raw).toMatch(/\/plugin install flow@flow/);
      expect(raw).toMatch(/✓ Installed flow/);
      expect(raw).toMatch(/Run \/reload-plugins to apply/);
    });

    // Step 4 — /reload-plugins is the apply step, no restart needed
    it("step 4 covers /reload-plugins as the apply step with no restart required", () => {
      expect(raw).toMatch(/\/reload-plugins/);
      expect(raw).toMatch(/Reloaded:/);
      expect(raw).toMatch(/plugin MCP servers/);
      expect(raw).toMatch(/no Claude Code restart is required/);
    });

    // Step 6 — known-limitation error (Story 3.3 parked the adapter detect)
    it("step 6 documents the parked-adapter known limitation and points at Story 3.3", () => {
      expect(raw).toMatch(/\/flow:dashboard/);
      expect(raw).toMatch(/bmad adapter: detect lands in Story 3\.3/);
      expect(raw).toMatch(/Story 3\.3/);
    });
  });

  describe("AC4 — internal links resolve", () => {
    it("every relative link (file or in-doc anchor) resolves on disk", () => {
      const broken: string[] = [];
      for (const link of links) {
        const url = link.url;
        if (!url) continue;
        // Skip external links (any scheme like http:, https:, mailto:)
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;

        // In-document anchor
        if (url.startsWith("#")) {
          const slug = url.slice(1);
          if (!headingSlugs.has(slug)) {
            const text = link.children
              .map((c) => (typeof c.value === "string" ? c.value : ""))
              .join("");
            const line = link.position?.start.line ?? 0;
            broken.push(
              `  - in-doc anchor "${url}" (link text "${text}", line ${line}) — no matching heading slug`,
            );
          }
          continue;
        }

        // Strip any trailing anchor / query
        const [pathPart] = url.split("#");
        const [filePart] = pathPart.split("?");
        if (!filePart) continue;

        const target = isAbsolute(filePart)
          ? resolve(REPO_ROOT, "." + filePart)
          : resolve(README_DIR, filePart);

        if (!existsSync(target)) {
          const text = link.children
            .map((c) => (typeof c.value === "string" ? c.value : ""))
            .join("");
          const line = link.position?.start.line ?? 0;
          broken.push(
            `  - "${url}" (link text "${text}", line ${line}) — resolved to ${target} which does not exist`,
          );
        }
      }
      expect(
        broken,
        broken.length === 0
          ? ""
          : `Broken internal links in README-install.md:\n${broken.join("\n")}`,
      ).toEqual([]);
    });
  });
});
