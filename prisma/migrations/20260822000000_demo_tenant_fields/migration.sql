-- Demo tenants (self-serve "try it" signups) auto-expire and get swept by a
-- scheduled job, or can be deleted early via DELETE /tenants/:id. Real
-- tenants never set these two columns.
ALTER TABLE "tenants" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "demoExpiresAt" TIMESTAMPTZ(6);

CREATE INDEX "tenants_isDemo_demoExpiresAt_idx" ON "tenants"("isDemo", "demoExpiresAt");
