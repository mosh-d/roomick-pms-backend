-- Refunds & Corrections: a refund is requested, approved by a manager (or requested by one), then paid
-- out as a negative payment by the method it goes back by. Nothing wrote refunds before this, so the
-- table is empty; the default only covers a row that might exist and is dropped straight after.
ALTER TABLE "refunds" ADD COLUMN "method" "payment_method_enum" NOT NULL DEFAULT 'cash',
ADD COLUMN "processedBy" UUID,
ADD COLUMN "refundPaymentId" UUID,
ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "refunds" ALTER COLUMN "method" DROP DEFAULT;

-- Refunds are money out: always a positive amount, paid back as a negative payment.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0);

CREATE UNIQUE INDEX "refunds_refundPaymentId_key" ON "refunds"("refundPaymentId");
CREATE INDEX "refunds_status_idx" ON "refunds"("status");

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_refundPaymentId_fkey" FOREIGN KEY ("refundPaymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_processedBy_fkey" FOREIGN KEY ("processedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
