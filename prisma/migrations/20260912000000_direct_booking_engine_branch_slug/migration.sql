-- Direct Booking Engine (Month 7): the public, guest-facing identity of a
-- property.
--
-- Both columns are opt-in by default (NULL slug, engine disabled), so every
-- existing branch keeps its exact current behavior and accepts no public
-- bookings until its owner explicitly publishes it.
--
-- `Tenant.subdomain` is deliberately not reused as the public identity — see
-- the Branch model's own comment in schema.prisma for why (it's documented
-- backend-internal, can carry a random collision suffix, and identifies a
-- tenant group rather than a single bookable property).
--
-- No RLS statements needed here: `branches` already has RLS enabled and the
-- `tenant_isolation` policy applied by 20260712000001_rls_and_constraints.
-- Adding a column to an existing RLS-protected table inherits that policy.
ALTER TABLE "branches"
  ADD COLUMN "bookingEngineEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bookingSlug" VARCHAR(63);

-- Unique across ALL tenants, not per-tenant: a public booking URL has to
-- resolve to exactly one property with no tenant context available to
-- disambiguate it (the request arrives unauthenticated, before any tenant is
-- known). NULLs don't collide in Postgres, so any number of unpublished
-- branches coexist.
CREATE UNIQUE INDEX "branches_bookingSlug_key" ON "branches"("bookingSlug");
