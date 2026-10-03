-- Tax rules can be included in the price (VAT-inclusive rates) instead of added on top.
ALTER TABLE "tax_rules" ADD COLUMN "inclusive" BOOLEAN NOT NULL DEFAULT false;

-- A no-show record points at the penalty charge it posted, so waiving it
-- reverses that charge and exactly the taxes posted with it. Older records
-- stay NULL; the waiver finds their penalty line by its description instead.
ALTER TABLE "no_show_records" ADD COLUMN "penaltyLineItemId" UUID;
ALTER TABLE "no_show_records" ADD CONSTRAINT "no_show_records_penaltyLineItemId_fkey" FOREIGN KEY ("penaltyLineItemId") REFERENCES "line_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
