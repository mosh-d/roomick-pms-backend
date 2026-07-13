# Roomick PMS — Backend Execution Specification

> **Audience:** This document is written for an AI coding agent (Claude Code) to execute the backend build.
> **Read fully before writing any code.** Business rules in §4 override any assumption. When this spec conflicts with a framework default, this spec wins.

---

## 1. Project Overview

Roomick is a **multi-tenant, multi-brand hotel Property Management System (PMS)** SaaS.

| Layer | Technology |
|---|---|
| Backend | **NestJS** (latest stable, TypeScript strict mode) |
| Database | **PostgreSQL 16+** |
| ORM | **Prisma** (preferred) or TypeORM — pick Prisma unless a blocking issue arises |
| Auth | JWT (access + refresh), bcrypt password hashing |
| Validation | class-validator + class-transformer on every DTO |
| Docs | OpenAPI/Swagger auto-generated at `/api/docs` |
| Frontend (context only — do not build) | Next.js, sends `X-Tenant-ID` header |

### 1.1 Tenancy hierarchy

```
Tenant (hotel company / signup account)
 └── Brand            (single-brand tenants auto-create 1 hidden brand)
      └── Branch      (a physical property; most operational data hangs here)
           └── Building (optional — auto-created hidden default if skipped)
                └── Floor (optional — same rule)
                     └── Room
```

- **Single-brand mode:** tenant has exactly one brand; UI hides the brand layer, but the DB row still exists. The backend must never special-case single-brand — it is purely a UI concern.
- **Onboarding modes for physical layout:** Rooms Only / Floors Only / Full Buildings+Floors. When a level is skipped, auto-create one hidden default row (`name = NULL`) so FKs always resolve. Schema is identical in all three modes.

### 1.2 Multi-tenancy enforcement (non-negotiable)

1. Every tenant-scoped table carries `tenantId UUID NOT NULL`.
2. **PostgreSQL Row-Level Security (RLS)** is enabled on every tenant-scoped table. Policy: `tenantId = current_setting('app.tenant_id')::uuid`.
3. A NestJS middleware/interceptor reads `X-Tenant-ID`, validates it against the JWT's tenant claim (they must match — reject 403 otherwise), then sets `SET LOCAL app.tenant_id = $1` inside every transaction.
4. Application-layer guards ALSO filter by tenantId (defense in depth — RLS is the backstop, not the only gate).
5. Cross-tenant access attempts are logged to `audit_log` with severity `security`.

---

## 2. Repository Layout

```
roomick-backend/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                  # dev/staging only
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── common/
│   │   ├── guards/              # JwtAuthGuard, RolesGuard, TenantGuard
│   │   ├── interceptors/        # TenantContextInterceptor, AuditInterceptor
│   │   ├── decorators/          # @CurrentUser, @CurrentTenant, @Roles
│   │   ├── filters/             # Global exception filter (problem+json)
│   │   └── dto/                 # PaginationDto, DateRangeDto
│   ├── modules/
│   │   ├── auth/
│   │   ├── tenants/
│   │   ├── users/               # includes invites, user_branch_roles, user_outlets
│   │   ├── property/            # brands, branches, buildings, floors, rooms, room_types, room_blocks
│   │   ├── guests/              # guest_profiles, ID-state logic
│   │   ├── corporate/           # corporate_accounts CRUD + email-domain matcher (feeds rate cascade)
│   │   ├── reservations/        # incl. waitlist logic, no_show_records, walk_records
│   │   ├── rates/               # rate_plans, rate-resolver service, rate_audit_log
│   │   ├── folios/              # folios, line_items, folio_transfers
│   │   ├── payments/            # payments, refunds, deposits
│   │   ├── taxes/               # tax_rules, tax engine
│   │   ├── outlets/             # outlets + POS charge attribution
│   │   ├── frontdesk/           # check-in, check-out, registration_cards
│   │   ├── housekeeping/        # housekeeping_tasks, room status transitions
│   │   ├── maintenance/         # maintenance_orders (work orders), assets, OOO room logic
│   │   ├── night-audit/         # night_audit_log + the audit job
│   │   ├── overbooking/         # overbooking_config + guard logic
│   │   ├── shifts/              # shifts, shift_issues
│   │   ├── comms/               # communication_log (email/SMS stubs)
│   │   ├── reports/             # occupancy, revenue, ADR, RevPAR, tax-summary, outstanding balances + /hq rollups
│   │   └── admin/               # feature_flags, backup_records, gdpr_requests, audit_log read API
│   └── jobs/                    # cron: night audit scheduler, token expiry cleanup
└── test/
```

