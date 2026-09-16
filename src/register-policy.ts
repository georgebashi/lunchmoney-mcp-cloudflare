// Dynamic Client Registration (RFC 7591) policy.
//
// /register has to stay open — MCP clients register themselves before they can
// start an OAuth flow, so there is nobody to authenticate at that point. What
// we can do is bound what a registration is allowed to say. The redirect URI
// is the part that matters: it's where the authorization code is delivered, so
// a client that registers `http://evil.example/cb` and then gets the operator
// to approve it walks away with a usable grant. Requiring https (or loopback,
// for local dev clients) keeps the code off the wire in the clear and off
// hosts that can't be named in a certificate.

/** Max entries in `redirect_uris`. Real clients register one or two. */
const MAX_REDIRECT_URIS = 5;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validate DCR metadata.
 *
 * @returns `null` when the registration is acceptable, otherwise a
 *   human-readable reason to reject it with.
 */
export function checkClientMetadata(
    metadata: Record<string, unknown>,
): string | null {
    const redirectUris = metadata["redirect_uris"];
    if (!Array.isArray(redirectUris)) {
        return "redirect_uris missing or not an array";
    }
    if (redirectUris.length > MAX_REDIRECT_URIS) {
        return `Too many redirect_uris (max ${MAX_REDIRECT_URIS})`;
    }

    for (const raw of redirectUris) {
        if (typeof raw !== "string") {
            return "redirect_uris must be strings";
        }
        let parsed: URL;
        try {
            parsed = new URL(raw);
        } catch {
            return `Invalid redirect_uri: ${raw}`;
        }
        const scheme = parsed.protocol.replace(/:$/, "");
        // `hostname` renders IPv6 bracketed, e.g. "[::1]".
        const host = parsed.hostname;
        const isLoopback = LOOPBACK_HOSTS.has(host);

        if (scheme !== "https" && !(scheme === "http" && isLoopback)) {
            return `redirect_uri must use https (or http on loopback): ${raw}`;
        }

        const isIpLiteral =
            /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
            (host.startsWith("[") && host.endsWith("]"));
        if (isIpLiteral && !isLoopback) {
            return `redirect_uri host must not be an IP literal: ${raw}`;
        }
    }

    return null;
}
