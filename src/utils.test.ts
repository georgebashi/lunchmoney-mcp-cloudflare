import { describe, it, expect } from "vitest";
import { htmlEscape, cspWithNonce, newNonce, secretsMatch } from "./utils.js";

describe("htmlEscape", () => {
    it("escapes &", () => expect(htmlEscape("a&b")).toBe("a&amp;b"));
    it("escapes <", () => expect(htmlEscape("<div>")).toBe("&lt;div&gt;"));
    it("escapes >", () => expect(htmlEscape("x>y")).toBe("x&gt;y"));
    it('escapes "', () => expect(htmlEscape('say "hi"')).toBe("say &quot;hi&quot;"));
    it("escapes '", () => expect(htmlEscape("it's")).toBe("it&#39;s"));
    it("leaves safe strings unchanged", () =>
        expect(htmlEscape("hello world")).toBe("hello world"));
    it("escapes multiple special chars", () =>
        expect(htmlEscape(`<b>"a"&'b'</b>`)).toBe("&lt;b&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/b&gt;"));
    it("returns empty string unchanged", () => expect(htmlEscape("")).toBe(""));
    it("handles a string of only special chars", () =>
        expect(htmlEscape("&&&")).toBe("&amp;&amp;&amp;"));
});

describe("cspWithNonce", () => {
    it("includes the nonce in script-src", () =>
        expect(cspWithNonce("abc123")).toContain("'nonce-abc123'"));
    it("includes default-src 'none'", () =>
        expect(cspWithNonce("x")).toContain("default-src 'none'"));
    it("returns the full policy string", () =>
        expect(cspWithNonce("n")).toBe(
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-n'; form-action 'self'; base-uri 'none'; frame-ancestors 'none';"
        ));
});

describe("newNonce", () => {
    it("returns 32 hex chars (128 bits)", () =>
        expect(newNonce()).toMatch(/^[0-9a-f]{32}$/));
    it("does not repeat", () =>
        expect(newNonce()).not.toBe(newNonce()));
});

describe("secretsMatch", () => {
    it("matches identical strings", async () =>
        expect(await secretsMatch("s3cret", "s3cret")).toBe(true));
    it("rejects a different value of the same length", async () =>
        expect(await secretsMatch("s3cret", "s3creT")).toBe(false));
    it("rejects a prefix of the real secret", async () =>
        expect(await secretsMatch("s3cre", "s3cret")).toBe(false));
    it("rejects the empty string against a real secret", async () =>
        expect(await secretsMatch("", "s3cret")).toBe(false));
    it("matches two empty strings", async () =>
        expect(await secretsMatch("", "")).toBe(true));
    it("handles non-ASCII without throwing", async () =>
        expect(await secretsMatch("pÄssword—✓", "pÄssword—✓")).toBe(true));
});
