-- Month 9 (fifth slice): the unified guest inbox.
--
-- `communication_log` has only ever recorded what the property SENT. A guest
-- writing back — from "Manage your booking" today, and by SMS, WhatsApp or
-- email once those providers are connected — has to be a row too, so one
-- inbox can thread both directions per guest (growth plan Month 9: "extends,
-- doesn't replace, the Month 5 Comms Log").
--
-- direction — every existing row is something the property sent, hence the
--             'outbound' default; there is nothing to backfill.
-- readAt    — inbound only: when staff first read it. NULL = unread; it's
--             what the inbox's unread filter and counts look at.
--
-- The index serves exactly that lookup: unread inbound rows per branch.
-- No RLS statements: communication_log already has its tenant policy.
CREATE TYPE "comms_direction_enum" AS ENUM ('inbound', 'outbound');

ALTER TABLE "communication_log"
  ADD COLUMN "direction" "comms_direction_enum" NOT NULL DEFAULT 'outbound',
  ADD COLUMN "readAt" TIMESTAMPTZ(6);

CREATE INDEX "communication_log_branchId_direction_readAt_idx" ON "communication_log"("branchId", "direction", "readAt");
