# Phase Notes

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
