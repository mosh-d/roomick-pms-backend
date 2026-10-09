-- The two new kinds of points row (added in the previous migration, which
-- has to commit before a constraint can name them): points given back when
-- the payment they made is voided, and points that lapse unspent. Each still
-- carries exactly its own link — neither links a stay or a payment.
ALTER TABLE "loyalty_transactions" DROP CONSTRAINT "loyalty_transactions_shape";
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_shape" CHECK (
    ("type" = 'earn' AND "points" > 0 AND "earnReservationId" IS NOT NULL AND "paymentId" IS NULL)
    OR ("type" = 'redeem' AND "points" < 0 AND "paymentId" IS NOT NULL AND "earnReservationId" IS NULL)
    OR ("type" = 'adjust' AND "points" <> 0 AND "earnReservationId" IS NULL AND "paymentId" IS NULL)
    OR ("type" = 'reversal' AND "points" > 0 AND "earnReservationId" IS NULL AND "paymentId" IS NULL)
    OR ("type" = 'expire' AND "points" < 0 AND "earnReservationId" IS NULL AND "paymentId" IS NULL)
);

-- Only an earning can lapse.
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_expiry_on_earnings" CHECK ("expiresAt" IS NULL OR "type" = 'earn');
