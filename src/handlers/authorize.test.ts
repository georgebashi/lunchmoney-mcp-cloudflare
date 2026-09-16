import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
    AuthRequest,
    ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { authorizeHandler } from "./authorize.js";
import type { AuthEnv } from "../env.js";

const TOKEN = "lunchmoney-token-0123456789abcdef";
const QUERY =
    "response_type=code&client_id=cli_1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=xyz&code_challenge=abc&code_challenge_method=S256";

const CLIENT: ClientInfo = {
    clientId: "cli_1",
    clientName: "Claude",
    redirectUris: ["https://claude.ai/cb"],
    tokenEndpointAuthMethod: "none",
};

function authRequest(): AuthRequest {
    return {
        responseType: "code",
        clientId: "cli_1",
        redirectUri: "https://claude.ai/cb",
        scope: [],
        state: "xyz",
        codeChallenge: "abc",
        codeChallengeMethod: "S256",
    };
}

/** `exactOptionalPropertyTypes` forbids setting the PKCE fields to undefined. */
function authRequestWithoutPkce(): AuthRequest {
    const { codeChallenge: _c, codeChallengeMethod: _m, ...rest } = authRequest();
    return rest;
}

interface Stubs {
    parseAuthRequest: ReturnType<typeof vi.fn>;
    lookupClient: ReturnType<typeof vi.fn>;
    completeAuthorization: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
}

let stubs: Stubs;

function makeEnv(token = TOKEN): AuthEnv {
    return {
        OAUTH_KV: null as unknown as KVNamespace,
        REGISTER_LIMITER: null as unknown as RateLimit,
        LOGIN_LIMITER: { limit: stubs.limit } as unknown as RateLimit,
        LUNCHMONEY_API_TOKEN: token,
        OAUTH_PROVIDER: {
            parseAuthRequest: stubs.parseAuthRequest,
            lookupClient: stubs.lookupClient,
            completeAuthorization: stubs.completeAuthorization,
        } as unknown as AuthEnv["OAUTH_PROVIDER"],
    };
}

function get(): Request {
    return new Request(`https://mcp.example.com/authorize?${QUERY}`);
}

function post(fields: Record<string, string>): Request {
    const body = new URLSearchParams(fields);
    return new Request("https://mcp.example.com/authorize", {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            "cf-connecting-ip": "203.0.113.9",
        },
        body,
    });
}

beforeEach(() => {
    stubs = {
        parseAuthRequest: vi.fn().mockResolvedValue(authRequest()),
        lookupClient: vi.fn().mockResolvedValue(CLIENT),
        completeAuthorization: vi
            .fn()
            .mockResolvedValue({ redirectTo: "https://claude.ai/cb?code=abc" }),
        limit: vi.fn().mockResolvedValue({ success: true }),
    };
    // Token validation is a health check on the deployment; default it to a
    // LunchMoney that is up and happy.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("GET /authorize", () => {
    it("renders the token form for a valid request", async () => {
        const res = await authorizeHandler(get(), makeEnv());
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('name="token"');
        expect(body).toContain("Claude");
        expect(body).toContain("https://claude.ai/cb");
    });

    it("round-trips the query string into a hidden field", async () => {
        const res = await authorizeHandler(get(), makeEnv());
        expect(await res.text()).toContain(
            `name="q" value="${QUERY.replace(/&/g, "&amp;")}"`,
        );
    });

    it("sets a CSP whose script nonce matches the inline script", async () => {
        const res = await authorizeHandler(get(), makeEnv());
        const csp = res.headers.get("content-security-policy") ?? "";
        const nonce = /'nonce-([0-9a-f]{32})'/.exec(csp)?.[1];
        expect(nonce).toBeDefined();
        expect(await res.text()).toContain(`<script nonce="${nonce}">`);
    });

    it("never echoes the deployed token into the page", async () => {
        const res = await authorizeHandler(get(), makeEnv());
        expect(await res.text()).not.toContain(TOKEN);
    });

    it("rejects a request with no PKCE challenge", async () => {
        stubs.parseAuthRequest.mockResolvedValue(authRequestWithoutPkce());
        const res = await authorizeHandler(get(), makeEnv());
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/PKCE required/);
    });

    it("rejects an unparseable authorization request", async () => {
        stubs.parseAuthRequest.mockRejectedValue(new Error("bad request"));
        const res = await authorizeHandler(get(), makeEnv());
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/Invalid authorization request/);
    });

    it("rejects an unknown client", async () => {
        stubs.lookupClient.mockResolvedValue(null);
        const res = await authorizeHandler(get(), makeEnv());
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/Unknown client/);
    });
});

