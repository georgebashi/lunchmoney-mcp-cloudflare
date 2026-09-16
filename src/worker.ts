// Entry point: a personal remote MCP server for LunchMoney.
//
// The worker is its own OAuth authorization server, because that is the only
// way Claude's custom-connector UI knows how to authenticate against a remote
// MCP endpoint. It is *not* an identity provider: there is one user (you), one
// LunchMoney token (a worker secret), and /authorize just checks that whoever
// is approving the connection knows that token. See src/handlers/authorize.ts.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "@akutishevsky/lunchmoney-mcp/server";
import { runWithConfig } from "@akutishevsky/lunchmoney-mcp/config";
import packageJson from "../package.json" with { type: "json" };
import { authorizeHandler } from "./handlers/authorize.js";
import { checkClientMetadata } from "./register-policy.js";
import type { AuthEnv } from "./env.js";

const API_ROUTE = "/mcp";

/**
 * The MCP endpoint. Only reached with a valid access token — the OAuth
 * provider rejects anything else before this runs.
 *
 * The LunchMoney token is bound with `runWithConfig` rather than the
 * module-level `initializeConfig` singleton. It is a single-tenant worker so
 * the two would behave the same today, but `initializeConfig` sets a
 * process-wide fallback that a future second tenant would silently inherit;
 * scoping it per request keeps that mistake impossible to make.
 */
const apiHandler = {
    async fetch(
        request: Request,
        env: AuthEnv,
        ctx: ExecutionContext,
    ): Promise<Response> {
        const token = env.LUNCHMONEY_API_TOKEN;
        if (!token) {
            throw new Error(
                "LUNCHMONEY_API_TOKEN is not set. Run: wrangler secret put LUNCHMONEY_API_TOKEN",
            );
        }
        const handler = createMcpHandler(
            () => createServer(packageJson.version),
            { route: API_ROUTE },
        );
        return runWithConfig(token, () =>
            handler(request, env as never, ctx),
        );
    },
};

/** Everything that isn't the MCP endpoint or a provider-owned OAuth route. */
const browserHandler = {
    async fetch(request: Request, env: AuthEnv): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/authorize") {
            return authorizeHandler(request, env);
        }
        if (url.pathname === "/") {
            return new Response(
                `LunchMoney MCP server.\n\nAdd ${url.origin}${API_ROUTE} to Claude as a custom connector.\n`,
                { headers: { "content-type": "text/plain; charset=utf-8" } },
            );
        }
        return new Response("Not found", { status: 404 });
    },
};

const provider = new OAuthProvider<AuthEnv>({
    apiRoute: API_ROUTE,
    apiHandler,
    defaultHandler: browserHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // OAuth 2.1: S256 only. `plain` offers no protection against a code
    // interceptor, and every MCP client in practice supports S256.
    allowPlainPKCE: false,
    clientRegistrationCallback: ({ clientMetadata }) => {
        const problem = checkClientMetadata(clientMetadata);
        return problem ? { description: problem } : undefined;
    },
});

export default {
    async fetch(
        request: Request,
        env: AuthEnv,
        ctx: ExecutionContext,
    ): Promise<Response> {
        // Registration is necessarily unauthenticated, so throttle it per IP.
        // Without this, anyone who finds the URL can mint KV entries forever.
        if (
            request.method === "POST" &&
            new URL(request.url).pathname === "/register"
        ) {
            const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
            const { success } = await env.REGISTER_LIMITER.limit({
                key: `register:${ip}`,
            });
            if (!success) {
                return Response.json(
                    {
                        error: "invalid_client_metadata",
                        error_description:
                            "Too many registration attempts; try again shortly.",
                    },
                    { status: 429 },
                );
            }
        }
        return provider.fetch(request, env, ctx);
    },
} satisfies ExportedHandler<AuthEnv>;
