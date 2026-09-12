-- Guest pre-arrival check-in (Month 9, Guest Self-Service Portal).
--
-- A guest fills these in themselves through the public booking engine's
-- "Manage your booking" page before they arrive, so desk check-in becomes
-- confirm-and-assign rather than a full data-entry session.
--
-- All three are nullable with no default, so every existing reservation is
-- untouched and a booking nobody pre-checks in behaves exactly as before.
--
-- Note what is NOT here: corrected contact details. Those are written to the
-- guest's own `guest_profiles` row rather than duplicated onto the
-- reservation, because the registration card generated at check-in already
-- snapshots the guest record at that moment — so a guest correcting their
-- phone number pre-arrival flows through to the card with no extra plumbing.
--
-- No RLS statements needed: `reservations` already has RLS enabled with the
-- `tenant_isolation` policy from 20260712000001_rls_and_constraints, and new
-- columns on an existing RLS-protected table inherit it.
ALTER TABLE "reservations"
  ADD COLUMN "preArrivalCompletedAt" TIMESTAMPTZ(6),
  -- HH:mm in the branch's own timezone. Deliberately text rather than a
  -- timestamp: this is a stated intention for the arrival date, not a precise
  -- instant, and storing it as one would imply accuracy the guest never gave.
  ADD COLUMN "estimatedArrivalTime" VARCHAR(5),
  ADD COLUMN "houseRulesAcceptedAt" TIMESTAMPTZ(6);