Every module = `controller + service + dto/ + entities` (Prisma models live centrally, but each module owns its DTOs and business logic). No service may import another module's repository directly — cross-module calls go through the other module's exported service.

---

## 3. Database Schema — Authoritative Table List (39 tables)

> Full column detail lives in the companion file `pms-database-architecture.html` (v1.2). The list below is the build checklist; column notes here call out only what the migration must get exactly right.

### 3.1 Identity (5)
| Table | Critical notes |
|---|---|
| `tenants` | `brandMode` enum: `single` \| `multi`. |
| `users` | Passwords bcrypt (cost ≥ 12). Soft-delete via `deletedAt`. |
| `roles` | Seeded per tenant: Owner, Manager, Front Desk, Housekeeper, Accountant, POS Staff. |
| `user_branch_roles` | Junction: user ↔ branch ↔ role. A user can hold different roles at different branches. |
| `invite_tokens` | Single-use, expiring. Bulk invite = one row per email. |

### 3.2 Property (7)
| Table | Critical notes |
|---|---|
| `brands` | |
| `branches` | Carries branch-level config: checkInTime, checkOutTime, currency, timezone (IANA string — night audit depends on it). |
| `buildings`, `floors` | `name` nullable — NULL means hidden auto-created default. |
| `room_types` | **`baseRate NUMERIC(12,2)` lives here — NOT in rate_plans.** Rate Plan screens only reference it read-only. |
| `rooms` | **Three status columns** (v1.1): `occupancyStatus` (`vacant`\|`occupied`), `cleanlinessStatus` (`dirty`\|`cleaning`\|`clean`\|`inspected`), `heldStatus` (NULL\|`out_of_order`\|`blocked`). Never recombine into one column. |
| `room_blocks` | Date-ranged administrative blocks. |

### 3.3 Reservations (6)
| Table | Critical notes |
|---|---|
| `guest_profiles` | `idDocNumber` encrypted at application layer (AES-256-GCM). `idDocUrl` → encrypted S3. `idDocExpiryDate DATE` drives 3-state check-in logic. `preferences JSONB`. |
| `reservations` | Status lifecycle in §4.2. `channel` enum: `direct`\|`walk_in`\|`booking_com`\|`expedia`\|`agoda`\|`airbnb`. Waitlist entries are reservations with `status = waitlisted` (no separate table). |
| `rate_plans` | v1.2 cascade model — see §4.4. `cascadeTier SMALLINT`, `isOverride BOOLEAN`. |
| `rate_audit_log` | BIGSERIAL append-only. `result JSONB` stores the full cascade trace. |
| `no_show_records`, `walk_records` | |

### 3.4 Financial (6)
`folios`, `line_items`, `folio_transfers`, `payments`, `refunds`, `tax_rules`
- `line_items.chargeType` enum: `room fnb spa laundry minibar transport tax penalty correction misc` (NO `deposit`).
- `line_items.outletId` nullable FK — NULL for room/night-audit/system posts.
- `payments.paymentPurpose`: `payment` \| `deposit` \| `deposit_application` (v1.1).
- Financial rows are **append-only**: no UPDATE of amounts, no DELETE. Corrections = new negative line item. Payments voided via `isVoid`, never removed.

### 3.5 Operations (10)
`housekeeping_tasks`, `shifts`, `shift_issues`, `maintenance_orders`, `assets`, `registration_cards`, `overbooking_config`, `outlets`, `user_outlets`, `night_audit_log`
- `night_audit_log`: `UNIQUE (branchId, auditDate)` — the DB enforces single-run.
- `outlets.chargeType` stamps every POS line item automatically.
- `user_outlets`: `UNIQUE (userId, outletId)`.

### 3.6 Comms (3) — `communication_log`, `audit_log`, `gdpr_requests`
`audit_log` is BIGSERIAL append-only; every state-changing endpoint writes to it via the AuditInterceptor.

### 3.7 System (2) — `feature_flags`, `backup_records`

