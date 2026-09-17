-- Growth plan Month 11: the loyalty programme.
--   loyalty_programs      one per tenant: earning rate, point value, tiers and their benefits
--   loyalty_transactions  the points ledger, append-only: an earn row once per stay, a redeem row tied to
--                         the folio payment it became, an adjust row with a manager's reason
--   guest_profiles.loyaltyEnrolledAt — membership. loyaltyPoints stays as the balance, now kept in step
--                         with the ledger in the same transaction as every row.

CREATE TYPE "loyalty_tx_type_enum" AS ENUM ('earn', 'redeem', 'adjust');

ALTER TABLE "guest_profiles" ADD COLUMN "loyaltyEnrolledAt" TIMESTAMPTZ(6);

CREATE TABLE "loyalty_programs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "currency" CHAR(3) NOT NULL,
    "pointsPerUnit" DECIMAL(10,4) NOT NULL,
    "pointValue" DECIMAL(12,4) NOT NULL,
    "tiers" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID,
    CONSTRAINT "loyalty_programs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "loyalty_programs_rates_positive" CHECK ("pointsPerUnit" > 0 AND "pointValue" > 0)
);

CREATE TABLE "loyalty_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "branchId" UUID,
    "type" "loyalty_tx_type_enum" NOT NULL,
    "points" INTEGER NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "earnReservationId" UUID,
    "paymentId" UUID,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "loyalty_transactions_pkey" PRIMARY KEY ("id"),
    -- Each kind of row carries exactly its own link: an earn its stay, a redemption its payment, an adjustment neither.
    CONSTRAINT "loyalty_transactions_shape" CHECK (
        ("type" = 'earn' AND "points" > 0 AND "earnReservationId" IS NOT NULL AND "paymentId" IS NULL)
        OR ("type" = 'redeem' AND "points" < 0 AND "paymentId" IS NOT NULL AND "earnReservationId" IS NULL)
        OR ("type" = 'adjust' AND "points" <> 0 AND "earnReservationId" IS NULL AND "paymentId" IS NULL)
    )
);

CREATE UNIQUE INDEX "loyalty_programs_tenantId_key" ON "loyalty_programs"("tenantId");
CREATE UNIQUE INDEX "loyalty_transactions_earnReservationId_key" ON "loyalty_transactions"("earnReservationId");
CREATE UNIQUE INDEX "loyalty_transactions_paymentId_key" ON "loyalty_transactions"("paymentId");
CREATE INDEX "loyalty_transactions_guestId_createdAt_idx" ON "loyalty_transactions"("guestId", "createdAt");

ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guest_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_earnReservationId_fkey" FOREIGN KEY ("earnReservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant isolation, same policy as every other tenant table.
ALTER TABLE "loyalty_programs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "loyalty_programs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "loyalty_programs"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "loyalty_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "loyalty_transactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "loyalty_transactions"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

-- Points already typed onto guest profiles become each guest's opening ledger row, so the ledger and
-- the balance agree from the start, and anyone with a tier or points is a member. guest_profiles is
-- under FORCE ROW LEVEL SECURITY and this role doesn't bypass it, so each tenant is carried over with
-- its own app.tenant_id (tenants itself has no RLS). set_config(..., true) lasts only for this migration.
DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT "id" FROM "tenants" LOOP
        PERFORM set_config('app.tenant_id', t."id"::text, true);
        INSERT INTO "loyalty_transactions" ("tenantId", "guestId", "type", "points", "description")
        SELECT "tenantId", "id", 'adjust'::"loyalty_tx_type_enum", "loyaltyPoints", 'Opening balance — carried over from the guest profile'
        FROM "guest_profiles"
        WHERE "tenantId" = t."id" AND "deletedAt" IS NULL AND "loyaltyPoints" > 0;
        UPDATE "guest_profiles" SET "loyaltyEnrolledAt" = CURRENT_TIMESTAMP
        WHERE "tenantId" = t."id" AND "deletedAt" IS NULL AND ("loyaltyTier" IS NOT NULL OR "loyaltyPoints" > 0);
    END LOOP;
END $$;
