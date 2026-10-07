-- Refresh tokens become server-side sessions: stored as a SHA-256 hash,
-- rotated on every renewal, revoked on sign-out. Refresh tokens issued before
-- this have no row and are refused — everyone signs in once more.
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "refresh_tokens"
    USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