### 3.8 Global schema rules
- UUID v4 PKs everywhere **except** `audit_log`, `rate_audit_log`, `night_audit_log` (BIGSERIAL — high-write append-only).
- Soft delete (`deletedAt TIMESTAMPTZ`) on: guests, reservations, folios, line_items, payments, room_types, rooms, users. Hard delete allowed only on: invite_tokens (expired), room_blocks (past).
- All timestamps `TIMESTAMPTZ`. All money `NUMERIC(12,2)` (never float). Branch currency stored once on `branches.currency`.
- Every FK gets an explicit `ON DELETE` behavior. Defaults: CASCADE for pure child config rows, RESTRICT for anything financial/historical, SET NULL for attribution FKs (e.g. `postedBy`).

---

## 4. Core Business Rules (override everything else)

### 4.1 Room status — three independent axes
- Check-in sets `occupancyStatus = occupied`. Check-out sets `occupancyStatus = vacant` AND `cleanlinessStatus = dirty` in the same transaction.
- Housekeeping transitions: `dirty → cleaning → clean → inspected`. Only supervisors (role check) may set `inspected`. A new check-in may only auto-assign rooms with `cleanlinessStatus IN (clean, inspected)` — prefer `inspected`.
- `heldStatus` non-NULL removes the room from every availability query, regardless of the other two axes.
- Every status change writes `statusChangedBy` (NULL = system) and an `audit_log` row.

### 4.2 Reservation lifecycle
```
waitlisted ──convert──► confirmed ──check-in──► checked_in ──check-out──► checked_out
     │                     │                                                 
     └──cancel──► cancelled◄──cancel──┘          no-show (audit job) ──► no_show
```
- **Waitlist:** `status = waitlisted`, `roomId = NULL`, no inventory lock. "Convert to Confirmed" locks room-type inventory (not a specific room). A combined "Confirm & Check In" is allowed ONLY when checkInDate = today (branch timezone).
- **Availability** counts: physical rooms of type − (overlapping confirmed/checked_in reservations) − blocked/OOO rooms, evaluated per night of the requested range.
- **Overbooking guard:** creating a reservation that exceeds availability requires `overbooking_config.allowOverbooking = true` for that branch AND the request to carry `acknowledgeOverbooking: true`; otherwise 409.
- Modifications after check-in (date extension, room move / split stay) post folio adjustments — they never mutate historical line items.

### 4.3 Check-in flow (server-side steps, single transaction where marked ⚛)
1. Validate reservation `confirmed`, checkInDate = today (or early check-in path).
2. **ID document 3-state logic:** no ID on file → require idDocType/Number (+ optional file); ID on file + `idDocExpiryDate > today` → skip; expired → require re-capture. Branch config flag `idCaptureMandatory` may force upload.
3. Room assignment: auto-assign algorithm = match room type → filter `occupancyStatus=vacant AND heldStatus IS NULL AND cleanliness IN (clean,inspected)` → score by (guest previous room, preferences JSONB: floor/view/bed, `inspected` over `clean`) → pick best. Manual override requires `overrideReason` (mandatory, audit-logged).
4. Early check-in: if now < branch.checkInTime, compute surcharge from branch policy (free-window + hourly rate); surcharge is posted ⚛ with check-in as a `room` line item.
5. ⚛ Atomically: reservation → `checked_in`; room → `occupied`; folio → `open` (create if absent); post first room-night if branch policy says "post at check-in" (default: night audit posts it); generate registration card PDF record (`registration_cards` row; PDF generation may be async but the row is not); store signature ref; write audit_log.
6. Queue check-in confirmation in `communication_log` (status `queued` — actual sending is a stubbed adapter in MVP).

### 4.4 Rate Resolver (v1.2 cascade model) — isolated service
**The frontend NEVER calculates rates. One endpoint returns everything the UI renders.**

