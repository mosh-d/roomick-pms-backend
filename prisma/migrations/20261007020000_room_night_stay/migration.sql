-- Room nights record the stay they were for. A night's room charge can move to another bill —
-- split onto a company folio, or transferred to another room's bill — and check-out's backfill,
-- which looked for each night on the stay's own primary folio only, billed a moved night again.
ALTER TABLE "line_items" ADD COLUMN "stayReservationId" UUID;

CREATE INDEX "line_items_stayReservationId_serviceDate_idx" ON "line_items"("stayReservationId", "serviceDate");

ALTER TABLE "line_items" ADD CONSTRAINT "line_items_stayReservationId_fkey" FOREIGN KEY ("stayReservationId") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Until now a room charge could only move between folios of its own stay, so the folio's
-- reservation is the stay of every room line already posted. line_items and folios are under
-- FORCE ROW LEVEL SECURITY, so each tenant is carried over with its own app.tenant_id.
DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT "id" FROM "tenants" LOOP
        PERFORM set_config('app.tenant_id', t."id"::text, true);
        UPDATE "line_items" li
        SET "stayReservationId" = f."reservationId"
        FROM "folios" f
        WHERE li."folioId" = f."id"
          AND li."tenantId" = t."id"
          AND li."chargeType" = 'room'
          AND li."serviceDate" IS NOT NULL;
    END LOOP;
END $$;
