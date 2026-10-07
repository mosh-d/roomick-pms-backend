-- API keys sign requests in, read-only, limited to what they were given; webhooks are delivered.

-- What a key can read (permission modules), and optionally only one branch's records.
-- Keys made before this have no access until the owner gives them some.
ALTER TABLE "api_keys" ADD COLUMN "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "branchId" UUID;

-- Every request looks its key up by hash.
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A webhook can be kept to one branch's events.
ALTER TABLE "webhooks" ADD COLUMN "branchId" UUID;

ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The outbox: one row per event per webhook, sent after the change commits and retried with backoff.
CREATE TYPE "webhook_delivery_status_enum" AS ENUM ('pending', 'delivered', 'failed');

CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "webhookId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "eventType" VARCHAR(60) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "webhook_delivery_status_enum" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastAttemptAt" TIMESTAMPTZ(6),
    "responseStatus" INTEGER,
    "lastError" VARCHAR(500),
    "deliveredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt");
CREATE INDEX "webhook_deliveries_webhookId_createdAt_idx" ON "webhook_deliveries"("webhookId", "createdAt" DESC);

ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, same policy as every other tenant table.
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhook_deliveries"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

-- Subscriptions saved before delivery existed named raw route strings ("reservations.post").
-- Carry over the ones that have an event now, drop the rest, and switch off any webhook left
-- with nothing to listen for. webhooks is under FORCE ROW LEVEL SECURITY, so each tenant is
-- carried over with its own app.tenant_id.
DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT "id" FROM "tenants" LOOP
        PERFORM set_config('app.tenant_id', t."id"::text, true);
        UPDATE "webhooks" w
        SET "eventTypes" = ARRAY(
            SELECT DISTINCT CASE e
                WHEN 'reservations.post' THEN 'reservation.created'
                WHEN 'reservations.patch' THEN 'reservation.updated'
                WHEN 'payments.post' THEN 'payment.received'
                ELSE e
            END
            FROM unnest(w."eventTypes") AS e
            WHERE e IN (
                'reservations.post', 'reservations.patch', 'payments.post',
                'reservation.created', 'reservation.updated', 'reservation.cancelled', 'reservation.checked_in',
                'reservation.checked_out', 'reservation.no_show', 'reservation.walked', 'reservation.room_moved',
                'payment.received', 'refund.paid'
            )
        )
        WHERE w."tenantId" = t."id";
        UPDATE "webhooks" SET "isActive" = false WHERE "tenantId" = t."id" AND cardinality("eventTypes") = 0;
    END LOOP;
END $$;
