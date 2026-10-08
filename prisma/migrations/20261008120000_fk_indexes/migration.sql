-- Indexes on the foreign keys that real queries follow (audit M11). 111 single-column
-- foreign keys had no index; these are the ones on hot paths — the rest are written
-- once and read by id, where an index would only slow the write.
CREATE INDEX IF NOT EXISTS "housekeeping_tasks_roomId_idx" ON "housekeeping_tasks"("roomId");
CREATE INDEX IF NOT EXISTS "maintenance_orders_roomId_idx" ON "maintenance_orders"("roomId");
CREATE INDEX IF NOT EXISTS "maintenance_orders_assetId_idx" ON "maintenance_orders"("assetId");
CREATE INDEX IF NOT EXISTS "maintenance_orders_assignedTo_idx" ON "maintenance_orders"("assignedTo");
CREATE INDEX IF NOT EXISTS "folios_guestId_idx" ON "folios"("guestId");
CREATE INDEX IF NOT EXISTS "gdpr_requests_guestId_idx" ON "gdpr_requests"("guestId");
CREATE INDEX IF NOT EXISTS "campaign_recipients_guestId_idx" ON "campaign_recipients"("guestId");
CREATE INDEX IF NOT EXISTS "pos_orders_folioId_idx" ON "pos_orders"("folioId");
CREATE INDEX IF NOT EXISTS "pos_orders_reservationId_idx" ON "pos_orders"("reservationId");
CREATE INDEX IF NOT EXISTS "rooms_roomTypeId_idx" ON "rooms"("roomTypeId");
CREATE INDEX IF NOT EXISTS "rate_plans_roomTypeId_idx" ON "rate_plans"("roomTypeId");
CREATE INDEX IF NOT EXISTS "invite_tokens_branchId_idx" ON "invite_tokens"("branchId");
CREATE INDEX IF NOT EXISTS "communication_log_sentBy_idx" ON "communication_log"("sentBy");
CREATE INDEX IF NOT EXISTS "line_items_postedBy_idx" ON "line_items"("postedBy");
CREATE INDEX IF NOT EXISTS "user_branch_roles_roleId_idx" ON "user_branch_roles"("roleId");
CREATE INDEX IF NOT EXISTS "user_branch_roles_branchId_idx" ON "user_branch_roles"("branchId");
CREATE INDEX IF NOT EXISTS "shifts_agentId_idx" ON "shifts"("agentId");
