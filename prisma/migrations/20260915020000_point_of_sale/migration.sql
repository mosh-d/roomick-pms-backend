-- Growth plan Month 10: Point of Sale.
--   menu_items  — what each outlet sells (soft-deleted, so past orders' snapshots still read sensibly)
--   pos_orders  — every sale at an outlet, however it was settled: the outlet's own sales ledger.
--                 A room charge also becomes one line on the guest's folio (lineItemId);
--                 a cash sale counts toward the cashier's shift drawer (shiftId).

CREATE TYPE "pos_settlement_enum" AS ENUM ('room', 'cash', 'card');

CREATE TABLE "menu_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "modifiers" JSONB,
    "sortOrder" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "menu_items_price_non_negative" CHECK ("price" >= 0)
);

CREATE TABLE "pos_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "outletId" UUID NOT NULL,
    "orderNo" INTEGER NOT NULL,
    "settlement" "pos_settlement_enum" NOT NULL,
    "tableNumber" VARCHAR(20),
    "items" JSONB NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "taxTotal" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reservationId" UUID,
    "folioId" UUID,
    "lineItemId" UUID,
    "shiftId" UUID,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMPTZ(6),
    "voidedBy" UUID,
    "voidReason" VARCHAR(500),
    CONSTRAINT "pos_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pos_orders_amounts_non_negative" CHECK ("subtotal" >= 0 AND "taxTotal" >= 0 AND "total" = "subtotal" + "taxTotal"),
    -- A room charge always knows whose bill it went on; a cash or card sale never touches a folio.
    CONSTRAINT "pos_orders_room_settlement_links" CHECK (
        ("settlement" = 'room' AND "reservationId" IS NOT NULL AND "folioId" IS NOT NULL AND "lineItemId" IS NOT NULL)
        OR ("settlement" <> 'room' AND "reservationId" IS NULL AND "folioId" IS NULL AND "lineItemId" IS NULL)
    )
);

CREATE INDEX "menu_items_outletId_category_idx" ON "menu_items"("outletId", "category");
CREATE UNIQUE INDEX "pos_orders_lineItemId_key" ON "pos_orders"("lineItemId");
CREATE INDEX "pos_orders_branchId_createdAt_idx" ON "pos_orders"("branchId", "createdAt");
CREATE INDEX "pos_orders_shiftId_idx" ON "pos_orders"("shiftId");
CREATE UNIQUE INDEX "pos_orders_outletId_orderNo_key" ON "pos_orders"("outletId", "orderNo");

ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "line_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation, same policy as every other tenant table.
ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "menu_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "menu_items"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "pos_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pos_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pos_orders"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
