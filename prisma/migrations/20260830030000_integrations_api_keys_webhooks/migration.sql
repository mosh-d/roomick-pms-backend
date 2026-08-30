-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "keyPrefix" VARCHAR(12) NOT NULL,
    "keyHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "eventTypes" TEXT[],
    "secret" VARCHAR(64) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_keys_tenantId_idx" ON "api_keys"("tenantId");

-- CreateIndex
CREATE INDEX "webhooks_tenantId_idx" ON "webhooks"("tenantId");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: not automatic for a new table — the original
-- 20260712000001_rls_and_constraints migration only loops over the
-- table names that existed at P0.
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "api_keys" USING ("tenantId" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "webhooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhooks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhooks" USING ("tenantId" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
