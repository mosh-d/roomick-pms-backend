-- RLS hardening: treat an empty app.tenant_id as "no tenant context".
--
-- After any transaction that ran `SET LOCAL app.tenant_id = ...`, Postgres
-- leaves the custom GUC defined as '' (empty string) at the session level.
-- A subsequent query on the same pooled connection WITHOUT tenant context then
-- fails with `invalid input syntax for type uuid: ""` instead of returning
-- zero rows. NULLIF turns '' into NULL, so the policy cleanly matches nothing.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'roles', 'user_branch_roles', 'invite_tokens',
    'brands', 'branches', 'buildings', 'floors', 'room_types', 'rooms', 'room_blocks',
    'guest_profiles', 'reservations', 'rate_plans', 'rate_audit_log',
    'no_show_records', 'walk_records', 'corporate_accounts',
    'folios', 'line_items', 'folio_transfers', 'payments', 'refunds', 'tax_rules',
    'housekeeping_tasks', 'shifts', 'shift_issues', 'maintenance_orders', 'assets',
    'registration_cards', 'overbooking_config', 'outlets', 'user_outlets', 'night_audit_log',
    'communication_log', 'audit_log', 'gdpr_requests'
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
