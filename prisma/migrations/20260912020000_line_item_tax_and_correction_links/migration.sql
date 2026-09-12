-- Link each tax line to the charge it was computed on, and each reversal to
-- the line it reverses.
--
-- Found through the guest bill view: correcting a charge negated only the
-- charge line and left its VAT standing — a guest who returned a ₦5,000
-- minibar item still owed ₦375 in tax on it. With no link between a charge
-- and its tax lines, the correction had no reliable way to find them
-- (description text is the only other connection, and it's truncated at 300
-- characters). The same missing link let a folio split move a charge to
-- another bill while its VAT stayed behind.
--
-- parentLineItemId  — tax lines only. Set by FoliosService.writeChargeWithTaxes.
-- correctsLineItemId — reversal lines only. UNIQUE, so a line can be corrected
--                      once; a second correction would reverse a charge (and
--                      now its tax) twice. NULLs don't collide in Postgres, so
--                      every ordinary line is unaffected.
--
-- No backfill. Tax lines posted before this migration keep a NULL parent;
-- correcting one of those older charges reverses the charge only, as before,
-- and staff correct its tax line separately. (Only local/test data exists at
-- the time of writing — nothing is deployed.)
--
-- No RLS statements needed: line_items already has RLS enabled with the
-- tenant_isolation policy, and new columns inherit it. Both foreign keys are
-- self-references within the same table and tenant.
ALTER TABLE "line_items"
  ADD COLUMN "parentLineItemId" UUID,
  ADD COLUMN "correctsLineItemId" UUID;

CREATE UNIQUE INDEX "line_items_correctsLineItemId_key" ON "line_items"("correctsLineItemId");
CREATE INDEX "line_items_parentLineItemId_idx" ON "line_items"("parentLineItemId");

ALTER TABLE "line_items" ADD CONSTRAINT "line_items_parentLineItemId_fkey"
  FOREIGN KEY ("parentLineItemId") REFERENCES "line_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_correctsLineItemId_fkey"
  FOREIGN KEY ("correctsLineItemId") REFERENCES "line_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
