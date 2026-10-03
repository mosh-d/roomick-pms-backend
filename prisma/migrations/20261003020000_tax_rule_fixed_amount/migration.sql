-- Tax rules can be a fixed amount as well as a percentage — the reference's own example is
-- "₦500 city tax per night". `rate` is DECIMAL(6,4), sized for percentages (0.075 = 7.5%), so it
-- can't carry an amount like 500; a fixed rule keeps rate = 0 and puts its amount here.
--
-- A fixed rule is added once per charge. Room nights are posted one line per night, so on
-- rooms that is once per night — and the Rate Resolver multiplies by the number of nights when
-- it quotes a stay, so the quote matches what the nights will actually post.
ALTER TABLE "tax_rules" ADD COLUMN "fixedAmount" DECIMAL(12,2);

-- Each rule is exactly one kind: a percentage between 0% and 100% with no amount, or a positive
-- amount with no percentage. Every existing rule is a percentage with no amount, so this holds.
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_kind_shape" CHECK (
    ("type" = 'percentage' AND "fixedAmount" IS NULL AND "rate" >= 0 AND "rate" <= 1)
    OR ("type" = 'fixed' AND "fixedAmount" > 0 AND "rate" = 0)
);
