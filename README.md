# lunchmoney-mcp-cloudflare

Deploy [LunchMoney's MCP server](https://github.com/akutishevsky/lunchmoney-mcp) to a Cloudflare Worker so Claude (web, desktop or mobile) can use it as a custom connector.

This is a **personal deployment**: one worker, one LunchMoney account, one API token. The token lives as a Cloudflare secret, and pasting that same token at the connector's sign-in page is how you approve a client. There is no identity provider, no user database and no accounts to manage.

## What you'll need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A [LunchMoney API token](https://my.lunchmoney.app/developers)
- Node 22 or newer

## Quick start

```sh
git clone https://github.com/georgebashi/lunchmoney-mcp-cloudflare.git
cd lunchmoney-mcp-cloudflare
./setup.sh
```

The wizard does everything below — KV namespace, deploy, secret — and prints the URL to paste into Claude.

## Setup (manual)

### 1. Clone, install, log in to Cloudflare

```sh
git clone https://github.com/georgebashi/lunchmoney-mcp-cloudflare.git
cd lunchmoney-mcp-cloudflare
npm install
npx wrangler login
```

### 2. Create the KV namespace

```sh
npx wrangler kv namespace create OAUTH_KV
```

Paste the printed id into `wrangler.jsonc` over `REPLACE_WITH_OAUTH_KV_ID`.

### 3. Deploy

```sh
npx wrangler deploy
```

The output prints a URL like `https://lunchmoney-mcp.<your-subdomain>.workers.dev`.

### 4. Store your LunchMoney token

```sh
npx wrangler secret put LUNCHMONEY_API_TOKEN
```

Setting a secret redeploys the worker, so there's no second `deploy` step.

### 5. Connect from Claude

In [claude.ai](https://claude.ai) → **Settings → Connectors → Add custom connector**:

```
https://lunchmoney-mcp.<your-subdomain>.workers.dev/mcp
```

Claude opens a sign-in page. Paste the same LunchMoney API token to approve the connection, and the LunchMoney tools show up in Claude. Approvals last until you revoke them; you won't be asked again on reconnect.

## How the auth works

Claude's custom-connector UI speaks OAuth, so the worker has to be an OAuth authorization server — that part isn't optional. What *is* optional is using an identity provider to run it, and this worker doesn't:

- `POST /register` — Claude registers itself (RFC 7591 dynamic client registration). Open by necessity, rate-limited per IP, and the registration is rejected unless every `redirect_uri` is `https` (or `http` on loopback, for local dev clients).
- `GET /authorize` — renders a single password field. It names the client asking and the URL the code would be sent to.
- `POST /authorize` — compares your paste against `LUNCHMONEY_API_TOKEN` in constant time, rate-limited to 5 attempts per minute per IP. On a match, it issues the grant. Nothing is stored: no cookie, no session, no second copy of the token.
- `/mcp` — the MCP endpoint, reachable only with an access token the worker issued.

The token is checked against LunchMoney at approval time, but only a definitive `401`/`403` blocks the grant — an outage on LunchMoney's side must not lock you out of your own connector.

`OAUTH_KV` holds client registrations and issued grants. Your LunchMoney token is never written to it.

## Rotating the token

```sh
npx wrangler secret put LUNCHMONEY_API_TOKEN
```

Existing Claude grants keep working and immediately start using the new token. To also force Claude to re-approve, delete the grant keys from KV:

```sh
npx wrangler kv key list --binding OAUTH_KV
npx wrangler kv key delete --binding OAUTH_KV "<grant key>"
```

## The LunchMoney MCP dependency

`@akutishevsky/lunchmoney-mcp` is pinned to a commit in
[georgebashi/lunchmoney-mcp](https://github.com/georgebashi/lunchmoney-mcp),
not to the npm release. That needs explaining, because it is a fork of a fork:

- **Upstream** ([akutishevsky/lunchmoney-mcp](https://github.com/akutishevsky/lunchmoney-mcp))
  publishes 3.0.0 to npm, but still builds against MCP SDK v1 and zod 3.
- **`agents`** — which provides the `createMcpHandler` this worker mounts on
  `/mcp` — peer-requires `@modelcontextprotocol/server` v2 and zod 4, and its
  handler takes a v2 `McpServer`. The npm release is therefore not usable here.
- **bm1549's fork** ported upstream to SDK v2 and added `runWithConfig`. Its
  `upstream/sdk-v2` branch has that work rebased on upstream 3.0.0, but is
  packaged for npm publication: `prepare` doesn't run `tsc` and `files` is
  `["build"]`, so installing it straight from git yields no build output.
- **This fork** is that branch plus the two `package.json` lines that make it
  installable as a git dependency.

To move it forward when upstream or bm1549 releases something new, rebase
`v3-sdk-v2-installable` onto the new base, keep the packaging commit on top,
and re-pin `package.json` to the resulting SHA.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then fill in LUNCHMONEY_API_TOKEN
npm run dev
```

```sh
npm run typecheck
npm run lint
npm test
```

## Troubleshooting

- **"That doesn't match the API token this connector was deployed with"** — the paste differs from the stored secret. Re-run `npx wrangler secret put LUNCHMONEY_API_TOKEN` if you're unsure what's stored.
- **"LunchMoney no longer accepts this token"** — the token was revoked or rotated at LunchMoney. Issue a new one and `wrangler secret put` it.
- **"Too many attempts"** — the per-IP limiter. Wait a minute.
- **"Unknown client"** — the registration expired (90 days). Remove and re-add the connector in Claude.
- **Anything else** — `npx wrangler tail` streams live logs from the deployed worker.

## License

MIT
