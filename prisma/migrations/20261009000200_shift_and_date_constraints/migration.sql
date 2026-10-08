-- One open cash shift per agent per branch. The service already refuses a second one,
-- but two requests racing each other could both pass; the index can't. It refuses to
-- migrate while duplicates exist, so they are closed deliberately rather than by a script.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shifts WHERE "closedAt" IS NULL GROUP BY "branchId", "agentId" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Close the duplicate open shifts (same agent, same branch) before migrating';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "shifts_one_open_per_agent_branch" ON "shifts" ("branchId", "agentId") WHERE "closedAt" IS NULL;

-- Date order, enforced by the database for every new row. NOT VALID: rows already
-- there are not re-checked, so an old record can't block the deploy.
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_dates_check" CHECK ("checkOutDate" > "checkInDate") NOT VALID;
ALTER TABLE "group_blocks" ADD CONSTRAINT "group_blocks_dates_check" CHECK ("arrivalDate" IS NULL OR "departureDate" IS NULL OR "departureDate" > "arrivalDate") NOT VALID;
ALTER TABLE "availability_restrictions" ADD CONSTRAINT "availability_restrictions_dates_check" CHECK ("endDate" > "startDate") NOT VALID;
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_dates_check" CHECK ("validFrom" IS NULL OR "validTo" IS NULL OR "validTo" >= "validFrom") NOT VALID;
ALTER TABLE "event_bookings" ADD CONSTRAINT "event_bookings_times_check" CHECK ("endsAt" > "startsAt") NOT VALID;
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_dates_check" CHECK ("toDate" >= "fromDate") NOT VALID;

-- The check-in/check-out time defaults the schema declares — the drift `prisma migrate` kept reporting.
ALTER TABLE "branches"
  ALTER COLUMN "checkInTime" SET DEFAULT '14:00:00'::time,
  ALTER COLUMN "checkOutTime" SET DEFAULT '11:00:00'::time;
