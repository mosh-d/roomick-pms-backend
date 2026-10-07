-- Getting staff and owners in and back in, and what guests are told.

-- The privacy notice and booking terms shown on a property's booking pages,
-- and when a guest booking online accepted them.
ALTER TABLE "branches" ADD COLUMN "privacyNotice" TEXT,
ADD COLUMN "bookingTerms" TEXT;
ALTER TABLE "reservations" ADD COLUMN "termsAcceptedAt" TIMESTAMPTZ(6);

-- How long registration cards and guest ID documents are kept after a stay (months; NULL keeps them),
-- and when a card's personal details were removed.
ALTER TABLE "tenants" ADD COLUMN "documentRetentionMonths" SMALLINT;
ALTER TABLE "registration_cards" ADD COLUMN "purgedAt" TIMESTAMPTZ(6);

-- Links to set a new password: emailed on request, or made by an owner or manager. Hash only.
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, same policy as every other tenant table.
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "password_reset_tokens"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
