-- Outgoing mail is retried with a backoff instead of failing on the first provider error:
-- how many times a row was tried, when the next try is due, and why the last one failed.
ALTER TABLE "communication_log"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(6),
  ADD COLUMN "lastError" VARCHAR(500);

-- A cancelled event is marked, not deleted: its BEO and notes stay on record.
ALTER TABLE "event_bookings"
  ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT 'confirmed',
  ADD COLUMN "cancelledAt" TIMESTAMPTZ(6);
