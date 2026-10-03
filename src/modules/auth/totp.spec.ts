import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  hotp,
  looksLikeRecoveryCode,
  otpauthUri,
  stepAt,
  totp,
  verifyTotp,
} from './totp';

// RFC 4226 Appendix D / RFC 6238 Appendix B: the ASCII secret "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp', () => {
  it('base32 round-trips, and matches the RFC secret’s known encoding', () => {
    expect(base32Encode(RFC_SECRET)).toBe(RFC_SECRET_BASE32);
    expect(base32Decode(RFC_SECRET_BASE32).equals(RFC_SECRET)).toBe(true);
    expect(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq').equals(RFC_SECRET)).toBe(true);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('produces RFC 4226’s published HOTP values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect(expected.map((_, counter) => hotp(RFC_SECRET, counter))).toEqual(expected);
  });

  it('produces RFC 6238’s published TOTP values (last six digits of the eight-digit table)', () => {
    expect(totp(RFC_SECRET_BASE32, 59_000)).toBe('287082'); // 94287082
    expect(totp(RFC_SECRET_BASE32, 1_111_111_109_000)).toBe('081804'); // 07081804
    expect(totp(RFC_SECRET_BASE32, 1_234_567_890_000)).toBe('005924'); // 89005924
    expect(totp(RFC_SECRET_BASE32, 2_000_000_000_000)).toBe('279037'); // 69279037
  });

  it('makes 160-bit secrets', () => {
    const secret = generateSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateSecret()).not.toBe(secret);
  });

  describe('verifyTotp', () => {
    const now = 1_700_000_015_000;
    const step = stepAt(now);
    const codeAt = (offset: number) => hotp(RFC_SECRET, step + offset);

    it('accepts the current code and one step either side, and says which step matched', () => {
      expect(verifyTotp(RFC_SECRET_BASE32, codeAt(0), now, null)).toBe(step);
      expect(verifyTotp(RFC_SECRET_BASE32, codeAt(-1), now, null)).toBe(step - 1);
      expect(verifyTotp(RFC_SECRET_BASE32, codeAt(1), now, null)).toBe(step + 1);
    });

    it('refuses a code two steps away', () => {
      expect(verifyTotp(RFC_SECRET_BASE32, codeAt(-2), now, null)).toBeNull();
      expect(verifyTotp(RFC_SECRET_BASE32, codeAt(2), now, null)).toBeNull();
    });

    it('refuses a code already used — no replay inside its window', () => {
      expect(verifyTotp(RFC_SECRET_BASE32, codeAt(0), now, step)).toBeNull();
      expect(verifyTotp(RFC_SECRET_BASE32, codeAt(-1), now, step - 1)).toBeNull();
      // the next step is still fine
      expect(verifyTotp(RFC_SECRET_BASE32, codeAt(1), now, step)).toBe(step + 1);
    });

    it('refuses anything that isn’t six digits, and tolerates spaces in a typed code', () => {
      expect(verifyTotp(RFC_SECRET_BASE32, '12345', now, null)).toBeNull();
      expect(verifyTotp(RFC_SECRET_BASE32, 'abcdef', now, null)).toBeNull();
      const spaced = `${codeAt(0).slice(0, 3)} ${codeAt(0).slice(3)}`;
      expect(verifyTotp(RFC_SECRET_BASE32, spaced, now, null)).toBe(step);
    });
  });

  it('builds the link an authenticator app scans', () => {
    const uri = otpauthUri('Roomick', 'gm@lekki.example', RFC_SECRET_BASE32);
    expect(uri.startsWith('otpauth://totp/Roomick:gm%40lekki.example?')).toBe(true);
    const params = new URLSearchParams(uri.split('?')[1]);
    expect(Object.fromEntries(params)).toEqual({ secret: RFC_SECRET_BASE32, issuer: 'Roomick', algorithm: 'SHA1', digits: '6', period: '30' });
  });

  describe('recovery codes', () => {
    it('makes ten distinct, readable codes', () => {
      const codes = generateRecoveryCodes();
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      expect(codes.every((code) => /^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/.test(code))).toBe(true);
    });

    it('hashes a code the same however it is typed', () => {
      expect(hashRecoveryCode('abcde-fghjk')).toBe(hashRecoveryCode(' ABCDE FGHJK '));
      expect(hashRecoveryCode('abcde-fghjk')).not.toBe(hashRecoveryCode('abcde-fghjm'));
      expect(looksLikeRecoveryCode('ABCDE-fghjk')).toBe(true);
      expect(looksLikeRecoveryCode('123456')).toBe(false);
    });
  });
});
