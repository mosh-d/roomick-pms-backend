-- Group check-in's master bill: a stay's room nights can be billed to another bill — the group's,
-- paid by its organiser — while incidentals stay on the guest's own. Nothing set: billed as before.
ALTER TABLE "reservations" ADD COLUMN "billToFolioId" UUID;

ALTER TABLE "reservations" ADD CONSTRAINT "reservations_billToFolioId_fkey" FOREIGN KEY ("billToFolioId") REFERENCES "folios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
