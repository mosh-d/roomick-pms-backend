-- confirmationNumber was globally UNIQUE, but generated from a per-branch
-- local counter (see reservations.service.ts generateConfirmationNumber).
-- On a DB with many tenants, a low-activity branch's first few candidates
-- (RES-2026-00001, 00002, ...) reliably already belonged to some OTHER
-- tenant. Worse: the collision-check that was supposed to catch this ran
-- under the caller's own tenant context, so RLS hid the other tenant's row
-- from it entirely — every "verified free" candidate then failed on the
-- real insert anyway. Scoping uniqueness to (tenantId, confirmationNumber)
-- matches what the number was always meant to mean ("sequence per branch")
-- and keeps the check tenant-visible.
DROP INDEX "reservations_confirmationNumber_key";

CREATE UNIQUE INDEX "reservations_tenantId_confirmationNumber_key" ON "reservations"("tenantId", "confirmationNumber");
