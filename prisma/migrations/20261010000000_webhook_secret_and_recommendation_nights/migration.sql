-- Webhook signing secrets are stored encrypted now ("iv:tag:ciphertext", about 150
-- characters for a 48-character secret). Secrets already stored in plain text are
-- encrypted by the API itself at its next start (IntegrationsService), since the key
-- lives with the application, not the database.
ALTER TABLE "webhooks" ALTER COLUMN "secret" TYPE VARCHAR(255);

-- An approved rate recommendation is one night. It was saved ending the day after,
-- and a plan's "validTo" is the last night it prices, so it priced the next night
-- too. Shorten the ones already approved. rate_plans is under FORCE ROW LEVEL
-- SECURITY, so each organisation is done in its own app.tenant_id (tenants has no RLS).
DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT "id" FROM "tenants" LOOP
        PERFORM set_config('app.tenant_id', t."id"::text, true);
        UPDATE "rate_plans"
        SET "validTo" = "validFrom"
        WHERE "tenantId" = t."id"
          AND "type" = 'seasonal'
          AND "name" LIKE 'Rate Recommendation — %'
          AND "validFrom" IS NOT NULL
          AND "validTo" = "validFrom" + 1;
    END LOOP;
END $$;
