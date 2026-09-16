import { describe, it, expect } from "vitest";
import { checkClientMetadata } from "./register-policy.js";

const ok = (uris: unknown) => checkClientMetadata({ redirect_uris: uris });

describe("checkClientMetadata", () => {
    it("accepts a single https redirect", () =>
        expect(ok(["https://claude.ai/api/mcp/auth_callback"])).toBeNull());

    it("accepts http on localhost", () =>
        expect(ok(["http://localhost:6274/callback"])).toBeNull());

    it("accepts http on 127.0.0.1", () =>
        expect(ok(["http://127.0.0.1:8976/cb"])).toBeNull());

    it("accepts http on [::1]", () =>
        expect(ok(["http://[::1]:8976/cb"])).toBeNull());

    it("rejects plain http on a public host", () =>
        expect(ok(["http://example.com/cb"])).toMatch(/must use https/));

    it("rejects non-http schemes", () =>
        expect(ok(["javascript:alert(1)"])).toMatch(/must use https/));

    it("rejects an https redirect to a bare IPv4 address", () =>
        expect(ok(["https://203.0.113.5/cb"])).toMatch(/IP literal/));

    it("rejects an https redirect to a bare IPv6 address", () =>
        expect(ok(["https://[2001:db8::1]/cb"])).toMatch(/IP literal/));

    it("rejects an unparseable redirect_uri", () =>
        expect(ok(["not a url"])).toMatch(/Invalid redirect_uri/));

    it("rejects a non-string redirect_uri", () =>
        expect(ok([42])).toMatch(/must be strings/));

    it("rejects missing redirect_uris", () =>
        expect(checkClientMetadata({})).toMatch(/missing or not an array/));

    it("rejects redirect_uris that is not an array", () =>
        expect(ok("https://claude.ai/cb")).toMatch(/missing or not an array/));

    it("accepts exactly five redirect_uris", () =>
        expect(
            ok(Array.from({ length: 5 }, (_, i) => `https://claude.ai/cb${i}`)),
        ).toBeNull());

    it("rejects more than five redirect_uris", () =>
        expect(
            ok(Array.from({ length: 6 }, (_, i) => `https://claude.ai/cb${i}`)),
        ).toMatch(/Too many redirect_uris/));

    it("rejects when any one of several redirects is bad", () =>
        expect(ok(["https://claude.ai/cb", "http://evil.example/cb"])).toMatch(
            /must use https/,
        ));
});
