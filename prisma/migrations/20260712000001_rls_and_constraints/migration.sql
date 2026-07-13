-- Row-Level Security on every tenant-scoped table (spec §1.2 — non-negotiable).
--
-- Policy: rows are visible/writable only when "tenantId" matches the
-- app.tenant_id GUC, which PrismaService.withTenant sets via
-- `SELECT set_config('app.tenant_id', $1, true)` (SET LOCAL semantics) inside
-- every transaction.
--
-- current_setting(..., true) returns NULL when the setting is absent, so a
-- connection that never set app.tenant_id sees ZERO rows (fail closed) instead
-- of erroring.
--
-- FORCE ROW LEVEL SECURITY makes the policy apply even to the table owner —
-- the role Prisma connects as. Without FORCE, the owner silently bypasses RLS.
--
-- Not RLS-scoped by design: tenants (the root — no tenantId column),
-- feature_flags and backup_records (system-level, sysadmin-only API).

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- identity
    'users', 'roles', 'user_branch_roles', 'invite_tokens',
    -- property
    'brands', 'branches', 'buildings', 'floors', 'room_types', 'rooms', 'room_blocks',
    -- reservations
    'guest_profiles', 'reservations', 'rate_plans', 'rate_audit_log',
    'no_show_records', 'walk_records', 'corporate_accounts',
    -- financial
    'folios', 'line_items', 'folio_transfers', 'payments', 'refunds', 'tax_rules',
    -- operations
    'housekeeping_tasks', 'shifts', 'shift_issues', 'maintenance_orders', 'assets',
    'registration_cards', 'overbooking_config', 'outlets', 'user_outlets', 'night_audit_log',
    -- comms & compliance
    'communication_log', 'audit_log', 'gdpr_requests'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING ("tenantId" = current_setting(''app.tenant_id'', true)::uuid) '
      || 'WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- Financial integrity: a line item can be negative (credit/correction) but
-- never zero (DB doc, line_items).
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_amount_nonzero" CHECK ("amount" <> 0);

-- room_types.baseRate is the cascade starting point — always > 0 (DB doc).
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_base_rate_positive" CHECK ("baseRate" > 0);
