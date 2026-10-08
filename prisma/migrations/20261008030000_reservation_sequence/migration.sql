-- One confirmation-number counter per organisation. Numbers used to be counted per
-- branch while being unique per tenant, so a second branch's first booking collided
-- with the first branch's numbers and failed once that branch had five bookings.
ALTER TABLE "tenants" ADD COLUMN "reservationSeq" INTEGER NOT NULL DEFAULT 0;

-- Start each counter past the highest number the organisation has already used.
-- reservations has FORCE ROW LEVEL SECURITY, so the tenant is set per iteration.
DO $$
DECLARE
  t RECORD;
  highest INTEGER;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    SELECT coalesce(max((regexp_match("confirmationNumber", '(\d+)$'))[1]::int), 0)
      INTO highest
      FROM reservations
      WHERE "tenantId" = t.id;
    UPDATE tenants SET "reservationSeq" = highest WHERE id = t.id;
  END LOOP;
END $$;
