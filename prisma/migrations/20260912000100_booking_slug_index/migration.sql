-- The pre-auth lookup table for the Direct Booking Engine.
--
-- `branches` has FORCE ROW LEVEL SECURITY, so resolving a public booking slug
-- against it directly returns zero rows: a booking-engine request arrives
-- completely unauthenticated, with no `app.tenant_id` to set. This mirrors
-- `user_email_index` exactly — the same problem login already had ("which
-- tenant owns this email?") and the same solution.
--
-- DELIBERATELY NOT RLS-SCOPED, same category as tenants / user_email_index /
-- feature_flags / backup_records. It holds nothing but the pointer itself:
-- no rates, no guest data, no property detail. Everything real still lives on
-- the RLS-protected `branches` row, which PublicBookingService re-loads and
-- re-authorizes inside withTenant() before serving anything.
CREATE TABLE "booking_slug_index" (
    "slug" VARCHAR(63) NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "booking_slug_index_pkey" PRIMARY KEY ("slug")
);

-- Supports unpublish/slug-change, which delete by branch rather than by slug.
CREATE INDEX "booking_slug_index_branchId_idx" ON "booking_slug_index"("branchId");