Resolution per night N:
1. Fetch active override plans (`isOverride = true`) matching guest/reservation (negotiated link or valid promo code). If one applies → `finalRate = plan.amount` — **skip cascade entirely**.
2. Otherwise start `running = room_types.baseRate`.
3. Fetch ALL matching cascade plans for the branch+roomType where night N ∈ [validFrom, validTo] (and weekend plans where N's weekday matches), ordered by `cascadeTier ASC` (1 base-adjustment, 2 seasonal, 3 weekend, 4 corporate).
4. Apply each tier to the **running total** (percentage or fixed): season first, then weekend on top of the seasonal result, then corporate on top of that. Tiers stack — there is no single winner.
5. Corporate tier auto-activates when the guest's email domain or profile link matches a `corporate_accounts` agreement — never manually selected.
6. Write one `rate_audit_log` row per resolution: `{ finalRate, isOverride, overrideRatePlanId, cascade: [{tier, ratePlanId, amountBefore, adjustment, amountAfter}] }`.
7. Response shape powers stacked UI tags ("Seasonal +25% · Weekend +5%") and per-night breakdown — different nights may activate different tier combinations.

Manager rate override = separate endpoint (`POST /reservations/:id/rate-override`, manager role, mandatory reason) that pins an absolute nightly rate on the reservation — it is NOT a rate_plans row.

### 4.5 Folio & money rules
- A reservation can hold **multiple folios** (e.g. room charges → company folio, incidentals → guest folio). Every reservation gets one primary folio automatically; additional folios via `POST /reservations/:id/folios`. Split/transfer move line items between them with full audit trail.
- Line item = charge (has chargeType, increases balance). Payment = money received (has method, decreases balance). **Never mix.**
- `balance = SUM(line_items WHERE NOT voided/deleted) − SUM(payments WHERE isVoid = false)` — expose as a computed field, never store it.
- Room nights: posted **one per night by the night audit** (`postedBy = NULL`). Manual posting only for exceptions (early/late surcharges, upgrades).
- Taxes: the tax engine reads `tax_rules` per branch (rate, appliesTo chargeTypes, jurisdiction), posts tax as separate `chargeType = tax` line items linked via `taxRuleIds`, at the same time as the parent charge. Tax breakdown endpoint = GROUP BY rule: `{ruleName, rate, taxableBase, taxCollected}` + total.
- Deposits: `payments` rows with `paymentPurpose = deposit` at booking; at checkout post `deposit_application` referencing the original. Deposits NEVER appear in line_items or revenue reports.
- POS attribution chain: staff → `user_outlets` → outlet → `outlet.chargeType` stamped automatically + outlet name appended to description. One outlet = auto-selected; multiple = session-start selection (`activeOutletId` on the shift/session). POS staff never choose a charge type.
- Check-out ⚛: folio must reach balance 0 (or manager-approved AR flag) → post late-checkout surcharge if applicable → apply deposit → settle → reservation `checked_out`, room `vacant + dirty`, folio `settled`, housekeeping task auto-created.

### 4.6 Night audit (cron per branch, branch-local midnight + grace)
1. Acquire run: INSERT into `night_audit_log` (status `running`) — the `UNIQUE (branchId, auditDate)` violation aborts double runs.
2. For every `checked_in` reservation: resolve rate for the night just ended, post room-night line item + taxes.
3. Mark unarrived confirmed reservations for `auditDate` as `no_show` (+ `no_show_records` + penalty per branch policy).
4. Roll the business date; write `foliosProcessed`, `chargesPosted`, `totalAmountPosted`, `errors JSONB` (per-folio failures — continue on error, never abort the batch), status `completed`/`failed`.
5. Manual trigger endpoint (manager) uses the exact same service path; `triggeredBy` records the user.
6. Health rule: `running` older than 10 min = stuck → surfaced by health endpoint.

### 4.7 Guest identity & compliance
- ID text fields (type, number, expiry) mandatory at first check-in; image upload optional unless branch flag. Recapture only when expired.
- `idDocNumber` AES-256-GCM app-layer encryption; masked in all list/read responses (`A123····78`) except an explicit `?reveal=true` path restricted to manager role + audit-logged.
- GDPR: `gdpr_requests` supports export (JSON dump of guest's rows) and anonymization (irreversibly scrub PII, keep financial skeleton).

---

## 5. API Surface — aligned to `pms-frontend-structure.html` (the contract)

> **URL convention (from the frontend doc):** operational resources are **branch-scoped** — `/branches/:branchId/reservations`, `/branches/:branchId/rooms/status-board` — because the frontend's TenantContext navigates `/[brand]/[branch]/[module]`. Resources with globally-unique IDs are flat once created (`/reservations/:id`, `/folios/:folioId`). Follow the exact paths below; the frontend doc lists 120 endpoints and these are the MVP subset plus their supporting internals. All routes: `/api/v1` prefix, JWT + role guards, tenant scoping.

**auth & tenant** — `POST /auth/register`, `POST /auth/verify-email`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/accept-invite/:token`, `POST /tenants/configure-mode` (single/multi-brand step 2 of signup), `GET /auth/roles?tenantId=`, `PUT /auth/roles/:roleId/permissions`.

**staff** — `GET /branches/:branchId/staff`, `POST /branches/:branchId/staff/invite` (bulk rows: email+role each), `PATCH /staff/:userId` (role, outlets, active), `GET/PUT /users/:id/outlets`.

**property** — `POST /brands`, `GET /brands?tenantId=`, `PATCH /brands/:brandId`, `POST /brands/:brandId/branches`, `PATCH /branches/:branchId` (incl. checkIn/checkOut times, policies), `POST /branches/:branchId/buildings`, `POST /buildings/:buildingId/floors`, `POST /branches/:branchId/room-types`, `GET /branches/:branchId/room-types`, `POST /branches/:branchId/rooms/bulk` (range creation e.g. 301–320; when the branch has no explicit buildings/floors — Rooms-Only or Floors-Only onboarding mode — this endpoint auto-creates the hidden default parent rows per §1.1 and attaches rooms to them), `PATCH /rooms/:roomId/status` (validates §4.1 axis transitions), `POST /rooms/:roomId/block`, `PATCH /branches/:branchId/overbooking-config`, `PATCH /branches/:branchId/policies/no-show`, `PATCH /branches/:branchId/registration-card-template`.

**guests & corporate** — `GET /guests/search?q=`, `GET /guests/:guestId`, `PATCH /guests/:guestId`, `GET /guests/:guestId/id-state` → `first_visit | valid | expired`, `GET /guests/:guestId/stay-history`, `GET /guests/:guestId/communications`, **`POST /corporate-accounts`** + CRUD (email-domain ↔ rate agreement mapping that powers the corporate cascade tier auto-trigger).

**reservations** — `POST /branches/:branchId/reservations` (accepts `status: waitlisted`), `POST /branches/:branchId/reservations/walk-in` (channel auto-set `walk_in`, immediate check-in path), `GET /reservations/:id`, `PATCH /reservations/:id` (dates/guests — re-validates availability), `POST /reservations/:id/cancel`, `POST /reservations/:id/convert` (waitlist→confirmed; combined confirm+check-in only when checkInDate=today), `POST /reservations/:id/no-show` (manual mark), `POST /reservations/:id/reinstate` (undo no-show/cancel, re-validates availability), `POST /reservations/:id/walk` (relocate guest to another branch — creates walk_records row), `GET /branches/:branchId/availability?from=&to=&roomTypeId=`, `GET /branches/:branchId/rooms/available?checkIn=&checkOut=&typeId=`, `GET /branches/:branchId/rooms/earliest-available?roomTypeId=`, `GET /branches/:branchId/arrivals?date=today`, `GET /branches/:branchId/departures?date=today`, `GET /branches/:branchId/in-house`, `GET /branches/:branchId/waitlist`, `GET /branches/:branchId/no-shows/pending?date=today`, `GET /branches/:branchId/overbooking/exposure?from=&to=`, `GET /branches/:branchId/dashboard/live` (aggregate: arrivals/departures/occupancy/alerts for the front-desk home).

**rates** — `POST /branches/:branchId/rate-plans` + CRUD (reject `type=base`; validate cascadeTier↔type pairing), **`POST /rate-resolver/calculate`** `{branchId, roomTypeId, guestId?, checkIn, checkOut, promoCode?}` → per-night cascade breakdown + stacked tags + totals (the ONLY rate endpoint the frontend calls), `GET /rate-resolver/audit?reservationId=&from=&to=`, `PATCH /reservations/:id/rate-override` (manager, mandatory reason — pins absolute rate on the reservation, not a rate_plans row).

**front desk** — `POST /reservations/:id/check-in` (§4.3 payload), `POST /reservations/:id/check-out`, `PATCH /reservations/:id/assign-room` (manual override + mandatory reason), `PATCH /reservations/:id/upgrade-room` (category switch + folio adjustment), `GET /branches/:branchId/rooms/status-board`, `POST /reservations/:id/registration-card/generate`, `POST /registration-cards/:cardId/sign` (stores signature ref, embeds in PDF), `GET /registration-cards/:cardId/download`.

**folios & money** — `POST /reservations/:id/folios` (**a reservation can hold multiple folios** — e.g. room-to-company + incidentals-to-guest), `GET /folios/:folioId` (line items + payments + computed balance + tax suffixes per line), `POST /folios/:folioId/charges` (manual post, role-gated), `POST /line-items/:id/correct` (negative correction, reason mandatory), `POST /folios/:folioId/split` (move selected line items to a new folio), `POST /folios/:sourceFolioId/transfer` (between reservations/guests), `GET /folios/:folioId/transfer-history`, `GET /folios/:folioId/tax-breakdown` (per-rule GROUP BY §4.5), `POST /folios/:folioId/payments` (method + paymentPurpose), `POST /payments/:id/void` (manager + reason), `POST /folios/:folioId/refunds` (approval workflow), `GET /folios/:folioId/deposit-status`, `POST /branches/:branchId/tax-rules` + CRUD.

**POS & outlets** — outlets CRUD, `POST /pos/outlets/:outletId/menu-items` (minimal menu CRUD: name, price, taxable), `POST /pos/session` (active-outlet selection when staff has multiple), `POST /pos/orders` (line items against a room/folio or walk-in tab), `POST /pos/orders/:id/post-to-folio` (validates guest checked-in, stamps outlet + chargeType + taxes; Idempotency-Key required).

**housekeeping & maintenance** — `GET /housekeeping/tasks?assigneeId=me&date=today`, `POST /housekeeping/assignments` (distribute rooms to staff), `PATCH /housekeeping/tasks/:id`, `GET /branches/:branchId/rooms?status=clean&pendingInspection=true` (supervisor inspection queue), `POST /maintenance/work-orders`, `PATCH /maintenance/work-orders/:id`, `GET /maintenance/work-orders?branchId=&status=`, `POST /maintenance/assets`, `GET /maintenance/assets?branchId=` (creating a work order that takes a room out of service sets `heldStatus = out_of_order` atomically).

**shifts** — `POST /branches/:branchId/shifts/open` (cash float), `POST /shifts/:shiftId/close` (reconciliation: expected vs counted), `GET /shifts/:shiftId/summary`, `GET /branches/:branchId/shifts?from=&to=&agentId=`, `PATCH /shift-issues/:issueId`.

**night audit** — `POST /branches/:branchId/night-audit` (manual trigger), `GET /night-audit/history?branchId=`, `GET /night-audit/health`.

**comms** — `POST /reservations/:id/communications/send` (queues row; adapter stubbed), `GET /reservations/:id/communications`.

**reports** — `GET /reports/occupancy?branchId=&from=&to=&groupBy=day|week|month`, `GET /reports/revenue?branchId=&from=&to=&groupBy=department` (department = chargeType/outlet), `GET /reports/adr?branchId=&from=&to=`, `GET /reports/revpar?branchId=&from=&to=`, `GET /reports/tax-summary?branchId=&from=&to=`, `GET /reports/arrivals-departures`, `GET /reports/outstanding-balances`, all with `?format=csv`. **HQ rollups (multi-branch):** `GET /hq/overview`, `GET /hq/reports/occupancy?branchIds[]=&from=&to=`, `GET /hq/reports/revenue?branchIds[]=` — same report services, branch-array aggregation, HQ-role gated.

**admin & system** — `GET /audit-logs?branchId=&userId=&action=&from=&to=&page=&limit=`, `GET /system/feature-flags`, `PATCH /system/feature-flags/:flagId`, `GET /system/health`, `GET /system/backups?tenantId=`, `POST /gdpr/data-requests`, `GET /gdpr/data-requests/:id/export`.

## 6. Cross-Cutting Requirements

- **AuditInterceptor:** every mutating request writes `audit_log` (userId, tenantId, action, entity, entityId, before/after JSONB diff, IP). Skip GETs except `?reveal=true` reads.
- **Idempotency:** `POST /pos/charge`, check-in, check-out, and payments accept an `Idempotency-Key` header; duplicate keys within 24h return the original result.
- **Concurrency:** room assignment and availability checks use `SELECT ... FOR UPDATE` on candidate rows inside the transaction to prevent double-assignment; reservation creation re-validates availability inside the same transaction.
- **Money:** all arithmetic in integer kobo/cents or NUMERIC via Prisma.Decimal — never JS floats. Rounding: half-up at 2dp, applied per line item.
- **Time:** all business-date logic (night audit, "today", early/late windows) uses the **branch timezone**, never server time.
- **Config:** `.env` validated at boot (fail fast). Secrets never logged.
- **Errors:** never leak internals; `problem+json` with stable error codes (`RESERVATION_NOT_AVAILABLE`, `FOLIO_NOT_SETTLED`, `AUDIT_ALREADY_RAN`...).

## 7. Testing Requirements (Definition of Done per module)

1. Unit tests for every service; **Rate Resolver requires the full matrix:** base-only, base+seasonal, base+weekend, base+seasonal+weekend stacking order, corporate on top, override bypass, promo validation, per-night differences across a stay spanning a season boundary and a weekend.
2. Integration tests (Testcontainers Postgres): check-in ⚛ atomicity (inject failure mid-transaction → nothing persists), night audit idempotency (second run same date → rejected), RLS (tenant A can never read tenant B even with raw queries), deposit lifecycle, POS attribution chain.
3. E2E happy path: signup → onboard property → create rates → reservation → check-in → POS charges → night audit → check-out → reports reconcile to the kobo.
4. Every business rule in §4 has at least one test that fails if the rule is violated.
5. CI: lint (eslint strict), typecheck, tests, `prisma migrate diff` clean — all green before any phase is "done".

## 8. Build Order (phases map to the 6-month MVP timeline)

| Phase | Deliverable | Contents |
|---|---|---|
| **P0** | Skeleton | Nest app, Prisma schema (ALL 39 tables + enums in one initial migration), RLS policies, seed script, health endpoint, CI |
| **P1** | Identity & Property | auth, tenants, users/invites/roles, brands→rooms CRUD, 3-mode onboarding, room status axes |
| **P2** | Guests, Reservations & Rates | guest profiles + encryption, availability engine, reservation lifecycle incl. waitlist, **Rate Resolver + audit log**, overbooking guard |
| **P3** | Front Desk | check-in/check-out transactions, registration cards, auto-assign algorithm, early/late surcharges |
| **P4** | Money | folios, line items, tax engine, payments/deposits/refunds, folio transfer, outlets + POS attribution, **night audit** |
| **P5** | Ops & Reporting | housekeeping, shifts, no-show job, reports + CSV, comms log stubs |
| **P6** | Hardening | audit coverage review, GDPR endpoints, idempotency sweep, load test availability + resolver, backup verification |

Each phase ends with: migrations applied cleanly to a fresh DB, all tests green, Swagger docs regenerated, and a short `PHASE_NOTES.md` summarizing decisions/deviations for review.

## 9. Explicit Non-Goals (MVP) — frontend sections that exist in the doc but are NOT built now
The frontend architecture doc contains post-MVP sections whose endpoints must **return 501 Not Implemented from clearly-marked stub controllers** (so the frontend can detect and hide them), not be silently omitted:
- **RMS:** `/rms/forecast`, `/rms/comp-set`, `/rms/rate-recommendations*`, `/rms/restrictions`
- **Loyalty & marketing:** `/loyalty/programs`, `/marketing/campaigns`
- **Integrations:** `/branches/:id/channel-manager/connect`, `/integrations/payment-gateway`, `/webhooks`, `/api-keys` (OTA channel enum + reservation webhook handler stub only)
- **Events & groups:** `/branches/:id/events`, `/branches/:id/event-spaces/calendar`, `/branches/:id/group-blocks`
- **System restore:** `POST /system/backups/:backupId/restore` (list is MVP; restore is not)
Also out of MVP scope: real payment gateway processing (manual payment marking only), real email/SMS dispatch (`communication_log` rows with status `queued` only), multi-currency (branch currency only), mobile/guest-facing endpoints.

---
*Companion references: `pms-database-architecture.html` (schema v1.2), `pms-frontend-structure.html` (consumer of this API), `pms-mvp-timeline.html`.*
