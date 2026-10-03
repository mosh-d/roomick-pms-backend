import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/**
 * Time-based one-time passwords (RFC 6238) — what Google Authenticator,
 * Microsoft Authenticator, 1Password, Authy and every other authenticator app
 * speak. SHA-1, six digits, 30-second steps: the defaults every app supports,
 * and what an `otpauth://` link without parameters means.
 *
 * Written out rather than pulled from a package because it's forty lines of
 * HMAC that the test vectors in the RFCs pin down exactly, and it sits on the
 * sign-in path where every dependency is something else to audit.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step either side: a phone's clock a few seconds off, or a code typed as it rolled over. */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits — the size RFC 4226 recommends for an HMAC-SHA1 key. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226: HMAC the counter, take four bytes at the offset the last nibble names, keep `digits` digits. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function stepAt(timeMs: number): number {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secretBase32: string, timeMs: number): string {
  return hotp(base32Decode(secretBase32), stepAt(timeMs));
}

/**
 * The time step a code matches, or null. A code for a step at or before
 * `lastUsedStep` is refused even if it's right — that's what stops a code
 * read over someone's shoulder, or captured in transit, from working a second
 * time inside its 90-second life.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretBase32);
  const current = stepAt(nowMs);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const step = current + delta;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return null;
}

/** What an authenticator app scans: `otpauth://totp/Issuer:account?secret=…&issuer=Issuer`. */
export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** No 0/O, 1/l/I: these get read off paper and typed in a hurry. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 10;

/** `xxxxx-xxxxx` — about 49 bits each, plenty for a single-use code behind a lockout. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

export function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

/**
 * SHA-256, not bcrypt: a recovery code is 49 random bits, not a password a
 * person chose, so a fast hash can't be brute-forced from a leaked row in any
 * useful time — and the lockout limits online guessing.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

export function looksLikeRecoveryCode(code: string): boolean {
  return /^[a-z0-9]{10}$/.test(normaliseRecoveryCode(code));
}
