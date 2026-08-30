-- CreateTable
CREATE TABLE "availability_restrictions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "roomTypeId" UUID,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "minLOS" SMALLINT,
    "maxLOS" SMALLINT,
    "closedToArrival" BOOLEAN NOT NULL DEFAULT false,
    "stopSell" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,

    CONSTRAINT "availability_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "availability_restrictions_tenantId_branchId_startDate_endDa_idx" ON "availability_restrictions"("tenantId", "branchId", "startDate", "endDate");

-- AddForeignKey
ALTER TABLE "availability_restrictions" ADD CONSTRAINT "availability_restrictions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_restrictions" ADD CONSTRAINT "availability_restrictions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_restrictions" ADD CONSTRAINT "availability_restrictions_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: not automatic for a new table — the original
-- 20260712000001_rls_and_constraints migration only loops over the
-- table names that existed at P0.
ALTER TABLE "availability_restrictions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "availability_restrictions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "availability_restrictions" USING ("tenantId" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
