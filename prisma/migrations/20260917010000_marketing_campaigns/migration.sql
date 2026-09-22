-- Growth plan Month 11: marketing campaigns.
--   guest_segments         a saved audience, stored as criteria and re-queried live (no member list to go stale)
--   message_templates      subject + body with {{merge_field}} placeholders
--   marketing_campaigns    one send: segment + template (+ an optional A/B variant), scheduled or immediate
--   campaign_recipients    one row per guest it actually went to, and where open/click/unsubscribe are recorded
--   marketing_token_index  the pre-auth token lookup for the pixel/click/unsubscribe links (deliberately NOT RLS)
--   guest_profiles.marketing* — consent. No campaign reaches a guest without an explicit opt-in.

CREATE TYPE "campaign_status_enum" AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed');

-- Marketing consent, and the record of when it was given or withdrawn.
ALTER TABLE "guest_profiles"
    ADD COLUMN "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "marketingOptInAt" TIMESTAMPTZ(6),
    ADD COLUMN "marketingOptInSource" VARCHAR(30),
    ADD COLUMN "marketingUnsubscribedAt" TIMESTAMPTZ(6);

-- An opted-in guest always carries the moment they opted in: consent with no date behind it
-- is not evidence of consent. Existing rows default to false, so this holds retroactively.
ALTER TABLE "guest_profiles"
    ADD CONSTRAINT "guest_profiles_marketing_consent_dated" CHECK ("marketingOptIn" = false OR "marketingOptInAt" IS NOT NULL);

-- DELIBERATELY NOT RLS-SCOPED, same category as tenants / user_email_index / booking_slug_index.
-- The open pixel, click redirect and unsubscribe page are fetched by a mail client with no
-- session and no tenant header, and campaign_recipients below has FORCE ROW LEVEL SECURITY, so
-- the row behind a token cannot be found without knowing the tenant first. This holds the token
-- and the two ids it points at, and nothing else.
CREATE TABLE "marketing_token_index" (
    "token" VARCHAR(64) NOT NULL,
    "tenantId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_token_index_pkey" PRIMARY KEY ("token")
);

CREATE TABLE "guest_segments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(300),
    "criteria" JSONB NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "guest_segments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "message_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "channel" "comms_channel_enum" NOT NULL DEFAULT 'email',
    "subject" VARCHAR(500),
    "body" TEXT NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marketing_campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "channel" "comms_channel_enum" NOT NULL,
    "segmentId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "subject" VARCHAR(500),
    "status" "campaign_status_enum" NOT NULL DEFAULT 'draft',
    "scheduledAt" TIMESTAMPTZ(6),
    "sentAt" TIMESTAMPTZ(6),
    "variantTemplateId" UUID,
    "splitRatio" DECIMAL(3,2),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" VARCHAR(500),
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id"),
    -- An A/B test is a variant template AND a split, or neither. A split of 0 or 1 is not a
    -- test (every recipient would get one side of it), and a variant identical to the control
    -- measures nothing.
    CONSTRAINT "marketing_campaigns_ab_shape" CHECK (
        ("variantTemplateId" IS NULL AND "splitRatio" IS NULL)
        OR ("variantTemplateId" IS NOT NULL AND "splitRatio" IS NOT NULL
            AND "splitRatio" > 0 AND "splitRatio" < 1
            AND "variantTemplateId" <> "templateId")
    ),
    -- A scheduled campaign has a time to go out at; a sent one has the time it did.
    CONSTRAINT "marketing_campaigns_status_shape" CHECK (
        ("status" <> 'scheduled' OR "scheduledAt" IS NOT NULL)
        AND ("status" <> 'sent' OR "sentAt" IS NOT NULL)
    ),
    CONSTRAINT "marketing_campaigns_recipient_count_non_negative" CHECK ("recipientCount" >= 0)
);

CREATE TABLE "campaign_recipients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "guestId" UUID NOT NULL,
    "variant" CHAR(1) NOT NULL,
    "communicationLogId" UUID,
    "sentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMPTZ(6),
    "clickedAt" TIMESTAMPTZ(6),
    "unsubscribedAt" TIMESTAMPTZ(6),

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id"),
    -- 'A' is the control even when there is no test, so every row has a side.
    CONSTRAINT "campaign_recipients_variant" CHECK ("variant" IN ('A', 'B'))
);

CREATE INDEX "marketing_token_index_recipientId_idx" ON "marketing_token_index"("recipientId");
CREATE UNIQUE INDEX "guest_segments_tenantId_name_key" ON "guest_segments"("tenantId", "name");
CREATE UNIQUE INDEX "message_templates_tenantId_name_key" ON "message_templates"("tenantId", "name");
CREATE INDEX "marketing_campaigns_tenantId_branchId_status_idx" ON "marketing_campaigns"("tenantId", "branchId", "status");
-- The scheduled-send sweep's own query: status = 'scheduled' AND "scheduledAt" <= now().
CREATE INDEX "marketing_campaigns_status_scheduledAt_idx" ON "marketing_campaigns"("status", "scheduledAt");
CREATE UNIQUE INDEX "campaign_recipients_communicationLogId_key" ON "campaign_recipients"("communicationLogId");
CREATE INDEX "campaign_recipients_tenantId_campaignId_idx" ON "campaign_recipients"("tenantId", "campaignId");
-- One send per guest per campaign. This is what makes a resumed send idempotent: a send that
-- died halfway can be re-run and will skip everyone who already has a row.
CREATE UNIQUE INDEX "campaign_recipients_campaignId_guestId_key" ON "campaign_recipients"("campaignId", "guestId");

ALTER TABLE "guest_segments" ADD CONSTRAINT "guest_segments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "guest_segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "message_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_variantTemplateId_fkey" FOREIGN KEY ("variantTemplateId") REFERENCES "message_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guest_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_communicationLogId_fkey" FOREIGN KEY ("communicationLogId") REFERENCES "communication_log"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation, same shape as every other tenant-scoped table in this schema.
ALTER TABLE "guest_segments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guest_segments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "guest_segments"
    USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "message_templates"
    USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "marketing_campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketing_campaigns" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "marketing_campaigns"
    USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "campaign_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaign_recipients" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "campaign_recipients"
    USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);
