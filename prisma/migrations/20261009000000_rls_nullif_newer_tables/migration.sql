-- RLS hardening for the tables created after the July 2026 hardening migration
-- (20260713000000_rls_nullif_hardening). Their policies still cast app.tenant_id
-- with a plain ::uuid, so a query made on a pooled connection where the setting
-- was left as '' failed with 22P02 instead of matching nothing. Same expression
-- as the July migration, applied to the 23 tables that missed it.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'api_keys', 'availability_restrictions', 'branch_page_access', 'campaign_recipients',
    'competitor_rates', 'competitors', 'event_bookings', 'event_spaces', 'group_blocks',
    'guest_notes', 'guest_segments', 'integration_connections', 'loyalty_programs',
    'loyalty_transactions', 'marketing_campaigns', 'menu_items', 'message_templates',
    'password_reset_tokens', 'pos_orders', 'refresh_tokens', 'report_templates',
    'webhook_deliveries', 'webhooks'
  ]
  LOOP
    EXECUTE format(
      'ALTER POLICY tenant_isolation ON %I '
      || 'USING ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
