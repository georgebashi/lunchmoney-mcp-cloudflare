import { describe, it, expect } from "vitest";
import { runWithConfig, getConfig } from "@akutishevsky/lunchmoney-mcp/config";

// worker.ts binds the LunchMoney token per request with `runWithConfig` rather
// than the module-level `initializeConfig` singleton. These guard the property
// that makes that choice worth keeping: with no process-wide fallback in
// place, a token that escapes its scope fails loudly instead of leaking.
describe("per-request token scoping", () => {
    it("binds the token only inside the scope", () => {
        runWithConfig("scoped-only", () => {
            expect(getConfig().lunchmoneyApiToken).toBe("scoped-only");
        });
        expect(() => getConfig()).toThrow(/Configuration not initialized/);
    });

    it("keeps concurrent scopes separate", async () => {
        const observed: Array<[string, string]> = [];

        const request = (token: string, delayMs: number) =>
            runWithConfig(token, async () => {
                await new Promise((r) => setTimeout(r, delayMs));
                observed.push([token, getConfig().lunchmoneyApiToken]);
            });

        await Promise.all([request("tok-a", 20), request("tok-b", 5)]);

        for (const [expected, actual] of observed) {
            expect(actual).toBe(expected);
        }
        expect(observed).toHaveLength(2);
    });
});
