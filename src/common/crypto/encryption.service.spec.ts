process.env.ENCRYPTION_KEY = 'a'.repeat(64);

import { EncryptionService } from './encryption.service';

describe('EncryptionService', () => {
  let service: EncryptionService;

  beforeEach(() => {
    service = new EncryptionService();
  });

  describe('encrypt / decrypt (strings)', () => {
    it('round-trips a plaintext string', () => {
      const ciphertext = service.encrypt('P1234567');
      expect(ciphertext).not.toContain('P1234567');
      expect(service.decrypt(ciphertext)).toBe('P1234567');
    });

    it('produces a different ciphertext each call (random IV) but both decrypt correctly', () => {
      const a = service.encrypt('same-input');
      const b = service.encrypt('same-input');
      expect(a).not.toBe(b);
      expect(service.decrypt(a)).toBe('same-input');
      expect(service.decrypt(b)).toBe('same-input');
    });

    it('stores as "iv:authTag:ciphertext" hex, three colon-separated parts', () => {
      const parts = service.encrypt('x').split(':');
      expect(parts).toHaveLength(3);
      for (const part of parts) expect(part).toMatch(/^[0-9a-f]+$/);
    });

    it('rejects a tampered ciphertext (auth tag mismatch)', () => {
      const [iv, authTag, ciphertext] = service.encrypt('secret-value').split(':');
      const flipped = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === '00' ? '01' : '00');
      expect(() => service.decrypt(`${iv}:${authTag}:${flipped}`)).toThrow();
    });

    it('rejects a malformed payload', () => {
      expect(() => service.decrypt('not-a-valid-payload')).toThrow();
    });
  });

  describe('encryptBuffer / decryptBuffer (files)', () => {
    it('round-trips binary data', () => {
      const original = Buffer.from([0, 1, 2, 255, 254, 253, 128]);
      const encrypted = service.encryptBuffer(original);
      expect(encrypted.equals(original)).toBe(false);
      expect(service.decryptBuffer(encrypted).equals(original)).toBe(true);
    });

    it('rejects a tampered buffer', () => {
      const encrypted = service.encryptBuffer(Buffer.from('a real id photo'.repeat(20)));
      encrypted[encrypted.length - 1] ^= 0xff;
      expect(() => service.decryptBuffer(encrypted)).toThrow();
    });
  });

  describe('mask', () => {
    it('shows a fixed-width mask plus the last 4 characters', () => {
      expect(service.mask('P123456789')).toBe('••••6789');
    });

    it('does not vary its dot count with the input length (no length leak)', () => {
      expect(service.mask('AB123456789012345')).toBe('••••2345');
      expect(service.mask('short1')).toBe('••••ort1');
    });
  });
});
