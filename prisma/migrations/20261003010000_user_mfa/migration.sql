-- Growth plan Month 12: two-step sign-in (TOTP / authenticator app) for staff.
--
-- mfaSecret          the shared secret, AES-256-GCM encrypted by the app (never stored plain). It is
--                    written when setup starts and only becomes active once mfaEnabledAt is set by
--                    the user entering a first valid code — so a half-finished setup locks nobody out.
-- mfaLastUsedStep    the 30-second time step of the last accepted code, so a code can't be replayed.
-- mfaFailedAttempts / mfaLockedUntil   a short lock after repeated wrong codes; six digits are only a
--                    million guesses, and the per-IP throttle alone doesn't stop a distributed attempt.
-- mfaRecoveryCodes   SHA-256 of each unused one-time recovery code; a used code is removed.
ALTER TABLE "users"
    ADD COLUMN "mfaSecret" TEXT,
    ADD COLUMN "mfaEnabledAt" TIMESTAMPTZ(6),
    ADD COLUMN "mfaLastUsedStep" INTEGER,
    ADD COLUMN "mfaFailedAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "mfaLockedUntil" TIMESTAMPTZ(6),
    ADD COLUMN "mfaRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Two-step sign-in can't be on without a secret to check codes against.
ALTER TABLE "users" ADD CONSTRAINT "users_mfa_enabled_has_secret" CHECK ("mfaEnabledAt" IS NULL OR "mfaSecret" IS NOT NULL);
ALTER TABLE "users" ADD CONSTRAINT "users_mfa_failed_attempts_non_negative" CHECK ("mfaFailedAttempts" >= 0);
