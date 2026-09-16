// /authorize — the single human step in the connect flow.
//
// This worker is a personal deployment: one operator, one LunchMoney account,
// one API token held as a worker secret. So there is no "who are you?" to
// answer and no identity provider needed to answer it. The only question is
// "are you the person who deployed this?", and the cheapest proof of that is
// the deployed token itself. Paste it here and you get a grant; don't and you
// don't.
//
// GET  renders the form, with the pending authorization request carried in a
//      hidden field so the POST can pick it up again.
// POST compares the pasted value against LUNCHMONEY_API_TOKEN and, on a
//      match, completes the OAuth grant and bounces back to the client.
//
// Nothing is stored between the two: no cookie, no session, no CSRF token. A
// forged cross-site POST would have to already carry the secret to do
// anything, and at that point the attacker doesn't need the victim's browser.

import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import type { AuthEnv } from "../env.js";
import { validateLunchMoneyToken } from "../validate.js";
import { cspWithNonce, htmlEscape, newNonce, secretsMatch } from "../utils.js";

/**
 * The grant's subject. A personal deployment has exactly one user, so this is
 * a constant rather than anything derived from a login.
 */
const OWNER_USER_ID = "owner";

/** Bound on the round-tripped query string, to keep a huge POST body cheap. */
const MAX_QUERY_LENGTH = 4096;

function htmlHeaders(nonce: string): HeadersInit {
    return {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": cspWithNonce(nonce),
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
    };
}

