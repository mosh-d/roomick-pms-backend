-- AlterEnum
ALTER TYPE "reservation_channel_enum" ADD VALUE 'website';

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "dayUsePolicy" JSONB;

-- AlterTable
ALTER TABLE "line_items" ADD COLUMN     "dayUse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "packageId" UUID,
ADD COLUMN     "roomTypeId" UUID;

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "isDayUse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "packages" JSONB;

-- AlterTable
ALTER TABLE "room_types" ADD COLUMN     "adultsIncluded" SMALLINT,
ADD COLUMN     "childRate" DECIMAL(12,2),
ADD COLUMN     "childrenIncluded" SMALLINT NOT NULL DEFAULT 0,
ADD COLUMN     "dayUseRate" DECIMAL(12,2),
ADD COLUMN     "extraAdultRate" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "packages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "basis" VARCHAR(20) NOT NULL,
    "chargeType" "charge_type_enum" NOT NULL,
    "roomTypeIds" UUID[],
    "showOnline" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_allotments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "roomTypeId" UUID NOT NULL,
    "channel" "reservation_channel_enum" NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "rooms" SMALLINT NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_allotments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "packages_branchId_isActive_idx" ON "packages"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "channel_allotments_branchId_roomTypeId_channel_fromDate_idx" ON "channel_allotments"("branchId", "roomTypeId", "channel", "fromDate");

-- CreateIndex
CREATE INDEX "channel_allotments_roomTypeId_idx" ON "channel_allotments"("roomTypeId");

-- CreateIndex
CREATE INDEX "line_items_roomTypeId_idx" ON "line_items"("roomTypeId");

-- CreateIndex
CREATE INDEX "line_items_packageId_idx" ON "line_items"("packageId");

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_allotments" ADD CONSTRAINT "channel_allotments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_allotments" ADD CONSTRAINT "channel_allotments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_allotments" ADD CONSTRAINT "channel_allotments_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the new figures may hold.
ALTER TABLE "packages" ADD CONSTRAINT "packages_basis" CHECK ("basis" IN ('per_night', 'per_stay', 'per_person_per_night'));
ALTER TABLE "packages" ADD CONSTRAINT "packages_price_not_negative" CHECK ("price" >= 0);
ALTER TABLE "channel_allotments" ADD CONSTRAINT "channel_allotments_rooms_not_negative" CHECK ("rooms" >= 0);
ALTER TABLE "channel_allotments" ADD CONSTRAINT "channel_allotments_dates" CHECK ("toDate" >= "fromDate");
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_occupancy_pricing" CHECK (
  ("adultsIncluded" IS NULL OR "adultsIncluded" >= 1)
  AND "childrenIncluded" >= 0
  AND ("extraAdultRate" IS NULL OR "extraAdultRate" >= 0)
  AND ("childRate" IS NULL OR "childRate" >= 0)
  AND ("dayUseRate" IS NULL OR "dayUseRate" > 0)
);
-- A stay leaves after it arrives — or, for day use, the same day, and only then.
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_dates_check";
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_dates_check" CHECK (
  ("checkOutDate" > "checkInDate" AND NOT "isDayUse") OR ("isDayUse" AND "checkOutDate" = "checkInDate")
) NOT VALID;

-- Tenant isolation, the same policy as every other tenant table.
ALTER TABLE "packages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "packages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "packages"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "channel_allotments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_allotments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "channel_allotments"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The room type each night already billed was sold as: the stay's own type
-- is the best record there is of it. Tenant by tenant — the line items are
-- under row-level security, and a statement outside a tenant sees none.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE "line_items" li
       SET "roomTypeId" = r."roomTypeId"
      FROM "reservations" r
     WHERE li."stayReservationId" = r."id"
       AND li."chargeType" = 'room'
       AND li."roomTypeId" IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
