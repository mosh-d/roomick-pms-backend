-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "groupBlockId" UUID;

-- CreateTable
CREATE TABLE "group_blocks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "blockSize" INTEGER NOT NULL,
    "blockRate" DECIMAL(12,2) NOT NULL,
    "cutoffDate" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,

    CONSTRAINT "group_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_spaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_bookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "eventSpaceId" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6) NOT NULL,
    "contactName" VARCHAR(200),
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,

    CONSTRAINT "event_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_blocks_tenantId_branchId_idx" ON "group_blocks"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "event_spaces_tenantId_branchId_idx" ON "event_spaces"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "event_bookings_eventSpaceId_startsAt_idx" ON "event_bookings"("eventSpaceId", "startsAt");

-- CreateIndex
CREATE INDEX "reservations_groupBlockId_idx" ON "reservations"("groupBlockId");

-- AddForeignKey
ALTER TABLE "group_blocks" ADD CONSTRAINT "group_blocks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_blocks" ADD CONSTRAINT "group_blocks_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_blocks" ADD CONSTRAINT "group_blocks_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_spaces" ADD CONSTRAINT "event_spaces_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_spaces" ADD CONSTRAINT "event_spaces_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_eventSpaceId_fkey" FOREIGN KEY ("eventSpaceId") REFERENCES "event_spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_groupBlockId_fkey" FOREIGN KEY ("groupBlockId") REFERENCES "group_blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: not automatic for a new table — the original
-- 20260712000001_rls_and_constraints migration only loops over the
-- table names that existed at P0.
ALTER TABLE "group_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "group_blocks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "group_blocks" USING ("tenantId" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "event_spaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event_spaces" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_spaces" USING ("tenantId" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "event_bookings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event_bookings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "event_bookings" USING ("tenantId" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
