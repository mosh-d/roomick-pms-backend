import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Application-layer AES-256-GCM for compliance-sensitive fields that must
 * never sit in plaintext at rest — guest ID document numbers, and (via
 * `encryptBuffer`) ID photos and generated PDFs on disk. Keyed off
 * `ENCRYPTION_KEY` (validated hex/32-byte at boot, `env.validation.ts`),
 * so a missing/malformed key fails fast here rather than producing silently
 * unreadable ciphertext later.
 */
@Injectable()
export class EncryptionService {
  private readonly key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex');

  /** `"iv:authTag:ciphertext"`, all hex — one text column, no schema change for existing string fields. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
  }

  decrypt(payload: string): string {
    const [ivHex, authTagHex, ciphertextHex] = payload.split(':');
    if (!ivHex || !authTagHex || !ciphertextHex) {
      throw new Error('Malformed encrypted payload — expected "iv:authTag:ciphertext"');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
  }

  /** `iv || authTag || ciphertext`, concatenated binary — for files (ID photos, generated PDFs), not text columns. */
  encryptBuffer(plaintext: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decryptBuffer(payload: Buffer): Buffer {
    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** Last-4 display mask for the `?reveal=true`-gated read path (`AuditInterceptor`'s own doc comment) — fixed-width dots so masked output never leaks the real value's length. */
  mask(value: string): string {
    const last4 = value.slice(-4);
    return `••••${last4}`;
  }
}
