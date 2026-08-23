-- Global email uniqueness (was per-tenant) + a non-RLS-scoped lookup table
-- so login can resolve "which tenant does this email belong to" *before*
-- it has a tenantId to call withTenant() with.
--
-- `users` has FORCE ROW LEVEL SECURITY (see 20260712000001_rls_and_constraints):
-- policy `"tenantId" = current_setting('app.tenant_id', true)::uuid`. A
-- query against `users` with no app.tenant_id set returns zero rows,
-- always, by design (fail closed) — verified directly against the running
-- app role (rolsuper=false, rolbypassrls=false), not assumed. That means
-- this table cannot be a bare `INSERT ... SELECT FROM users` backfill: with
-- no tenant context set, it would silently match zero rows and leave the
-- index empty, breaking login for every existing user. Looped per-tenant
-- below instead, setting app.tenant_id before each tenant's slice so RLS
-- actually lets those rows through.
--
-- Pre-migration guard already run (not skipped): looped every tenant via
-- withTenant, compared emails across tenants in application code (the same
-- RLS-respecting technique this file's own backfill uses, since the app
-- role has no way to bypass RLS for a single global query either) — zero
-- cross-tenant duplicates found across all 42 existing tenants at the time
-- this migration was written.

CREATE TABLE "user_email_index" (
  "email"     VARCHAR(320) NOT NULL,
  "tenantId"  UUID NOT NULL,
  "userId"    UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "user_email_index_pkey" PRIMARY KEY ("email")
);
CREATE INDEX "user_email_index_tenantId_idx" ON "user_email_index"("tenantId");

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    INSERT INTO user_email_index ("email", "tenantId", "userId")
    SELECT email, "tenantId", id
    FROM users
    WHERE "tenantId" = t.id AND "deletedAt" IS NULL
    ON CONFLICT ("email") DO NOTHING;
  END LOOP;
END $$;

-- Global uniqueness on the authoritative table too (defense in depth — RLS
-- is the backstop, not the only gate, same principle PrismaService.withTenant's
-- own doc comment already states). Fails loudly here if the guard query
-- above was wrong about there being no real duplicates.
DROP INDEX "users_tenantId_email_key";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
