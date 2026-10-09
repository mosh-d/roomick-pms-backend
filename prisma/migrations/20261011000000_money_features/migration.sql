-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "depositPolicy" JSONB,
ADD COLUMN     "invoiceSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stayFeePolicy" JSONB;

-- AlterTable
ALTER TABLE "corporate_accounts" ADD COLUMN     "paymentTermsDays" SMALLINT;

-- AlterTable
ALTER TABLE "event_bookings" ADD COLUMN     "billedAt" TIMESTAMPTZ(6),
ADD COLUMN     "billedBy" UUID,
ADD COLUMN     "folioId" UUID,
ADD COLUMN     "spaceHireFee" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "exchangeRate" DECIMAL(18,6),
ADD COLUMN     "foreignAmount" DECIMAL(14,2),
ADD COLUMN     "foreignCurrency" CHAR(3);

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "depositDueDate" DATE;

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "updatedBy" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "folioId" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "billTo" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "totals" JSONB NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "dueDate" DATE,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedBy" UUID,
    "supersedesId" UUID,
    "supersededAt" TIMESTAMPTZ(6),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_branchId_currency_key" ON "exchange_rates"("branchId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_supersedesId_key" ON "invoices"("supersedesId");

-- CreateIndex
CREATE INDEX "invoices_folioId_idx" ON "invoices"("folioId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_branchId_number_key" ON "invoices"("branchId", "number");

-- CreateIndex
CREATE INDEX "event_bookings_folioId_idx" ON "event_bookings"("folioId");

-- AddForeignKey
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A rate is a positive number of the branch's currency per unit; a foreign
-- payment carries all three of its figures or none.
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_rate_positive" CHECK ("rate" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_foreign_all_or_none" CHECK (
  ("foreignCurrency" IS NULL AND "foreignAmount" IS NULL AND "exchangeRate" IS NULL)
  OR ("foreignCurrency" IS NOT NULL AND "foreignAmount" IS NOT NULL AND "exchangeRate" > 0)
);

-- Tenant isolation, the same policy as every other tenant table.
ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exchange_rates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "exchange_rates"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoices"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Cash in other currencies, counted apart at a shift's close.
ALTER TABLE "shifts" ADD COLUMN "foreignCashTotals" JSONB;

-- Loyalty points that lapse: how long earned points last, when each earning
-- lapses, and the ledger rows that take lapsed points off.
ALTER TYPE "loyalty_tx_type_enum" ADD VALUE 'expire';
ALTER TYPE "loyalty_tx_type_enum" ADD VALUE 'reversal';
ALTER TABLE "loyalty_programs" ADD COLUMN "pointsExpireAfterMonths" SMALLINT;
ALTER TABLE "loyalty_transactions" ADD COLUMN "expiresAt" TIMESTAMPTZ(6);
