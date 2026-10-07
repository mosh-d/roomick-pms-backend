-- Staff Management → Page Access: which pages a staff role can open at a branch, set by its manager.
-- No row means the role's default (every page it can open).
CREATE TABLE "branch_page_access" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "pages" TEXT[],
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID,

    CONSTRAINT "branch_page_access_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "branch_page_access_tenantId_idx" ON "branch_page_access"("tenantId");
CREATE UNIQUE INDEX "branch_page_access_branchId_roleId_key" ON "branch_page_access"("branchId", "roleId");

ALTER TABLE "branch_page_access" ADD CONSTRAINT "branch_page_access_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_page_access" ADD CONSTRAINT "branch_page_access_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_page_access" ADD CONSTRAINT "branch_page_access_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, same policy as every other tenant table.
ALTER TABLE "branch_page_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branch_page_access" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "branch_page_access"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
