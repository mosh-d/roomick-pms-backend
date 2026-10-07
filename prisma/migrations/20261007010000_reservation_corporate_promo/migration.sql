-- A reservation keeps the company it's booked under and the promo code it was
-- booked with, so re-pricing it (modify, extend stay) keeps the deal.
ALTER TABLE "reservations" ADD COLUMN "corporateAccountId" UUID,
ADD COLUMN "promoCode" VARCHAR(50);

ALTER TABLE "reservations" ADD CONSTRAINT "reservations_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "reservations_corporateAccountId_idx" ON "reservations"("corporateAccountId");
