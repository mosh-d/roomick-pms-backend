-- Guest phones as digits, for search and matching (audit M12, M3). A phone search
-- used to run regexp_replace over every guest on every keystroke; this column holds
-- the digits once, and the trigram index answers "contains these digits" from the index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER TABLE "guest_profiles" ADD COLUMN "phoneDigits" VARCHAR(20);

-- guest_profiles has FORCE ROW LEVEL SECURITY, so the tenant is set per iteration.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE "guest_profiles"
      SET "phoneDigits" = NULLIF(regexp_replace(phone, '[^0-9]', '', 'g'), '')
      WHERE "tenantId" = t.id AND phone IS NOT NULL;
  END LOOP;
END $$;

CREATE INDEX "guest_profiles_phoneDigits_idx" ON "guest_profiles" USING GIN ("phoneDigits" gin_trgm_ops);

-- Each night's own rate on the stay (audit M1). Nights used to be billed as the stay
-- total split evenly, so a stay quoted 30,000 + 45,000 billed as two nights of 37,500.
ALTER TABLE "reservations" ADD COLUMN "nightlyRates" JSONB;
