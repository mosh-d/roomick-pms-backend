# Phase Notes

## P1 — Identity & Property (2026-07-13)

### Delivered
- **auth**: register (tenant + owner + 6 seeded system roles in one tx), verify-email, login (subdomain or X-Tenant-ID), refresh (rotating pair, roles reloaded from DB), accept-invite (auto-login), GET /auth/roles, PUT /auth/roles/:roleId/permissions.
- **tenants**: POST /tenants/configure-mode — single mode auto-creates the hidden brand; mode is immutable once any brand exists (409).
- **users/staff**: GET /branches/:id/staff, POST /branches/:id/staff/invite (bulk, one invite_tokens row per email, 72h TTL, re-invite replaces pending row), PATCH /staff/:userId (role/outlets/active — deactivation is soft delete), GET/PUT /users/:id/outlets (branch-scoped replacement, validates outlet↔branch).
- **property**: brands CRUD (single-mode cap enforced), branches (IANA timezone validated, times stored as TIME), buildings/floors incl. POST /branches/:id/floors for "Floors Only" onboarding, room-types (baseRate lives here), POST /branches/:id/rooms/bulk (range and/or explicit numbers, ≤500, clash detection), PATCH /rooms/:id/status (full §4.1 axis state machine), POST /rooms/:id/block, overbooking-config upsert, no-show policy, reg-card template.
- 52 unit tests green; live smoke test exercised the full flow end-to-end (register → … → staff list) including negative cases: cross-tenant header → 403 + audit row, ladder skip → 409, non-supervisor inspected → 403.
- Every module ships `http/<module>.<verb>.endpoints.http` httpYac files.

### Decisions & deviations (P1)
1. **Stateless tokens for email-verification and refresh** — the 39-table schema has no token tables; both are signed JWTs (`tokenType` claim distinguishes them; JwtStrategy accepts only `access`). Revocation-on-logout can be added in P6 if needed.
2. **Invite public token = `<tenantId>.<secret>`** — accept-invite is pre-auth, and FORCE RLS blocks a bare token lookup; the tenant prefix establishes RLS context, the stored secret authenticates. Invite/verification emails are stubbed: tokens are returned in the API response (swap for the comms adapter in P5).
3. **roles.permissions JSONB added** (migration `20260713010000`) — §5 requires PUT /auth/roles/:roleId/permissions but no storage existed. Enforcement stays role-name based in RolesGuard for MVP; the JSON map is stored/audited for the UI.
4. **`brandMode` placeholder** — register sets `single`; configure-mode (signup step 2) finalises it. Immutability is enforced by "any brand exists", per the DB doc.
5. **POST /branches/:branchId/floors added** (not in the §5 list) — required by "Floors Only" onboarding since the listed floors endpoint needs a buildingId; it targets the hidden default building.
6. **§4.1 interpretation**: cleanliness ladder strictly `dirty → cleaning → clean → inspected` with any-state → `dirty` allowed (checkout/re-clean); `cleaning → dirty` allowed (abort). Manual occupancy flips and held changes are supervisor-only (owner/manager) corrections — check-in/check-out transactions own those axes from P3.
7. **accept-invite marks email verified** — receiving the invite email proves mailbox ownership.
8. Login without subdomain falls back to the raw X-Tenant-ID header (public route, so TenantGuard hasn't validated it — it's only used to *find* the tenant; the password still decides).

### Carried forward
- Rate limiting on auth endpoints + refresh-token revocation → P6 hardening.
- RolesGuard reads role names from the JWT; custom per-role permission enforcement (the JSONB map) → when the frontend needs it.



## P0 — Skeleton (2026-07-12)

### Delivered
- NestJS 11 app, TypeScript strict, ESLint 9 (type-checked) + Prettier.
- Prisma schema: **all 39 spec tables + `corporate_accounts` (40 models)**, every enum, every FK with explicit `onDelete`, indexes from the DB doc's "Critical Queries" list.
- Migrations: `20260712000000_init` (full schema, generated via `prisma migrate diff --from-empty`) + `20260712000001_rls_and_constraints` (RLS on all 37 tenant-scoped tables, `line_items.amount != 0`, `room_types.baseRate > 0`).
- `PrismaService.withTenant()` — the sanctioned RLS entry point (`set_config('app.tenant_id', $1, true)` inside a transaction).
- Global guard chain (JWT → tenant-header↔claim match → branch-scoped roles), TenantContext (AsyncLocalStorage) + Audit interceptors, problem+json exception filter, Joi-validated env (fail fast), Swagger at `/api/docs`, `/api/v1` prefix.
- `GET /api/v1/system/health` (public), seed script (demo tenant, RLS smoke test), docker-compose Postgres 16, GitHub Actions CI (lint → typecheck → migrate deploy on fresh DB → drift check → seed → unit → e2e → build).

