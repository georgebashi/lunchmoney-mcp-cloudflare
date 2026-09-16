// Worker bindings. The KV namespace and rate limiters come from
// wrangler.jsonc; LUNCHMONEY_API_TOKEN is a secret set with
// `wrangler secret put` (or .dev.vars locally), so `wrangler types` doesn't
// know about it and we declare it here.

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface WorkerEnv {
    /** Client registrations, grants and issued tokens for the OAuth provider. */
    OAUTH_KV: KVNamespace;
    /** Per-IP throttle on POST /register, so DCR can't be used to fill KV. */
    REGISTER_LIMITER: RateLimit;
    /** Per-IP throttle on POST /authorize, so the token can't be guessed. */
    LOGIN_LIMITER: RateLimit;
    /**
     * The LunchMoney personal API token this deployment acts as. It is both
     * the credential the worker calls LunchMoney with and the one you paste
     * at /authorize to prove the connector is yours — see
     * src/handlers/authorize.ts.
     */
    LUNCHMONEY_API_TOKEN: string;
}

/** What the OAuth provider injects into the browser-facing handler. */
export interface AuthEnv extends WorkerEnv {
    OAUTH_PROVIDER: OAuthHelpers;
}
