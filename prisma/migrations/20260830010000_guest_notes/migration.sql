-- CreateTable
CREATE TABLE "guest_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_notes_guestId_createdAt_idx" ON "guest_notes"("guestId", "createdAt");

-- AddForeignKey
ALTER TABLE "guest_notes" ADD CONSTRAINT "guest_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_notes" ADD CONSTRAINT "guest_notes_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guest_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_notes" ADD CONSTRAINT "guest_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: guest_notes is tenant-scoped and was not part of the original
-- 20260712000001_rls_and_constraints table array (it didn't exist yet) —
-- applying the exact same policy shape that migration's own DO-loop uses,
-- by hand, for this one new table.
ALTER TABLE "guest_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guest_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guest_notes"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