function text(body: string, status: number): Response {
    return new Response(body, {
        status,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

function clientLabel(client: ClientInfo): string {
    return client.clientName ?? client.clientId;
}

function renderForm(opts: {
    client: ClientInfo;
    query: string;
    nonce: string;
    error?: string;
}): string {
    const errorBlock = opts.error
        ? `<div class="error" role="alert">${htmlEscape(opts.error)}</div>`
        : "";
    const redirectHost = opts.client.redirectUris[0] ?? "(none)";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connect LunchMoney</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; max-width: 520px; margin: 3em auto; padding: 0 1em; color: #222; }
  h1 { font-size: 1.4em; }
  p { line-height: 1.5; }
  label { display: block; font-weight: 600; margin-top: 1em; }
  input[type=password] { width: 100%; padding: 0.6em; font-size: 1em; box-sizing: border-box; }
  button { margin-top: 1.2em; padding: 0.7em 1.4em; font-size: 1em; cursor: pointer; display: inline-flex; align-items: center; gap: 0.5em; }
  button[disabled] { cursor: progress; opacity: 0.75; }
  .meta { color: #666; font-size: 0.9em; word-break: break-all; }
  .error { background: #fee; border: 1px solid #c00; color: #900; padding: 0.7em 1em; border-radius: 4px; margin-top: 1em; }
  .hint { color: #666; font-size: 0.85em; margin-top: 0.6em; }
  a { color: #06c; }
  .spinner { width: 0.9em; height: 0.9em; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; display: none; animation: spin 0.7s linear infinite; }
  button[disabled] .spinner { display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<h1>Connect LunchMoney</h1>
<p><strong>${htmlEscape(clientLabel(opts.client))}</strong> is asking to use this connector. To approve it, paste the LunchMoney API token this worker was deployed with.</p>
<p class="meta">It will be sent back to <code>${htmlEscape(redirectHost)}</code>. The token is only compared against the one already stored as a worker secret &mdash; it is not saved again.</p>
${errorBlock}
<form method="POST" action="/authorize" id="authorize-form">
  <label for="token">LunchMoney API token</label>
  <input id="token" name="token" type="password" autocomplete="off" required spellcheck="false">
  <input type="hidden" name="q" value="${htmlEscape(opts.query)}">
  <button type="submit" id="submit-btn">
    <span class="spinner" aria-hidden="true"></span>
    <span class="label">Approve</span>
  </button>
  <p class="hint">Tokens live at <a href="https://my.lunchmoney.app/developers">my.lunchmoney.app/developers</a>.</p>
</form>
<script nonce="${htmlEscape(opts.nonce)}">
  (function () {
    var form = document.getElementById('authorize-form');
    var btn = document.getElementById('submit-btn');
    var label = btn.querySelector('.label');
    form.addEventListener('submit', function () {
      if (btn.disabled) return;
      btn.disabled = true;
      label.textContent = 'Checking…';
    });
  })();
</script>
</body>
</html>`;
}

/**
 * Parse the pending OAuth request and look up the client that started it.
 * Returns a `Response` instead when the request can't be honoured.
 */
async function resolveRequest(
    request: Request,
    env: AuthEnv,
): Promise<{ authReq: AuthRequest; client: ClientInfo } | Response> {
    let authReq: AuthRequest;
    try {
        authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch {
        return text("Invalid authorization request.", 400);
    }
    if (!authReq.codeChallenge) {
        return text(
            "PKCE required: this client must supply a code_challenge.",
            400,
        );
    }
    const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
    if (!client) {
        return text(
            "Unknown client. Remove and re-add the connector in Claude.",
            400,
        );
    }
    return { authReq, client };
}

async function handleGet(request: Request, env: AuthEnv): Promise<Response> {
    const resolved = await resolveRequest(request, env);
    if (resolved instanceof Response) return resolved;

    const nonce = newNonce();
    const query = new URL(request.url).search.replace(/^\?/, "");
    return new Response(
        renderForm({ client: resolved.client, query, nonce }),
        { status: 200, headers: htmlHeaders(nonce) },
    );
}

async function handlePost(request: Request, env: AuthEnv): Promise<Response> {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.LOGIN_LIMITER.limit({ key: `authorize:${ip}` });
    if (!success) {
        return text("Too many attempts. Wait a minute and try again.", 429);
    }

    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return text("Invalid form body.", 400);
    }
    const submitted = form.get("token");
    const query = form.get("q");
    if (
        typeof submitted !== "string" ||
        typeof query !== "string" ||
        query.length > MAX_QUERY_LENGTH
    ) {
        return text("Malformed form.", 400);
    }

    // Recover the authorization request from the query string the GET rendered
    // into the form. It is neither secret nor trusted: the provider re-checks
    // client_id and redirect_uri against the stored registration, so tampering
    // with it can only produce a request the client could have made itself.
    const origin = new URL(request.url).origin;
    const resolved = await resolveRequest(
        new Request(`${origin}/authorize?${query}`),
        env,
    );
    if (resolved instanceof Response) return resolved;
    const { authReq, client } = resolved;

    const reject = (message: string, status: number): Response => {
        const nonce = newNonce();
        return new Response(
            renderForm({ client, query, nonce, error: message }),
            { status, headers: htmlHeaders(nonce) },
        );
    };

    const matches = await secretsMatch(
        submitted.trim(),
        env.LUNCHMONEY_API_TOKEN,
    );
    if (!matches) {
        return reject(
            "That doesn't match the API token this connector was deployed with.",
            401,
        );
    }

    // The paste matched the deployed secret, so the caller is the operator and
    // authorization is already decided. Checking the token against LunchMoney
    // is a health check on the deployment, not an auth step — so only a
    // definitive rejection blocks the grant. An outage or a rate limit at
    // LunchMoney's end must not lock you out of your own connector.
    const check = await validateLunchMoneyToken(submitted.trim());
    if (!check.ok && (check.status === 401 || check.status === 403)) {
        return reject(
            "LunchMoney no longer accepts this token. Issue a new one at my.lunchmoney.app/developers, then re-run: wrangler secret put LUNCHMONEY_API_TOKEN",
            401,
        );
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authReq,
        userId: OWNER_USER_ID,
        metadata: { label: "LunchMoney" },
        scope: authReq.scope,
        props: {},
    });

    // Return HTML with a JS redirect rather than a 302.
    //
    // Some mobile WebViews (notably Claude's iOS in-app browser) don't follow
    // POST-response redirects to whitelisted OAuth callback URLs. HTML with a
    // JS redirect, a meta-refresh fallback and a visible link works
    // everywhere — the WebView sees a GET navigation, which is what its
    // URL-pattern interceptor is watching for.
    const nonce = newNonce();
    const safe = htmlEscape(redirectTo);
    const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connecting…</title>
<meta http-equiv="refresh" content="0; url=${safe}">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 420px; margin: 4em auto; padding: 0 1em; text-align: center; color: #222; }
  a { color: #06c; word-break: break-all; }
</style>
</head>
<body>
<p>Approved. Returning you to ${htmlEscape(clientLabel(client))}…</p>
<p>If you aren't redirected automatically, <a href="${safe}">tap here</a>.</p>
<script nonce="${htmlEscape(nonce)}">
  window.location.replace(${JSON.stringify(redirectTo)});
</script>
</body>
</html>`;
    return new Response(body, { status: 200, headers: htmlHeaders(nonce) });
}

export async function authorizeHandler(
    request: Request,
    env: AuthEnv,
): Promise<Response> {
    if (request.method === "GET") return handleGet(request, env);
    if (request.method === "POST") return handlePost(request, env);
    return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, POST" },
    });
}
