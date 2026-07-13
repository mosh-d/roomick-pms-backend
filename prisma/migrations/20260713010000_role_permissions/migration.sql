-- P1: storage for PUT /auth/roles/:roleId/permissions (spec §5).
-- The 39-table list has no permissions table; a JSONB column on roles is the
-- minimal fit. NULL = fall back to role-name defaults in the RolesGuard.
ALTER TABLE "roles" ADD COLUMN "permissions" JSONB;