### Decisions & deviations (flagging for review)
1. **`corporate_accounts` added as table #40.** The spec's checklist says 39, but `folios.corporateAccountId` FKs to it and §5 requires `POST /corporate-accounts` CRUD; the count appears to be an oversight. Minimal columns (name, emailDomains[], ratePlanId, contact, isActive).
2. **`reservation_status_enum` omits `pending`** (DB doc lists it; spec §4.2 lifecycle does not). Spec wins. Includes `walked` (needed by `POST /reservations/:id/walk`). Trivial to add `pending` later if OTA flows need it.
3. **`folio_status_enum` uses `settled`** (spec §4.5 check-out language) instead of the DB doc's `closed`.
4. **`brandMode` values `single|multi`** per spec §3.1 (DB doc says `single_brand|multi_brand`).
5. **Columns are camelCase in Postgres** (quoted identifiers), not snake_case. The DB doc's snake_case mapping was a TypeORM convention; we chose Prisma (spec §1 prefers it), and camelCase matches the spec's own RLS policy syntax (`tenantId = current_setting(...)`).
6. **RLS is FORCEd** (applies to the table owner too). Consequence: *all* tenant-data access must use `withTenant()` — including seeds and jobs. Deliberate: a forgotten wrapper reads zero rows instead of leaking cross-tenant data.
7. **Manager rate override** = `overrideRate` + `overrideReason` columns on `reservations` (spec §4.4: "pins an absolute nightly rate on the reservation — NOT a rate_plans row").
8. **Added `refunds` table detail** (status workflow pending→approved→processed) — the DB doc names the table but gives no columns; §5 requires an approval workflow.
9. **Partial indexes and `audit_log` monthly partitioning deferred** to a later performance pass — Prisma can't model them declaratively and P0 optimizes for `migrate diff` cleanliness in CI. Composite (non-partial) equivalents are in place.
10. **`checkInTime`/`checkOutTime` are `TIME`** per the DB doc, surfaced by Prisma as `DateTime` on 1970-01-01 — parse only the time-of-day component, in branch timezone.
11. **JWT payload shape fixed in P0** (`src/common/types/request-context.ts`): `{sub, tenantId, email, roles: [{branchId|null, role}], tokenType}` — P1's auth module must issue exactly this.
12. Seeded role names are snake_case (`front_desk`, `pos_staff`) matching the DB doc's examples.

### Post-P0 fixes (2026-07-13)
- **Migration `20260713000000_rls_nullif_hardening`**: policies now use `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Discovered against the live DB: after any transaction that SET LOCALs the GUC, Postgres leaves it defined as `''` at session level, so later context-less queries on the same pooled connection errored (`invalid input syntax for type uuid: ""`) instead of returning zero rows. Verified: with tenant ctx → data; without → 0 rows, no error.
- **`prisma.config.ts`** replaces the deprecated `package.json#prisma` block (Prisma 7 readiness). The config imports `dotenv/config` because Prisma skips `.env` auto-loading when a config file exists.
- Local database created via pgAdmin (`roomick` role + `roomick` DB on the pre-existing localhost:5432 instance — docker-compose not needed on this machine); all 3 migrations applied, demo tenant seeded.

### How to verify this phase
```
docker compose up -d postgres
npx prisma migrate deploy && npx prisma db seed
npm run lint && npm run typecheck && npm test -- --passWithNoTests && npm run test:e2e && npm run build
```

### Next (P1 — Identity & Property)
auth module (register/verify/login/refresh/accept-invite issuing the JwtPayload above), tenants configure-mode, users/invites/roles, brands→rooms CRUD with 3-mode onboarding (hidden default building/floor rows), room status axis transition validation (§4.1), audit coverage on all of it.
