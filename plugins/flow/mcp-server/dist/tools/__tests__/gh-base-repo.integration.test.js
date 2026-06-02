import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
// Probe once at module load. Skip-if returns true when gh is unavailable or unauthed.
const SKIP_REASON = (() => {
    try {
        execSync("gh auth status", { stdio: "pipe" });
        return null;
    }
    catch {
        return "gh not on PATH or not authenticated";
    }
})();
describe("gh repo view --json owner,name (real-host integration)", () => {
    it.skipIf(SKIP_REASON !== null)("returns { name: string; owner: { login: string } } shape", () => {
        const stdout = execSync("gh repo view --json owner,name", {
            encoding: "utf-8",
        });
        const parsed = JSON.parse(stdout);
        expect(typeof parsed.name).toBe("string");
        expect(parsed.name.length).toBeGreaterThan(0);
        expect(typeof parsed.owner?.login).toBe("string");
        expect(parsed.owner.login.length).toBeGreaterThan(0);
    });
});
