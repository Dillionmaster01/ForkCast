// PBKDF2-SHA256, 100,000 iterations, 32-byte output - deliberately identical to
// the old Python implementation (hashlib.pbkdf2_hmac("sha256", pin, salt, 100000))
// so existing users' PINs keep working unchanged after the cloud migration.

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashPin(pin: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 },
    keyMaterial,
    256
  );
  return toHex(bits);
}

export function makeSalt(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function newToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

export function nowIso(): string {
  return new Date().toISOString();
}
