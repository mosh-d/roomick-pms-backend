-- Growth plan Month 11: the Integrations Marketplace.
--   integration_connections  one row per connector a tenant has switched on — its status and its
--                            configuration. The catalogue itself (names, categories, what each
--                            connector does) is code, so a listing can't exist without the code
--                            behind it.

CREATE TYPE "integration_status_enum" AS ENUM ('enabled', 'disabled');

CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "status" "integration_status_enum" NOT NULL DEFAULT 'enabled',
    "config" JSONB NOT NULL,
    "enabledAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enabledBy" UUID,
    "disabledAt" TIMESTAMPTZ(6),
    "lastRunAt" TIMESTAMPTZ(6),
    "lastRunSummary" VARCHAR(500),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id"),
    -- The configuration is an object — a connector's parser reads named keys out of it.
    CONSTRAINT "integration_connections_config_object" CHECK (jsonb_typeof("config") = 'object'),
    -- A disabled connector records when; an enabled one hasn't been disabled since it was last switched on.
    CONSTRAINT "integration_connections_status_shape" CHECK (("status" = 'disabled') = ("disabledAt" IS NOT NULL))
);

-- One connection per connector per tenant: switching it off and on again is the same row.
CREATE UNIQUE INDEX "integration_connections_tenantId_provider_key" ON "integration_connections"("tenantId", "provider");
-- The review-request sweep asks "which tenants have this switched on".
CREATE INDEX "integration_connections_provider_status_idx" ON "integration_connections"("provider", "status");

ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "integration_connections"
    USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
