// HTML and HTTP utilities shared across request handlers.

export function htmlEscape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            case "'":
                return "&#39;";
            default:
                return c;
        }
    });
}

export function cspWithNonce(nonce: string): string {
    return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none';`;
}

/** A fresh CSP script nonce. 128 bits, hex-encoded. */
export function newNonce(): string {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    let s = "";
    for (const b of buf) s += b.toString(16).padStart(2, "0");
    return s;
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Hashing first means the XOR loop always runs over 32 equal-length bytes, so
 * neither the length of the guess nor the position of the first differing
 * character is observable — a plain `===` on the raw strings would leak both.
 */
export async function secretsMatch(a: string, b: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const [digestA, digestB] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(a)),
        crypto.subtle.digest("SHA-256", encoder.encode(b)),
    ]);
    const bytesA = new Uint8Array(digestA);
    const bytesB = new Uint8Array(digestB);
    let diff = 0;
    for (let i = 0; i < bytesA.length; i++) {
        diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
    }
    return diff === 0;
}
