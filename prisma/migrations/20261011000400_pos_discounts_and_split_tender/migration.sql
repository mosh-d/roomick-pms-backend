-- AlterEnum
ALTER TYPE "pos_settlement_enum" ADD VALUE 'split';

-- AlterTable
ALTER TABLE "outlets" ADD COLUMN     "staffDiscountLimitPct" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "pos_orders" ADD COLUMN     "cardAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cashAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "discountReason" VARCHAR(300),
ADD COLUMN     "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- What every sale so far took, cash or card. pos_orders is under FORCE ROW
-- LEVEL SECURITY, so each tenant is carried over with its own app.tenant_id
-- (tenants itself has no RLS). set_config(..., true) lasts only for this migration.
DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT "id" FROM "tenants" LOOP
        PERFORM set_config('app.tenant_id', t."id"::text, true);
        UPDATE "pos_orders" SET "cashAmount" = "total" WHERE "tenantId" = t."id" AND "settlement" = 'cash';
        UPDATE "pos_orders" SET "cardAmount" = "total" WHERE "tenantId" = t."id" AND "settlement" = 'card';
    END LOOP;
END $$;

-- A sale paid at the outlet took exactly its total, in its parts; a room charge took nothing there.
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_takings_add_up" CHECK (
    "cashAmount" >= 0 AND "cardAmount" >= 0
    AND CASE WHEN "settlement" = 'room' THEN "cashAmount" = 0 AND "cardAmount" = 0 ELSE "cashAmount" + "cardAmount" = "total" END
) NOT VALID;

-- A discount is never negative, and never given without a reason.
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_discount_reason" CHECK ("discountTotal" >= 0 AND ("discountTotal" = 0 OR "discountReason" IS NOT NULL)) NOT VALID;

-- A staff limit is a percentage.
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_staff_discount_limit" CHECK ("staffDiscountLimitPct" IS NULL OR ("staffDiscountLimitPct" >= 0 AND "staffDiscountLimitPct" <= 100));