describe("POST /authorize", () => {
    it("completes the grant when the token matches", async () => {
        const res = await authorizeHandler(
            post({ token: TOKEN, q: QUERY }),
            makeEnv(),
        );
        expect(res.status).toBe(200);
        expect(stubs.completeAuthorization).toHaveBeenCalledOnce();
        expect(await res.text()).toContain("https://claude.ai/cb?code=abc");
    });

    it("passes the parsed request and no props to completeAuthorization", async () => {
        await authorizeHandler(post({ token: TOKEN, q: QUERY }), makeEnv());
        const arg = stubs.completeAuthorization.mock.calls[0]?.[0] as {
            userId: string;
            props: unknown;
            request: AuthRequest;
        };
        expect(arg.userId).toBe("owner");
        expect(arg.props).toEqual({});
        expect(arg.request.clientId).toBe("cli_1");
    });

    it("tolerates surrounding whitespace on a pasted token", async () => {
        const res = await authorizeHandler(
            post({ token: `  ${TOKEN}\n`, q: QUERY }),
            makeEnv(),
        );
        expect(res.status).toBe(200);
        expect(stubs.completeAuthorization).toHaveBeenCalledOnce();
    });

    it("re-renders with an error when the token is wrong", async () => {
        const res = await authorizeHandler(
            post({ token: "not-the-token", q: QUERY }),
            makeEnv(),
        );
        expect(res.status).toBe(401);
        expect(stubs.completeAuthorization).not.toHaveBeenCalled();
        expect(await res.text()).toMatch(/doesn&#39;t match/);
    });

    it("rejects an empty submission", async () => {
        const res = await authorizeHandler(
            post({ token: "", q: QUERY }),
            makeEnv(),
        );
        expect(res.status).toBe(401);
        expect(stubs.completeAuthorization).not.toHaveBeenCalled();
    });

    it("blocks the grant when LunchMoney rejects the deployed token", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 401 }),
        );
        const res = await authorizeHandler(
            post({ token: TOKEN, q: QUERY }),
            makeEnv(),
        );
        expect(res.status).toBe(401);
        expect(stubs.completeAuthorization).not.toHaveBeenCalled();
        expect(await res.text()).toMatch(/no longer accepts this token/);
    });

    it("still grants when LunchMoney is merely down", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({ ok: false, status: 503 }),
        );
        const res = await authorizeHandler(
            post({ token: TOKEN, q: QUERY }),
            makeEnv(),
        );
        expect(res.status).toBe(200);
        expect(stubs.completeAuthorization).toHaveBeenCalledOnce();
    });

    it("still grants when the validation fetch throws", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new Error("connection reset")),
        );
        const res = await authorizeHandler(
            post({ token: TOKEN, q: QUERY }),
            makeEnv(),
        );
        expect(res.status).toBe(200);
        expect(stubs.completeAuthorization).toHaveBeenCalledOnce();
    });

    it("throttles per IP before checking the token", async () => {
        stubs.limit.mockResolvedValue({ success: false });
        const res = await authorizeHandler(
            post({ token: TOKEN, q: QUERY }),
            makeEnv(),
        );
        expect(res.status).toBe(429);
        expect(stubs.parseAuthRequest).not.toHaveBeenCalled();
        expect(stubs.completeAuthorization).not.toHaveBeenCalled();
    });

    it("rejects a form with no q field", async () => {
        const res = await authorizeHandler(post({ token: TOKEN }), makeEnv());
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/Malformed form/);
    });

    it("rejects an over-long q field", async () => {
        const res = await authorizeHandler(
            post({ token: TOKEN, q: "x".repeat(4097) }),
            makeEnv(),
        );
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/Malformed form/);
    });

    it("rejects a tampered q that drops PKCE", async () => {
        stubs.parseAuthRequest.mockResolvedValue(authRequestWithoutPkce());
        const res = await authorizeHandler(
            post({ token: TOKEN, q: "response_type=code&client_id=cli_1" }),
            makeEnv(),
        );
        expect(res.status).toBe(400);
        expect(stubs.completeAuthorization).not.toHaveBeenCalled();
    });

    it("re-parses q against this worker's own origin", async () => {
        await authorizeHandler(post({ token: TOKEN, q: QUERY }), makeEnv());
        const reparsed = stubs.parseAuthRequest.mock.calls[0]?.[0] as Request;
        expect(new URL(reparsed.url).origin).toBe("https://mcp.example.com");
    });
});

describe("other methods", () => {
    it("returns 405 with an Allow header", async () => {
        const res = await authorizeHandler(
            new Request("https://mcp.example.com/authorize", {
                method: "DELETE",
            }),
            makeEnv(),
        );
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, POST");
    });
});
