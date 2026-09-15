-- Growth plan Month 8 leftovers.
--   group_blocks      the group's stay dates and contact. An active block with dates now HOLDS rooms
--                     out of general availability until its cut-off (computed at read time — no job).
--   event_spaces      seats per layout
--   event_bookings    the Banquet Event Order's details: layout, headcount, contact, catering, AV
--   competitors,
--   competitor_rates  the comp set, entered by hand

ALTER TABLE "event_bookings" ADD COLUMN "avRequirements" TEXT,
ADD COLUMN "catering" JSONB,
ADD COLUMN "contactEmail" VARCHAR(320),
ADD COLUMN "contactPhone" VARCHAR(30),
ADD COLUMN "headcount" INTEGER,
ADD COLUMN "setupStyle" VARCHAR(20);
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_headcount_positive" CHECK ("headcount" IS NULL OR "headcount" > 0);

ALTER TABLE "event_spaces" ADD COLUMN "setupCapacities" JSONB;

ALTER TABLE "group_blocks" ADD COLUMN "arrivalDate" DATE,
ADD COLUMN "contactEmail" VARCHAR(320),
ADD COLUMN "contactName" VARCHAR(200),
ADD COLUMN "contactPhone" VARCHAR(30),
ADD COLUMN "departureDate" DATE;
-- Both stay dates or neither (blocks made before holds have neither); the stay ends after it
-- starts; the cut-off falls on or before arrival.
ALTER TABLE "group_blocks" ADD CONSTRAINT "group_blocks_stay_dates" CHECK (
    ("arrivalDate" IS NULL AND "departureDate" IS NULL)
    OR ("arrivalDate" IS NOT NULL AND "departureDate" IS NOT NULL AND "departureDate" > "arrivalDate" AND "cutoffDate" <= "arrivalDate")
);
CREATE INDEX "group_blocks_branchId_roomTypeId_status_idx" ON "group_blocks"("branchId", "roomTypeId", "status");

CREATE TABLE "competitors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "competitor_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "competitorId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "stayDate" DATE NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "enteredBy" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "competitor_rates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "competitor_rates_rate_non_negative" CHECK ("rate" >= 0)
);

CREATE INDEX "competitors_branchId_idx" ON "competitors"("branchId");
CREATE INDEX "competitor_rates_roomTypeId_stayDate_idx" ON "competitor_rates"("roomTypeId", "stayDate");
CREATE UNIQUE INDEX "competitor_rates_competitorId_roomTypeId_stayDate_key" ON "competitor_rates"("competitorId", "roomTypeId", "stayDate");

ALTER TABLE "competitors" ADD CONSTRAINT "competitors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_rates" ADD CONSTRAINT "competitor_rates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_rates" ADD CONSTRAINT "competitor_rates_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_rates" ADD CONSTRAINT "competitor_rates_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, same policy as every other tenant table.
ALTER TABLE "competitors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "competitors" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "competitors"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "competitor_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "competitor_rates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "competitor_rates"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
