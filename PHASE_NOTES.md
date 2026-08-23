# Phase Notes

## `GET /tenants/me/onboarding-status` (2026-08-23)

### Delivered
- `TenantsService.getOnboardingStatus(tenantId, userId)` + `GET /tenants/me/onboarding-status` (Owner-only, matching every other onboarding endpoint's gating). Walks the same brand → branch → room type → rooms chain the signup wizard's "Finish" creates, stopping at the first missing link (a tenant with only a brand gets `branch: null` back — nothing deeper is queried). Returns enough to fully rehydrate a frontend wizard draft: `tenant` (groupName/subdomain/country/brandMode), `user` (name/email/phone), `brand`/`branch`/`roomType` (or `null`), `roomCount` (a count, not a list).

### Decisions & deviations
1. **Exists specifically to power the frontend's "log in and continue where you left off" flow** (`roomick-pms-frontend`'s `RegisterForm` — see that repo's `PHASE_NOTES.md`), not as a general-purpose "list my branches/room types" API. A returning owner's browser has no local record that an account (or a brand, or a branch...) already exists once `SUBDOMAIN_TAKEN`/`EMAIL_TAKEN` fires on a fresh session — without this, the only options were either a dead-end error or blindly re-walking the wizard and hitting `BRAND_MODE_ALREADY_CONFIGURED` on Finish. A purpose-built read endpoint was chosen over adding generic `GET /brands/:id/branches` / `GET /branches/:id/rooms` list endpoints — those don't exist yet either, and building them with proper pagination/filtering for a future branch-management screen is real, separate work this endpoint doesn't need to wait for or overlap with.
2. **`branch.category` and other free-form columns are returned as-is, not re-validated.** The DB column is a plain `VARCHAR`, not a Postgres enum (schema.prisma's own comment already flags this) — this endpoint trusts data the backend itself created via `CreateBranchDto`'s validation at write time, not re-checked at read time.

### Verified
`npx tsc --noEmit` and existing `tenants.service.spec.ts` suite both clean (no behavior change to `configureMode`, so no new failures). Two live checks via direct API calls, not just reading the code: a freshly registered+verified tenant with no brand yet returns `{ brand: null, branch: null, roomType: null, roomCount: 0 }`; the same tenant after real `configure-mode` → create branch → create room type → bulk-create-rooms calls returns every field populated correctly (address, timezone, currency, check-in/out times formatted as `"HH:mm"`, capacity, amenities, `roomCount: 5` matching the actual bulk-created count) — confirmed against real Postgres rows, not assumed from the Prisma query alone.

### Carried forward
- None specific to this endpoint.

## `configure-mode` always creates the head brand (2026-08-23)

### Delivered
- `TenantsService.configureMode()` now creates the head `Brand` row for **both** `single` and `multi` mode — previously only `single` mode did this; `multi` mode returned `brand: null` and the frontend called a separate `POST /brands` on its own screen right after. Return type changed from `{ tenant: Tenant; brand: Brand | null }` to `{ tenant: Tenant; brand: Brand }` — `brand` is no longer optional.

### Decisions & deviations
1. **Driven by a real product question, not a backend-side cleanup**: "what's the need for hotel name when we already have brand name" — there wasn't one. The owner already names their organization at signup (`groupName`); asking again for a "Brand Name" on the Organization Structure screen (previously only shown for `single` mode, and shown as a completely empty screen with no field at all for `multi` mode — a real UX bug, reported directly) was asking twice for the same thing. Defaulting to `groupName` for both modes removes the double-ask entirely.
2. **Doesn't change what multi-brand tenants can do.** `createBrand` was already unrestricted for multi-mode tenants (only `single`-mode tenants are capped at exactly one brand) — this change just means the *first* brand is created automatically, same as single mode always did, instead of requiring a separate manual step. Additional brands are still created the same way they always were.
3. **`ConfigureModeDto.brandName` stays optional** — its meaning is unchanged (an override for the head brand's name), just no longer conditional on mode.

### Verified
`npx tsc --noEmit` clean. Unit tests updated (`tenants.service.spec.ts`) — the old "multi mode creates no brand" test is now "multi mode also creates the head brand"; both pass. Verified against a real request from the frontend's rewritten onboarding wizard: registered a multi-mode tenant, confirmed a brand row named after the tenant's `groupName` actually exists in Postgres (RLS context set explicitly), not just that the API call returned 2xx.

### Carried forward
- None specific to this change — see the frontend's own `PHASE_NOTES.md` (Phase 7) for the larger onboarding-wizard rework this was one piece of.

## Tenant country field (2026-08-23)

### Delivered
- `Tenant.country` — nullable `VARCHAR(2)` (migration `20260823000000_tenant_country`, hand-written for the same reason every migration in this repo is — see the "Demo tenants" entry below on why `migrate dev` doesn't work here).
- `RegisterDto.country?: string` with `@IsISO31661Alpha2()` (same validator `AddressDto.country` already uses in `branch.dto.ts` — one established pattern for "ISO 3166-1 alpha-2 country code" across the codebase, not a new one). Wired through `AuthService.register()`'s `tenant.create()` call.

### Decisions & deviations
1. **Reporting only, on purpose.** Requested specifically to track which countries are onboarding from, not to drive any business logic yet — no timezone-suggestion, no locale defaults, nothing reads this column anywhere else in the codebase today. The frontend's own carried-forward notes flag using it to suggest a default branch timezone during Branch Setup as the natural next consumer, not built here.
2. **Nullable, not required.** Consistent with `phone` and other owner-supplied-but-optional fields already on this DTO — not every signup is guaranteed to supply it, and there's no reason to block registration over it.

### Verified
`npx tsc --noEmit` clean. `prisma migrate deploy` applied cleanly against the existing dev database (a nullable column with no default needs no backfill). Confirmed end-to-end from the frontend: registered a real tenant with `country: "NG"`, read the row back directly via the Prisma client (not just checked the API response didn't error) — `country: 'NG'` persisted correctly.

### Carried forward
- Everything downstream of this column: timezone suggestions, reporting/analytics queries, any actual consumption of the value. It exists to be tracked, nothing more yet.

## Demo tenants + delete organization (2026-08-22)

### Delivered
- `Tenant.isDemo`/`Tenant.demoExpiresAt` (migration `20260822000000_demo_tenant_fields`, hand-written — the `roomick` DB role has no CREATEDB grant, so `prisma migrate dev`'s shadow-database diffing can't run; `migrate deploy` against a hand-authored SQL file works fine and is the correct workflow when the role is properly locked down).
- `RegisterDto.isDemo?: boolean` — self-serve "try it" signups (not sales-assisted trials) set this; `AuthService.register()` stamps `demoExpiresAt` = now + `DEMO_TENANT_TTL_DAYS` (30, in `tenants.service.ts`) when set.
- `DELETE /tenants/me` (owner-only, 204) — `TenantsService.deleteOrganization()`. Always the caller's own tenant (derived the same way every other endpoint derives it — JWT + X-Tenant-ID via `@CurrentTenant()`), never a client-supplied ID.
- `TenantsService.sweepExpiredDemoTenants()` — `@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)`, calls the same `deleteOrganization()` for every tenant past its `demoExpiresAt`. First real consumer of `ScheduleModule.forRoot()`, registered since P0 but unused until now.

### Decisions & deviations
1. **Deletion order is schema-derived, not guessed — and got it wrong once, caught by actually testing against a populated tenant rather than trusting a schema read.** The schema deliberately `Restrict`s a tenant's real financial/operational data (spec: money is append-only) so a tenant can't be silently cascade-wiped. Of the `Restrict`-configured tables, only five are reachable via what's built today: Room, RoomType, Branch, User — and **AuditLog**, which was missed on the first pass (nothing in the schema read flagged it as "populated by side effect") and only surfaced as a live `PrismaClientUnknownRequestError` (FK violation, code 23001) when deleting a tenant that had actually gone through register→configure-mode→branch→room-type→rooms/bulk, each of which writes an audit row via the global `AuditInterceptor`. Fixed by explicitly clearing `auditLog` first. Full reasoning + the exact dependency order lives as a comment on `deleteOrganization()` — read it before touching this method.
2. **Scope: today's reachable tables only, not general-purpose.** Reservation/Folio/Payment/etc. are `Restrict`-configured too but nothing populates them yet (P2+ endpoints don't exist). If a tenant somehow has real transactional data, the delete fails loudly (DB constraint error) instead of silently destroying it — a deliberate fail-safe. Revisit this method's explicit-delete list as each new module lands real write paths.
3. **`DELETE /tenants/me`, not `/tenants/:id`** — matches the existing `configureMode` pattern (`@CurrentTenant()`, never a path param) rather than requiring an extra "does `:id` match the caller's own tenant" check.
4. **Not demo-gated.** Any tenant's owner can call this, not just demo ones — deleting your own account/data on request is a reasonable capability independent of demo status (arguably closer to a GDPR-style expectation than something to restrict).
5. **Verified live, not just unit-tested**: registered a demo tenant, ran it through the *entire* currently-built onboarding surface (configure-mode → brand → branch → room-type → 5 rooms via bulk), confirmed `isDemo`/`demoExpiresAt` persisted correctly, then called `DELETE /tenants/me` and confirmed the tenant row (and, by Postgres's own atomic cascade guarantee, everything Cascade-configured beneath it) was fully gone.

### Carried forward
- Redis-backed advisory locking or similar if the nightly sweep ever needs to run across multiple instances (not needed yet — single instance).
- Extending `deleteOrganization`'s explicit-delete list as P2+ modules add new `Restrict`-configured tables that become reachable.
- `npm test` now emits a harmless-but-worth-fixing Jest warning ("worker process failed to exit gracefully... active timers") — the new `@Cron` job's timer isn't torn down between test runs. Doesn't fail anything; a proper fix would close the Nest testing module's scheduler in an `afterAll` wherever it gets bootstrapped.

## Hardening — Auth rate limiting (2026-08-22)

### Delivered
- `@nestjs/throttler` wired as a global guard (`ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])` — 100 req/min/IP default), ordered *first* in the guard chain (before `JwtAuthGuard`) so abusive traffic is rejected before it costs a DB round-trip.
- Per-route overrides on every `@Public()` auth endpoint, tightest on `register`: 5/15min (it provisions a tenant + owner + 6 seeded system roles in one transaction, not a plain INSERT), `login`/`verify-email`/`accept-invite` at 10/min, `refresh` at 20/min (looser — reaching it already requires a valid refresh token).

### Decisions & deviations
1. **Pulled forward from the P6 hardening backlog** (see P1's "Carried forward" below) rather than left deferred. Reasoning: `register()`'s cost (tenant + owner + role provisioning per call, fully unauthenticated) makes "no rate limit yet" a real resource-exhaustion/spam vector, not just a theoretical gap — cheap to close (one package, a decorator per route) relative to the risk, so there was no good reason to wait for a P6 that has no scheduled date.
2. **In-memory storage** (the package's default) — correct for this single-instance dev/local deployment. A multi-instance production deployment would need a shared store (the package ships a Redis storage adapter) so instances share counters instead of each enforcing the limit independently. Not needed yet — noted for when horizontal scaling actually happens.
3. **CAPTCHA/bot-protection explicitly NOT added** — needs a third-party service + frontend integration; the cost isn't justified pre-launch (nothing here is reachable from a public URL yet). Revisit alongside real deployment, not before.
4. Limits are hardcoded in `app.module.ts`/`auth.controller.ts`, not env-configurable — matches this codebase's existing minimal-env-surface style (see `env.validation.ts`); revisit only if a real need to tune them per-environment shows up.

### Carried forward
- Refresh-token revocation-on-logout (still P1's original deferral).
- CAPTCHA/bot-protection, Redis-backed throttler storage for multi-instance deployment (see above).

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
