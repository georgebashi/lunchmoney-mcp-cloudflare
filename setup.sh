#!/usr/bin/env bash
# setup.sh — first-time deploy of lunchmoney-mcp-cloudflare.
#
# Walks you through:
#   1. Node version check + npm install
#   2. Cloudflare login (if needed)
#   3. KV namespace creation (OAUTH_KV)
#   4. Deploy (mints your workers.dev URL)
#   5. Storing your LunchMoney API token as a worker secret
#
# Safe to re-run. The KV step is skipped once wrangler.jsonc holds a real id;
# the secret is overwritten each time.

set -euo pipefail

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
RED=$'\033[31m'
RESET=$'\033[0m'

WRANGLER_CONFIG="wrangler.jsonc"

step() {
    echo
    echo "${BOLD}>>> $1${RESET}"
}

die() {
    echo "${RED}error: $1${RESET}" >&2
    exit 1
}

read_value() {
    local label="$1"
    local value=""
    printf '%s: ' "$label" >&2
    IFS= read -r value
    printf '%s' "$value"
}

read_secret() {
    local label="$1"
    local value=""
    printf '%s: ' "$label" >&2
    IFS= read -rs value
    echo >&2
    printf '%s' "$value"
}

# -----------------------------------------------------------------------------

step "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 22+ first."
node_major=$(node -p "process.versions.node.split('.')[0]")
if (( node_major < 22 )); then
    die "Node $(node -v) is too old. wrangler v4 needs Node 22+."
fi
echo "Node $(node -v)"

# -----------------------------------------------------------------------------

step "Installing dependencies"
npm install

# -----------------------------------------------------------------------------

step "Cloudflare login"
if npx --no-install wrangler whoami 2>/dev/null | grep -q "associated with"; then
    echo "Already logged in."
else
    npx wrangler login
fi

# -----------------------------------------------------------------------------

step "KV namespace"

placeholder="REPLACE_WITH_OAUTH_KV_ID"
if grep -q "$placeholder" "$WRANGLER_CONFIG"; then
    echo "Creating OAUTH_KV…"
    kv_out=$(npx wrangler kv namespace create "OAUTH_KV")
    echo "$kv_out"
    kv_id=$(echo "$kv_out" | grep -oE '[a-f0-9]{32}' | head -1 || true)
    [[ -n "$kv_id" ]] || die "Could not detect the new KV id. Paste it into $WRANGLER_CONFIG manually and re-run."
    sed -i.bak "s/$placeholder/$kv_id/" "$WRANGLER_CONFIG"
    rm -f "$WRANGLER_CONFIG.bak"
    echo "Wrote OAUTH_KV id $kv_id into $WRANGLER_CONFIG"
else
    echo "${DIM}$WRANGLER_CONFIG already has an OAUTH_KV id; skipping.${RESET}"
fi

# -----------------------------------------------------------------------------

step "Deploy"
deploy_out=$(npx wrangler deploy -c "$WRANGLER_CONFIG" 2>&1 | tee /dev/tty)
worker_url=$(echo "$deploy_out" | grep -oE 'https://[A-Za-z0-9._-]+\.workers\.dev' | tail -1 || true)
if [[ -z "${worker_url:-}" ]]; then
    worker_url=$(read_value "Worker URL printed above (https://…workers.dev)")
fi

# -----------------------------------------------------------------------------

step "LunchMoney API token"

cat <<EOF

Get a token from ${BOLD}https://my.lunchmoney.app/developers${RESET}.

The worker calls LunchMoney with it, and pasting the same token at the
connector's sign-in page is how you approve a client. It is the only
credential this deployment has, so treat it like a password.

EOF

LUNCHMONEY_API_TOKEN=$(read_secret "LunchMoney API token")
[[ -n "$LUNCHMONEY_API_TOKEN" ]] || die "A LunchMoney API token is required."

if command -v curl >/dev/null 2>&1; then
    echo "${DIM}Checking the token against LunchMoney…${RESET}"
    status=$(curl -s -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $LUNCHMONEY_API_TOKEN" \
        https://api.lunchmoney.dev/v1/me || echo "000")
    case "$status" in
        200) echo "Token accepted." ;;
        401|403) die "LunchMoney rejected that token (HTTP $status). Check it and re-run." ;;
        *) echo "${DIM}Couldn't verify (HTTP $status); continuing anyway.${RESET}" ;;
    esac
fi

printf '%s' "$LUNCHMONEY_API_TOKEN" | npx wrangler secret put -c "$WRANGLER_CONFIG" LUNCHMONEY_API_TOKEN >/dev/null
echo "Secret stored."

# -----------------------------------------------------------------------------

cat <<EOF

${GREEN}${BOLD}Done.${RESET}

Add this URL to claude.ai → Settings → Connectors → Add custom connector:

    ${BOLD}${GREEN}$worker_url/mcp${RESET}

Claude will open a sign-in page. Paste the same LunchMoney API token there to
approve the connection, and the LunchMoney tools appear in Claude.

EOF
