# Phase Notes

## No-Show Handling — manual mark/waive/reinstate, unified with Night Audit's own automated sweep (2026-08-28)

Per the MVP timeline reference (Month 3): a pending-arrivals dashboard, atomic mark-as-no-show (penalty + room release + folio), manager waive, and late-arrival reinstatement. `NoShowRecord`/`Branch.noShowPolicy` were already in the schema, and — found while scoping this, not assumed — `NightAuditService` already had a private, *automated* no-show sweep from an earlier phase (`markNoShows`, gated on `noShowPolicy.autoMark`, penalty math in a private `penaltyAmountFor`). What Night Audit's own version never did: post the computed penalty as an actual folio charge. It created a `NoShowRecord` carrying a `penaltyAmount` figure and stopped there — a number sitting on a record, with no real billing consequence for the guest. The reference's own wording for the manual path — "penalty **posted**" — settled that this was a real gap, not a deliberate simplification worth preserving.

### The fix, and why it isn't duplicated
Rather than build a second, separate "manual mark" implementation next to Night Audit's own, the actual state-transition logic — status flip, `NoShowRecord`, penalty charge, folio settle — moved to `ReservationsService.markNoShowInTx` (a reservation-lifecycle concern belongs there, matching check-in/check-out/cancel, and the reference's own route is `POST /reservations/:id/no-show`, not a night-audit-scoped one). `NightAuditService.markNoShows` now calls it too, so an automated midnight-marked no-show and a front-desk-marked one get byte-for-byte identical treatment — the exact gap above is closed for BOTH paths in one fix, not just the new one. `NightAuditModule` now imports `ReservationsModule` (checked for cycles first — safe, nothing in `ReservationsModule`'s own tree touches `NightAuditModule`).

### A real nested-transaction bug caught before it shipped
`reinstateFromNoShow`'s optional `waivePenalty` needs to run INSIDE its own already-open transaction (revised dates + a penalty reversal have to commit or fail together). The public `waiveNoShowPenalty` opens its OWN `withTenant`/`$transaction` — calling it from inside another one would nest two independent Postgres transactions, breaking atomicity and risking a lock conflict against rows the outer transaction already holds (the exact class of bug the confirmation-number SAVEPOINT fix earlier this session was about). Caught by reasoning through the call graph while writing it, not live — split into a public `waiveNoShowPenalty` (opens its own tx) and a private `waiveNoShowPenaltyInTx` (takes an existing one), same shape `markNoShow`/`markNoShowInTx` already established. `reinstateFromNoShow` calls the `tx`-taking version.

### Folio-posting primitives generalized, not duplicated
- **`FoliosService.postAdHocCharge`** — the same cross-service, in-transaction posting primitive `postRoomChargeForDate` already was, generalized for a caller that isn't posting a room night. A negative amount reverses a charge (and its tax, proportionally, for free — `writeChargeWithTaxes` computes tax off whatever signed `amount` it's given) as a `chargeType: 'correction'` row — the append-only discipline `correctLineItem` already uses, but without needing to look up and diff against an original row: waiving a penalty already knows the exact amount to reverse (`NoShowRecord.penaltyAmount`).
- **`FoliosService.settleIfFullyPaid`** gained a required `via: string` param. It hardcoded `viaCheckOut: true` in its own audit metadata — accurate when check-out was its only caller, a real lie once a no-show settling at zero balance called the exact same method. `checkOut`'s own call site updated to pass `'checkOut'` explicitly; no more implicit assumption baked into a shared method.

### A second real bug, found live: no-show wasn't a City Ledger status
`FoliosService.deriveGuestStatus` only recognized `checked_out` (→ `city_ledger`) and `checked_in` (→ `in_house`) — a `no_show` reservation with a real unpaid penalty fell through to `null`, invisible to anyone scanning the folio list's Outstanding/Overdue filters for what's actually owed. A no-show who owes a penalty is a City Ledger receivable too — arguably more so than a checked-out guest, since there's no ongoing in-house relationship left at all. Added `no_show` alongside `checked_out` in the `city_ledger` branch.

### Other pieces
`RESERVATION_INCLUDE` gained `noShowRecords` (latest mark only, `take: 1` — the only consumer, the No-Show Handling screen, never needs history, just the current state). `listPendingNoShows` reuses the exact query shape `NightAuditService.getPreflight`'s own `unresolvedNoShows` already runs, exposed as its own dashboard reachable any time during the day rather than buried inside "is it safe to run the audit."

### Deferred, named
No override on `penaltyType` at mark time — both the manual and automated paths always use the branch's own `noShowPolicy.defaultPenalty`, matching the reference's own flow (no picker shown). `cutoffTime` (a time-of-day threshold) is part of the schema's own `noShowPolicy` comment but unused by `listPendingNoShows` — matches `NightAuditService.getPreflight`'s own pending-no-shows query, which was already date-only, not time-of-day; introducing cutoffTime logic where the existing precedent didn't need it was out of scope for this pass.

### Verified
`npx tsc --noEmit`, `npm run lint`, `npm test` — 247 tests (17 new across `reservations.service.spec.ts`'s `markNoShow`/`markNoShowInTx`/`waiveNoShowPenalty`/`reinstateFromNoShow`/`listPendingNoShows`, `night-audit.service.spec.ts`'s rewritten no-show-marking block — now asserting the shared method is called correctly rather than re-testing penalty math at the wrong layer, `folios.service.spec.ts`'s `postAdHocCharge`, `settleIfFullyPaid`'s `via` label, and 4 new `listFolios`/`deriveGuestStatus` cases covering the fix directly).

Live, against real Postgres, the full loop through the actual UI: created a confirmed reservation → Pending No-Shows dashboard showed it → marked it as a no-show → confirmed via the API that status flipped, a `NoShowRecord` was created with the branch's `first_night` penalty (`confirmedRate / nights`), a folio existed with that penalty PLUS tax as its balance, and `guestStatus: "city_ledger"` (the fix, confirmed live) → waived the penalty through the UI → confirmed the correction posted and the folio auto-settled to a zero balance with `guestStatus` back to `null` → reinstated with new dates through the UI → confirmed the reservation was `confirmed` again with the new dates and a freshly re-resolved rate → confirmed the Rate Resolver audit trail for all of this serializes cleanly (the earlier `BigInt` fix holding up under a second, unrelated feature exercising the same endpoint).

### Carried forward
- Everything from the entry below — unchanged.

## Rate Resolver Service — cascade/override pricing, replacing flat baseRate × nights (2026-08-28)

Per the MVP timeline reference (`pms-mvp-timeline.html`, Month 2): "RateResolverService in NestJS — pure, stateless, injectable... every screen that shows a price calls it... prevents rate drift and makes all pricing auditable." Every reservation up to this point priced at flat `roomType.baseRate × nights` (named explicitly as a gap in the old Reservations hub comment and `createReservationRow`'s doc comment) — this closes it.

### Reconciling the reference's prose against the actual schema
The reference's own priority list — "manual override → corporate → promo → negotiated → seasonal → weekend → base" — doesn't literally match `RatePlan`'s already-existing schema (built in an earlier pass, ahead of this one): `type` splits into cascade tiers (`base`/`seasonal`/`weekend`/`corporate`, `cascadeTier` 1–4, layered additively) and overrides (`negotiated`/`promotional`, `isOverride: true`, which "skip the cascade entirely" per the schema's own field comment). Two things needed resolving, not just implementing literally:

- **"Manual override" isn't a `RatePlan` at all.** It's `Reservation.overrideRate` — a manager's absolute-nightly escape hatch, already wired into `FoliosService`/`NightAuditService` at charge-posting time, independent of any rate plan. The resolver doesn't take a "manual override" input; that mechanism was already correct and untouched.
- **"Corporate" in the prose has no schema counterpart of its own.** `CorporateAccount.ratePlanId` — "negotiated agreement plan" — points at a `type: negotiated` override, not the `type: corporate` cascade tier. Read that way the two lists agree: a caller's corporate account outranks a generic promo code. Implemented as: negotiated (matched via `corporateAccountId`) beats promotional (matched via `promoCode`) when both apply to the same night.

`RateAuditLog.result`'s own schema comment (`{finalRate, isOverride, overrideRatePlanId, cascade:[...]}`) settled the last design question: the resolver operates **per night**, not once per stay — needed anyway since seasonal/weekend tiers can vary night to night, and confirmed by the comment describing a single `finalRate`, not an array.

### What it does
`resolveNight` (pure, per-date): fetches active plans matching branch + (this room type or branch-wide) + date range + minLOS; an override plan wins outright at its absolute `amount`; otherwise cascade-tier plans apply in `cascadeTier` order, each adjusting a running total from `roomType.baseRate` (fixed = flat delta, percentage = adjusts the running total, not the original base). Two plans colliding at the same tier for the same night (a data-hygiene edge case) resolve to one: room-type-specific over branch-wide, then most recent. `resolveStay` loops every night, sums to `subtotal`, adds tax via `TaxesService.computeTaxesForCharge(..., 'room', subtotal)` for `totalWithTax`, and writes one `RateAuditLog` row per night.

`createReservation`/`walkIn`/`modifyReservation` all call it now instead of the deleted `calculateFlatRate`; `confirmedRate` is the resolved `subtotal` (tax stays a Folios/charge-posting concern, never baked into the stored rate). `Reservation.ratePlanId` gets the check-in night's winning plan — display/reporting only; a stay whose rate changes mid-week has no single "the" plan, the per-night `RateAuditLog` trail is what's authoritative.

New module `rate-resolver/`: rate-plan CRUD (`POST`/`GET /branches/:id/rate-plans`, `PATCH /rate-plans/:id` — `isActive` toggle, never deleted, same as `TaxRule`) and the resolver itself (`POST /branches/:id/rate-resolver/calculate` for a pre-booking quote, `GET /rate-resolver/audit?reservationId=` for the full per-night trace). `cascadeTier` is never client-supplied — derived from `type` alone, enforced server-side (a cascade type without `adjustmentType`, or an override type WITH one, or a promotional plan without a `promoCode`, all reject).

### Two real bugs found live, not by inspection
1. **`RateAuditLog.id` is a BigInt** (BIGSERIAL, same convention as `NightAuditLog`) — `getAuditTrail` returned raw rows straight from Prisma, and the first real row it ever served crashed with `TypeError: Do not know how to serialize a BigInt`, a genuine `500`. Fixed the same way `NightAuditService.listRuns` already had to: `.toString()` the id before it crosses the HTTP boundary.
2. **`createReservation`/`walkIn` resolve the rate BEFORE the reservation row exists** — there's no id yet to attach, so those `RateAuditLog` rows wrote `reservationId: null` (the schema's own comment anticipates exactly this: "NULL during pre-booking calculation"). Left there permanently, though, the audit trail for the ONE calculation that actually set the guest's price — the one a real dispute needs — would be unlinkable forever, defeating the endpoint's stated purpose. Fixed by switching `createMany` to individual `create` calls (needed their own returned ids anyway), returning `auditLogIds` from `resolveStay`, and backfilling `reservationId` onto them the moment the reservation is created (`RateResolverService.linkAuditLogsToReservation`, called from both `createReservation` and `walkIn` right after `createReservationRow`). `modifyReservation` never had this problem — the reservation already exists when it resolves.

### Deferred, named
`ModifyReservationDto` doesn't accept `promoCode`/`corporateAccountId` — a modify re-resolves through base/cascade tiers only, so a promo/negotiated discount active at original booking is silently dropped on a date/room-type change. Carrying it forward is real, deferred work, not a silent gap.

### Verified
`npx tsc --noEmit`, `npm run lint`, `npm test` — 226 tests (19 new in `rate-resolver.service.spec.ts`: cascade math including percentage-on-running-total and same-tier collision resolution, override precedence including the negotiated-beats-promotional tie-break, tax integration, BigInt-to-string on `getAuditTrail`, the `auditLogIds`/`linkAuditLogsToReservation` backfill mechanism itself; 2 new in `reservations.service.spec.ts` covering the wiring — right args passed to the resolver, `ratePlanId` stored, the backfill actually fires with the resolver's own returned ids and the real new reservation id).

Live, against real Postgres: created a Weekend cascade plan (+25 fixed) through the actual UI, watched `RatePreview` on Create Reservation resolve it live (`115.00/night avg, 230.00 subtotal, 247.25 with tax` — matches `90 baseRate + 25` × 2 nights, tax included correctly), submitted the booking and confirmed `confirmedRate = 230.00` via the API (ground truth, not just the UI). Confirmed a promotional override replaces the rate outright (`ruleApplied.type: "override"`) rather than stacking with the cascade. Retired the plan through the UI and confirmed a fresh quote for the same dates fell back to the plain base rate. Both bugs above were caught and confirmed fixed this same way — a raw `curl` against `/rate-resolver/audit` 500'd before the fix and returned clean, correctly-linked rows after.

### Carried forward
- Everything from the entry below — unchanged.

## Fix — confirmationNumber was globally unique, generated from a per-branch counter, and RLS hid the collision from its own check (2026-08-28)

Found live: a real walk-in for Sope Hotel Abijo (0 reservations so far) failed with a generic `409 Could not create reservation`, even against a fully clean, unheld, unblocked room. Traced with direct DB queries (bypassing the app, `set_config('app.tenant_id', ...)` under the real RLS policy) rather than guessing: the room itself was fine. The problem was one layer up, in how confirmation numbers are minted.

### The bug
`confirmationNumber` was a bare `@unique` column — unique across the ENTIRE database, all tenants. But `generateConfirmationNumber` predicts candidates (`RES-2026-00001`, `00002`, …) from a purely per-branch count, with no tenant or branch identifier in the string itself. On this dev DB, dozens of other test tenants exist, and one of them (`lodgic-test-hotel-group-6705d1`) already held `RES-2026-00001` through `00010` — the exact range a fresh, low-activity branch would generate first.

The check meant to catch this collision couldn't: `generateConfirmationNumber`'s `findUnique({ where: { confirmationNumber: candidate } })` runs under the caller's own tenant context, and Row-Level Security filters out every row belonging to another tenant — so the probe legitimately saw "no clash" and returned a candidate that was, from a different angle, already taken. The real `INSERT` then hit the actual Postgres unique index, which isn't RLS-filtered, and threw a genuine `P2002`. `createReservationRow`'s retry (see the entry below) caught it correctly and asked for a new number — but the branch's own reservation count hadn't changed, so `generateConfirmationNumber` produced the *identical* doomed candidates and collided identically, three times in a row, every time. Not a rare race: fully deterministic given this DB's existing data, and — more importantly — a latent bug for production too, since any two real hotel tenants can independently mint the same low confirmation number for the same year.

### The fix
Scoped the constraint to match what the number was always meant to mean ("sequence per branch"): `@@unique([tenantId, confirmationNumber])` in place of the bare `@unique` (migration `20260828000000_confirmation_number_scoped_to_tenant`, hand-written — `prisma migrate dev`'s shadow-database diffing isn't available against this DB user, same constraint noted for the earlier RLS migrations). `generateConfirmationNumber` now takes `tenantId` and probes via the composite key (`tenantId_confirmationNumber`), so the check is scoped to exactly what the index enforces and can't be blinded by RLS again. All three call sites updated: `createReservation`, `walkIn`, and `createReservationRow`'s own retry (which only had `data.tenantId` in scope, not a bound variable — used that).

### Verified
`npx tsc --noEmit`, `npm run lint`, `npm test` (199 tests, 1 new: asserts the collision probe is called with the composite key, scoped to the calling tenant, not the bare column). Live against real Postgres, in a single transaction that was always rolled back afterward (no data persisted): confirmed Sope Hotel can now claim `RES-2026-00001` even though `lodgic-test-hotel-group-6705d1` already owns that exact string — the reported bug — and confirmed a second `RES-2026-00001` for Sope Hotel itself still correctly fails unique-constraint validation, so scoping was tightened, not removed.

### Carried forward
- Everything from the entry below — unchanged.

## Fix — confirmation-number collision retry poisoned its own transaction (2026-08-28)

Found live, not by inspection: a real dev-server log showing `PrismaClientUnknownRequestError` / `25P02 "current transaction is aborted, commands ignored until end of transaction block"` at `generateConfirmationNumber`'s own `tx.reservation.count()` — a query with nothing wrong with it, which was the first clue the real failure was upstream.

### The bug
`createReservationRow`'s retry loop catches a `P2002` (confirmation-number collision) from `tx.reservation.create()` and, on catching it, calls `generateConfirmationNumber(tx, ...)` again to pick a new candidate — issuing more queries on the **same** Prisma interactive transaction. Postgres aborts the entire surrounding transaction the instant any statement inside it fails, unique-constraint violations included; every later statement on that same transaction then errors with `25P02`, no matter how unrelated it is to whatever actually failed. So the retry's own recovery queries were guaranteed to fail with a confusing, misattributed error — not a second, cleaner collision retry — the moment a real confirmation-number collision ever happened. The existing test for this path only simulated a collision during `generateConfirmationNumber`'s own *prediction* step (a `findUnique` mock), never an actual `tx.reservation.create()` failure — the one path that actually exercises the retry-after-INSERT-failure logic — so it gave false confidence.

### The fix
A `SAVEPOINT` per attempt. `ROLLBACK TO SAVEPOINT` undoes only the failed insert, leaving the outer `withTenant` transaction healthy for the retry's own queries and for whatever the caller does next; `RELEASE SAVEPOINT` on success. Standard Postgres pattern for "catch an error and keep using the same transaction," which Prisma's interactive transactions don't do automatically. Also fixed a second, smaller issue while in this code: on the final (3rd) attempt, a real collision was rethrowing the **raw Prisma error** instead of the app's own clean `ConflictException` — a caller saw an unwrapped Prisma exception rather than a proper problem+json `409 CONFLICT`. Non-collision errors (a real connection failure, a different constraint) still roll back their savepoint and rethrow immediately, unwrapped and unretried — those are someone else's problem, not a confirmation-number issue.

### Verified
`npx tsc --noEmit`, `npm run lint`, `npm test` (198 tests, 3 new: a real insert-time collision recovers via a savepoint and the SAVEPOINT/ROLLBACK/RELEASE calls happen in the correct order relative to the retry; exhausting all 3 attempts on real collisions throws the clean `ConflictException`, not the raw Prisma error; a non-collision error still rolls back its savepoint but rethrows immediately without retrying).

Live, against real Postgres — 15 truly concurrent `POST .../reservations` calls for the same room type and date window (a genuine stress test, not a mock): every single response came back either a clean `201` with a real, unique confirmation number, or a clean `409`; zero raw errors, zero mentions of the transaction-abort message anywhere in any response. Before this fix, that same concurrent load was what produced the original leaked `25P02`.

### Carried forward
- Everything from the Housekeeping entry below — unchanged.

## Housekeeping module — tasks, staff assignment, room blocking (2026-08-28)

Frontend half in `roomick-pms-frontend/PHASE_NOTES.md`. Next in the reference's own sequence after Reservations (ref p27-31): Task Board, Staff Assignment, Inspection Workflow, Room Blocking/OOO.

### Delivered
- **New `housekeeping` module**, built around `HousekeepingTask` — a schema model that already existed with every field this needed (`assigneeId`, `status`, `priority`, `triggerEvent`, `triggeredByReservationId`, `notes`, `completedAt`/`completedBy`) but had no service touching it at all before this.
  - `createTask` / `createTaskInTx` — the latter takes an already-open transaction so `ReservationsService.checkOut` can create one in the SAME transaction as the checkout itself, `triggerEvent: 'checkout'`, `triggeredByReservationId` set — Task Board now reflects a checked-out room automatically, the same "the schema's own fields exist for exactly this" reasoning `postRoomChargeForDate`'s date guard used.
  - `listTasks` — filterable by status and/or assignee; powers both Task Board ("my assigned rooms" = `assigneeId: me`) and the hub's own stats.
  - `startTask` — **self-claims an unassigned task** rather than requiring pre-assignment: the reference's own Task Board shows plain cards any housekeeper can act on, so a task nobody has claimed yet can be started by whoever picks it up; a task someone else already claimed can't be taken over. Drives the room's cleanliness ladder (dirty → cleaning) in the same transaction, reusing `RoomsService`'s own `CLEANLINESS_TRANSITIONS` map (now exported) rather than a second hand-copied ladder.
  - `completeTask` — same self/assignee rule, drives cleaning → clean, records `completedAt`/`completedBy`. Inspection is a deliberately separate, later step — see below.
  - `assignTask` — supervisor-only (`owner`/`manager`, the same set `RoomsService.isSupervisorAt` already uses), for Staff Assignment's "distribute rooms to housekeepers."
  - `listHousekeepers` — reuses `UsersService.listStaff` (already returns every staff member's roles at a branch) filtered to the `housekeeper` role, rather than a second staff query.
  - `reportIssue` — marks a task `skipped` and appends the area/description to its `notes`. Deliberately does **not** create a `RoomBlock`: whether a reported issue is serious enough to pull a room from inventory is a supervisor's own call in Room Blocking/OOO after reviewing the report, not an automatic consequence of reporting it.
- **`RoomsService` gained `listActiveBlocks`/`unblockRoom`** — `blockRoom` (create) already existed from an earlier phase, but nothing could list current blocks or end one early. `unblockRoom` pulls `toDate` back to today rather than deleting the row — the same "correct forward, preserve history" preference the append-only money ledger uses, applied to inventory.
- **`CLEANLINESS_TRANSITIONS` exported** from `rooms.service.ts` so `HousekeepingService`'s own room-status transitions validate against the exact same ladder, not a duplicate.

### Decisions & deviations
1. **Inspection Workflow needed zero new backend surface.** `clean → inspected` (supervisor-only) and the drop-back-to-`dirty` transition both already existed on `RoomsService.changeStatus` from the very first Room Status Board phase — the frontend's Inspection Workflow page calls that endpoint directly. Approve and Reject were never missing; nobody had built the page in front of them yet.
2. **Report Issue has no image upload.** The reference's modal includes one; it needs encrypted file storage that doesn't exist (`GuestProfile.idDocUrl`'s own comment already names the same gap for ID documents). The area-of-issue + description half is real and stored; images are deferred.
3. **No new `MaintenanceIssue` table.** A reported issue lives in the task's own `notes` field — the schema already has a `skipped` status on `HousekeepingStatus` for exactly "this room needs something other than a normal clean," and a dedicated issue-tracking table would be new schema surface for a need the existing model already covers at this scope.

### Verified
`npx tsc --noEmit`, `npm run lint`, `npm test` (195 tests total, 21 new — 16 for `HousekeepingService`: self-claim start/complete and the ownership/ladder rejections, supervisor-gated assign, report-issue appends without creating a block, `listHousekeepers` filters correctly by branch/NULL-branch role; 4 for `RoomsService`'s new block methods; 1 confirming `checkOut` creates a housekeeping task traceable to the reservation that triggered it).

### Carried forward
- Image uploads for Report Issue, a dedicated maintenance-issue table, Rate Plan Management, group/multi-room bookings, ID capture, payment/deposit at booking, cancellation policy + penalty/refund, per-room Gantt-view availability, Modify for an already-checked-in stay — all named, all deferred.
- Everything else already carried forward from the Reservations entry below — unchanged.

## Reservations module — search, availability calendar, modify, waitlist (2026-08-28)

Frontend half in `roomick-pms-frontend/PHASE_NOTES.md`. The reference's own sequence is Front Desk → Reservations → Housekeeping → Billing and Payments; Billing was done, so this is Reservations — six cards (Availability Calendar, Create, Modify, Cancel, Waitlist, Rate Plan Management), and the sidebar's "Reservations" row had pointed nowhere since Phase 24 flagged it inert.

### Delivered
- **`GET /branches/:branchId/reservations`** — general search/filter (status, and/or confirmation number or guest name, case-insensitive, capped at 100 rows). The one thing missing for Modify/Cancel/Waitlist's own "find the reservation" step and the hub's own stat cards.
- **`GET /branches/:branchId/availability-calendar`** — every active room type at the branch, per-night available counts across a full month. Loops the existing `computeAvailabilityPerNight` per room type rather than a combined query — branches have a handful of room types, and reusing already-correct logic beat a riskier rewrite.
- **`PATCH /reservations/:reservationId/modify`** — dates, room type, party size, on a `confirmed`/`waitlisted` reservation only. Re-checks availability EXCLUDING the reservation's own current hold (new `excludeReservationId` param threaded through `computeAvailabilityPerNight`/`assertAvailableForStay`) so changing something about a booking doesn't get rejected for "conflicting" with itself. Recomputes `confirmedRate` from the (possibly new) room type's `baseRate × nights` — same flat-rate derivation everything else in this app uses. `reason` is mandatory, mirroring `FoliosService.correctLineItem`'s append-only discipline applied to the reservation itself.
- **Waitlist, end to end**: `CreateReservationDto.joinWaitlist` skips the availability check and books as `waitlisted` instead of `confirmed` — an explicit request, not an automatic fallback when a normal booking fails. **`POST /reservations/:reservationId/promote`** re-checks availability for a waitlisted reservation's own dates/room type and confirms it if a room has opened up; throws the same `RESERVATION_NOT_AVAILABLE` a normal booking would if nothing has, and the reservation stays waitlisted.
- **`RESERVATION_INCLUDE` gained `branch: { select: { currency } }`** — reservations carry no currency of their own (a reservation's money is always the branch's), and Modify Reservation's cost preview needed one without a second round-trip.

### Decisions & deviations (the full reference vs. what shipped)
The reference's Create/Modify/Cancel screens are each a full page of machinery this pass doesn't build — named explicitly, not silently dropped:
1. **No rate-plan resolver.** Every price here is flat `baseRate × nights`, same as Walk-In Booking and check-in already use. The reference's promotional-code/negotiated-rate/base-rate picker needs a cascade-tier resolver — a module on the scale of Taxes or Folios, not a slice of this one. **Rate Plan Management stays inert** on the hub for exactly this reason, even though `RatePlan` already exists as a schema model.
2. **Create Reservation is individual-only** — no group/multi-room booking, no ID capture, no payment/deposit collection at booking time. Each of those is a real subsystem (group-booking semantics, encrypted ID-document storage, a payments-at-booking flow) that doesn't exist yet.
3. **Modify Reservation is pre-check-in only** (`confirmed`/`waitlisted`). A `checked_in` stay already has folio charges posted against its original dates (§4.5's append-only ledger) — shortening or extending it needs charge corrections, not a plain field update. That's real, separate work, deferred here.
4. **Cancel Reservation has no cancellation-policy or penalty/refund calculation.** The reference's Cancellation Policy Summary and Penalty & Refund section both assume a branch-level cancellation-policy concept that doesn't exist in the schema — nothing like `Branch.noShowPolicy` for cancellations. `ReservationsService.cancel` (already built, unchanged this pass) does exactly what it always did: flip to `cancelled` with an optional reason.
5. **The Availability Calendar is per-room-TYPE, not per-room.** The reference draws a Gantt chart — individual room rows, guest-name bars spanning their exact stay. This returns per-night AVAILABLE COUNTS per room type instead; the full per-room view is a real visualization project (the same day-by-day occupancy data the Room Status Board already renders live, but for TODAY only — extending that to an arbitrary month of individual reservation bars wasn't a slice of this phase).

### Verified
`npx tsc --noEmit`, `npm run lint`, `npm test` (174 tests total, 18 new for reservations: `joinWaitlist` skips the availability check and creates as waitlisted, still rejects an invalid range, a normal booking's zero-availability rejection is unchanged; `modifyReservation` rejects checked_in/cancelled, recomputes the rate for the new night count, re-checks availability excluding its own hold, skips that check entirely for a waitlisted reservation or when nothing that affects availability changed, rejects an invalid range, rejects when the new dates/room type have no room, leaves unset fields unchanged; `promoteFromWaitlist` rejects non-waitlisted, promotes when available, stays waitlisted (throws) when not; `listReservations` filters by status, searches confirmation number OR guest name case-insensitively, caps at 100; `getAvailabilityCalendar` returns every active room type's per-night availability for the requested month).

Live, against real data, including two paths that only prove anything under a GENUINELY exhausted room type (not a mocked failure — every unit of a real room type was actually booked out first via direct API calls): Create Reservation against a full room type returns `RESERVATION_NOT_AVAILABLE` and offers the waitlist path; joining the waitlist creates a real `waitlisted` reservation; promoting it while still full correctly fails and leaves it waitlisted.

### Carried forward
- Rate Plan Management, group/multi-room bookings, ID capture, payment/deposit at booking, cancellation policy + penalty/refund, per-room Gantt-view availability, Modify for an already-checked-in stay — all named above, all deferred.
- Housekeeping (Task Board, Staff Assignment, Inspection Workflow, Room Blocking/OOO — ref p27-31) is next in the reference's own sequence and hasn't been started.
- Everything else already carried forward from the Split Billing entry below — unchanged.

## Split billing — additional folios and charge transfer (2026-08-27)

Ref p34. A reservation can now carry more than one folio, and posted charges can move between them — the company pays the room, the guest pays the minibar.

### Delivered
- **`createAdditionalFolio(tenantId, reservationId, label)`** — every non-primary folio is named. The primary one keeps `label: null`, which is what identifies it; a second unnamed folio would make "which is the primary" ambiguous, so the label is required here and rejected if blank.
- **`splitFolio(tenantId, sourceFolioId, {targetFolioId, lineItemIds, reason})`** — one transaction. Validates source ≠ target, that both folios belong to the *same reservation* (moving a charge onto an unrelated guest's bill is a manager-approved `transfer`, a separate deferred operation), that neither is settled, and that every named line item genuinely belongs to the source and isn't voided.
- **Re-parenting `folioId` is not an append-only violation.** §4.5's rule is about money — "no UPDATE of amounts, no DELETE". No amount changes in a split and the combined balance across both folios is identical before and after; only which bill an existing, unmodified charge sits on. `FolioTransfer.lineItemIds` snapshots exactly what moved, which is the shape the schema was built for.
- **`getTransferHistory(folioId)`** — every transfer this folio was either source or target of, with its mandatory reason and `approvedBy`.

### Decisions & deviations
1. **Tax rows do not follow their parent automatically.** Tax lines are independent ledger entries — `taxRuleIds` names the *rule*, not the charge, so the schema has no parent link to walk. Inferring one by matching description strings would break the first time a description is edited. The UI surfaces the tax rows as separately selectable instead, so moving a charge with its tax is a deliberate two-row selection rather than a guess.
2. **The combined balance across both folios is invariant.** Nothing is created or destroyed by a split — asserted directly, because a transfer that changes the total is a money bug.
3. **Folio transfer *between reservations* stays deferred**, as does Cloudbeds-style Transfer-to-AR. Both were already named as deferred in the folios entry below and remain so.

### Verified
`npx tsc --noEmit`, `npm run lint`, `npm test` — 28 folio tests, 6 of them new for the split: reassigns the folio without touching any amount and snapshots what moved; records the transfer amount as the sum of what moved (balance conserved across the pair); rejects splitting a folio into itself; rejects a target on a different reservation; rejects line items that don't belong to the source; rejects splitting out of a settled folio.

## Night audit — accrual rollover, no-shows, check-out safety net (2026-08-27)

Completes the accrual model the folios phase set up. `postRoomChargeForDate` and its per-date guard were built for exactly this; night audit is the loop that calls them, so nothing about the posting logic is duplicated here.

### Delivered
- **`src/modules/night-audit/`** — `runAudit(tenantId, branchId, auditDate, triggeredBy)`: writes the `night_audit_log` row first (the `@@unique([branchId, auditDate])` constraint is what actually prevents a double run — a check-then-act guard alone would race two concurrent triggers; the explicit pre-check just turns the common case into a clean `409 AUDIT_ALREADY_RAN`), posts the night that just ended for every reservation occupying it, marks no-shows, then completes the log with counts and errors.
- **Continue-on-error** per spec §4.6 — a single broken folio is recorded in `errors[]` and the batch carries on. One bad reservation must never stop a branch's whole close-out.
- **Occupancy definition**: `checkInDate <= auditDate < checkOutDate`. The departure day is never a billable night.
- **No-show marking** with penalties from `branch.noShowPolicy`: `first_night` (per-night rate), `full_stay` (`confirmedRate`), `flat_fee` (policy amount), `none`. Honours `autoMark: false` — a property that wants front desk to make that call gets left alone rather than having reservations silently flipped.
- **`FoliosService.backfillRoomCharges`** + a **check-out safety net**. The in-house PMS has exactly this and says why: the audit runs early-morning, so a guest departing before it would otherwise leave with last night un-posted. Bills `[checkInDate, min(today, checkOutDate))` — every elapsed night, never one that hasn't happened. Idempotent, since each night still goes through the per-date guard.
- **Timezone-aware sweep** (`night-audit.scheduler.ts`): hourly, not once-a-day. Branches carry their own IANA timezones, so the in-house PMS's single fixed-time cron would fire at the wrong local hour for most of them; each pass asks per branch whether *its* local clock has passed the audit hour. Enumerating tenants without a request works because `tenants` is deliberately outside the RLS carve-out; every per-tenant read then goes back through `withTenant`. Suspended/cancelled tenants are skipped — they aren't operating, so nothing should be accruing.
- **`getPreflight`** — what date would close, whether it already ran, due-outs, open folios, unresolved no-shows.

### Decisions & deviations
1. **Two of the reference's three pre-audit checks report `passed: null`, not a tick.** "No blocking maintenance issues" and "Night shift is open" need the maintenance and shift modules, which don't exist. Reporting them as passing would make the checklist a lie; they surface as "Not tracked" instead.
2. **Scheduler split from the service** so the service stays a plain callable unit — the manual trigger and the tests both use it with no scheduler in the way. Same split the in-house PMS uses between its `TasksService` and its audit service.

### Verified
`npx tsc --noEmit`, `npm run lint`, `npm test` (149 tests — 13 new for night audit, 3 new for the backfill, 1 asserting check-out backfills *before* settling). Live, 14/14 against real Postgres: check-in posts only the arrival night → auditing the next night posts a second → re-running that date returns `409 AUDIT_ALREADY_RAN` → auditing a night before arrival adds nothing → **check-out backfills the elapsed nights and charges exactly 2 for an arrival on the 25th departing the 27th**, correct dates, no duplicates, subtotal = nights × rate → history lists runs with BigInt ids serialised.

One assertion of mine was wrong before the code was: I expected 3 nights for that stay. The departure night is never billable — 2 is correct, and the subtotal proved it.

### Carried forward
- Everything from the entries below — unchanged.
- The spec's "run stuck in `running` >10 min" health rule is recorded in the log but not yet surfaced by a health endpoint.

## Folios, line items, taxes & payments (P4 minimal slice) (2026-08-27)

Closes the hole Reservations shipped with ("check-out does not settle any charges — billing isn't available yet"). All models already existed and were RLS-protected from the initial migration — pure application-layer build, no schema/migration work.

**Two of my design decisions were wrong and were corrected by studying the in-house PMS (`five-clover-nestjs-backend`) and Cloudbeds rather than assuming.** Recording both, because the wrong versions were plausible:

### 1. Check-out must NEVER be blocked by an outstanding balance
I planned a hard `FOLIO_NOT_SETTLED` gate on check-out. That is wrong. The in-house PMS's own docs are explicit — *"checkout itself is never blocked on it (the room has to release either way)"* (`docs/PMS-OPERATIONS-GUIDE.md:218`), with front desk shown *"an explicit warning to settle payment first"* instead (`docs/FRONT-OFFICE-PMS-GUIDE.md:155`). Cloudbeds agrees: its AR transfer happens *"typically after check-out"*.
So: a still-checked-in guest who owes is a **Guest Ledger** matter; a departed guest who owes is a **City Ledger** receivable (collections). `FoliosService.deriveGuestStatus` derives that label from reservation status + balance — nothing is stored, nothing is blocked. `FOLIO_NOT_SETTLED` now belongs **only** to the explicit `closeFolio` path. `checkOut` calls `settleIfFullyPaid`, which deliberately returns a boolean and never throws.
Deferred but real: Cloudbeds' explicit *Transfer to Accounts Receivable* (which zeroes the folio and moves the balance to a named AR ledger) is the fuller model — Roomick has `CorporateAccount` + `Folio.corporateAccountId` to build it on, but it needs a new AR-ledger table, i.e. a migration.

### 2. Room charges accrue one night at a time, from the reservation's own rate
I planned to post the whole stay at check-in. Also wrong — it mis-states the ledger and would double-post once night audit lands. The in-house PMS posts the *arrival night* at check-in and each subsequent night via night audit, both through the same function with the same date-scoped guard (`reservations.service.ts:1525`, `night-audit.service.ts:130`), deriving from the reservation's own stored total *"not the room type's live base_rate, so a manually adjusted rate applies to every night of the stay"*. Cloudbeds confirms the accrual rule and names it: future nightly rates are **pending** until night audit **posts** them, and only *"past or current date of stay"* transactions count.
`postRoomChargeForDate` implements exactly this: `overrideRate ?? (confirmedRate / nights)`, guarded on an existing `room` line item for that `serviceDate`. **A 3-night stay legitimately shows one night on day one — accrual, not under-billing.** Night audit (not built) must call this function rather than re-implement it; the guard is what makes adding it safe.

### Delivered
- **`src/modules/taxes/`** — `TaxRule` CRUD (retire via `isActive`, never delete: a deleted rule would orphan the `taxRuleIds` on historical tax rows) + the tax engine. `computeTaxesForCharge` matches active branch rules (`appliesToChargeTypes: []` = all types), computes `amount × rate` to 2dp in `Prisma.Decimal`, and **skips any rule computing to exactly 0** — `line_items` carries a DB `CHECK (amount <> 0)` that a 0.00 tax row would abort the transaction on. Reachable via a 0%-rate rule or a charge small enough to round down.
- **`src/modules/folios/`** — `ensurePrimaryFolio` (idempotent, so pre-feature reservations resolve a folio instead of 404-ing), `postRoomChargeForDate`, `postCharge`, `recordPayment`, `correctLineItem`, `closeFolio`, `settleIfFullyPaid`, `getFolio`, `getTaxBreakdown`, `listFolios` (`all` / `outstanding` / `overdue`, using the in-house system's own definition of overdue: owing *and* check-out date passed).
- **Taxes post as separate `chargeType: 'tax'` line items** per spec §4.5, each carrying its `taxRuleIds`. The parent's `taxAmount` column is a **display denormalisation only** (the reference's "+345 tax" per-line suffix) — balance sums `amount` alone, so nothing double-counts. Note this differs from the in-house PMS, which uses a `tax` column on the item; Roomick's own spec wins for Roomick.
- **Append-only ledger enforced**: `correctLineItem` appends a negated `correction` row with a mandatory reason and never mutates the original. Balance is always computed, never stored.
- `checkIn`/`walkIn` open the folio and accrue the arrival night; `checkOut` settles only if fully paid.

### Verified
`npx tsc --noEmit`, `npm run lint`, `npm test` (132 tests — 8 new for the tax engine, 19 for folios, plus new reservations cases asserting check-out succeeds with a balance). Live against real Postgres, 26/26 checks: VAT rule → walk-in → folio auto-exists with exactly one night + its tax row and a correct balance → extra charge writes parent + tax → tax breakdown reverses the taxable base correctly → **check-out with a balance SUCCEEDS**, folio stays `open`, `guestStatus: city_ledger`, room still released `vacant`+`dirty` → `closeFolio` rejects with `409 FOLIO_NOT_SETTLED` → payment → balance 0 → `closeFolio` settles → correction leaves the original row untouched.

### Carried forward
- Night audit (ref p35), Cloudbeds-style Transfer-to-AR, split billing (ref p34), folio transfer, refunds, payment void, POS/outlet attribution, corporate payer, shift linkage, Print/Send Email — all deferred, all named.
- Multi-night stays only accrue subsequent nights once night audit exists. Expected, not a bug.

## Reservations — minimal slice: guests, book/walk-in, check-in/out (2026-08-25/26)

First backend work past P1 — Guests + Reservations, deliberately reduced from the full spec (`backend-execution-spec.md` §4) to what's needed for the Front Desk hub's Check-In/Check-Out/In-House Management cards to become genuinely real (see `roomick-pms-frontend/PHASE_NOTES.md` for why: the user asked for the nav to be interactive, and faking it with UI-only stubs would have broken this app's own established honesty convention). Full scope decision and deferred-list written up in the approved plan before any code — repeated here only where it affects what got built.

### Delivered
- **`src/modules/guests/`** (new) — `GuestProfile` CRUD reduced to `name`/`email`/`phone`/`notes` only; ID-document capture/encryption, nationality, loyalty, and preference fields all deliberately excluded from both the write DTO and the response `select` (not just unset — nothing to change here once that pass lands). `findOrCreateGuestInTx(tx, tenantId, {guestId} | {guest})` takes an already-open transaction, the same "accept a tx" shape `PropertyService.assertBranch` already establishes, so `ReservationsService` resolves a guest without a second round trip.
- **`src/modules/reservations/`** (new) — `createReservation` (flat `baseRate × nights`, no Rate Resolver cascade), `walkIn` (create + immediate check-in in one call, `checkInDate` forced server-side to `todayInTimezone(branch.timezone)`, never client-supplied), `checkIn`/`checkOut`/`cancel` (full status-transition guards), `getById`/`listArrivals`/`listDepartures`/`listInHouse`. No schema/migration work at all — `GuestProfile`/`Reservation`/`RoomBlock` were already fully modeled and RLS-protected from the initial migration, confirmed directly before writing a line of service code.
- **Availability engine** — 3 Prisma queries total regardless of range length (room count, `RoomBlock` overlaps, `Reservation` overlaps), bucketed per night in JS. `RoomBlock` (date-ranged) and `Room.heldStatus` (a static flag) are two different mechanisms and both reduce the pool — an earlier sketch of this only accounted for `heldStatus` and would have over-counted a room with an active block but no hold. `RoomBlock.fromDate`/`toDate` are inclusive-inclusive; `checkInDate`/`checkOutDate` stay checkout-exclusive (unchanged, matches the existing schema convention) — a real, easy-to-miss boundary mismatch between the two date models, called out explicitly in code comments. A `SELECT ... FOR UPDATE` on the room type row serializes concurrent creates for the same room type, closing the common "double-book the last unit" race under READ COMMITTED (a known, accepted gap otherwise).
- **`RoomsService.applyReservationOccupancy`** (new method on the *existing* `RoomsService`, not `ReservationsService`) — reuses `changeStatus`'s exact before/after audit shape but is deliberately **not** `changeStatus` itself: that method gates occupancy changes behind `isSupervisorAt` (owner/manager only), correct for a human manually overriding a room, wrong for check-in/check-out, which any `front_desk` user must be able to trigger. Calling `changeStatus` as-is would have silently locked front desk out of the exact action they need to perform — caught during planning, not after shipping.
- **`confirmationNumber` generation** — the column is globally `@unique` despite its own schema comment reading "sequence per branch" (a real, confirmed discrepancy). Predicts `RES-{year}-{count+1}` from a per-branch count, verifies with `findUnique`, retries on collision; the actual `create()` call is separately wrapped in a bounded catch-P2002-and-regenerate loop as defense against the TOCTOU window between probe and insert — the first place in this backend that needed unique-violation handling.
- **`PropertyService.assertBranch`** now returns the `Branch` row instead of `void` — a small, backward-compatible change (all 18 existing call sites already discarded the return value) needed so `walkIn`/`listArrivals`/`listDepartures` can read `branch.timezone` without a redundant second query.
- New `src/common/utils/branch-date.ts` (`todayInTimezone`, `toBranchDate`) — zero-dependency (`Intl.DateTimeFormat`), no date library installed. Will be reused by night audit later, not a one-off.
- Cleanliness is a **soft** filter at check-in, not hard-blocked server-side — `occupancyStatus`/`heldStatus`/`RoomBlock` are (physically unsafe to violate); this reduced scope has no override/reason escape hatch for cleanliness, and trapping front desk with zero ready rooms would be worse than letting them check in anyway. The frontend room picker defaults to only offering clean/inspected rooms, which covers the normal case.

### Decisions & deviations
1. **Flat rate, no Rate Resolver.** `confirmedRate = baseRate × nights` — the full cascade (seasonal/weekend/corporate tiers, promo codes, negotiated overrides, `rate_audit_log`) is genuinely its own phase of work (spec §4.4), confirmed by rendering the actual reference pages: Walk-In Booking and Check-Out Flow are each full-page forms built around it plus Folios/Payments. Deferred explicitly, not silently dropped.
2. **No Folios/Payments/LineItems anywhere.** Check-out cannot show or settle a balance — the frontend's check-out confirmation says so explicitly rather than pretending.
3. **No waitlist, no overbooking-acknowledgement flow.** Unavailability is a hard 409 (`RESERVATION_NOT_AVAILABLE`); `OVERBOOKING_NOT_ACKNOWLEDGED` stays unused.

### Verified
`npx tsc --noEmit`, `npm run lint`, and the full test suite (102 tests — 27 new for `ReservationsService`, 7 new for `GuestsService`, 3 new for `RoomsService.applyReservationOccupancy`) all clean. Live against the real backend, not mocked: full lifecycle via curl (create → arrivals list shows it → check-in assigns the room and Room Status Board shows it occupied → in-house list shows the guest → check-out releases the room to vacant+dirty → re-checking-in the same reservation correctly 409s with `INVALID_STATUS_TRANSITION`); walk-in creates+checks-in in one call with `confirmedRate` and `checkInDate` both computed correctly server-side; availability math spot-checked against real seeded room counts.

### Carried forward
- Everything else already carried forward from the entry below — unchanged.

## Reject duplicate branch names per brand (2026-08-25)

Found live, not in review: a real tenant ended up with two branches both named "Sope Hotel Abijo" (identical address too), 29 minutes apart — traced to `createBranch` doing a blind `INSERT` with no collision check at all. The onboarding wizard already guards against re-submitting the *same* browser session's Finish twice (writes each branch's real ID back into its local draft the moment it succeeds — see `roomick-pms-frontend/PHASE_NOTES.md`'s Review step notes), but nothing stopped a **second, independent** Finish run (stale/reset local draft, different device, a repeated test session) from creating a fresh branch with a name that already existed.

### Delivered
- `PropertyService.createBranch` now checks for an existing non-deleted branch with the same `name` under the same `brandId` before creating, rejecting with a new `BRANCH_NAME_TAKEN` (409) instead of silently duplicating — same "pre-check inside the same transaction, before `create`" pattern `RoomsService.bulkCreateRooms` already uses for `ROOM_NUMBERS_TAKEN`.
- New `ErrorCode.BRANCH_NAME_TAKEN`, placed alongside the other property-module codes.

### Decisions & deviations
1. **Blocks the collision, not re-entry into `/signup`.** Considered redirecting an already-onboarded, already-authenticated user away from `/signup` entirely — rejected because there's no branch-management screen yet (`/dashboard` is Room Status Board only), so re-entering `/signup` while logged in is currently the *only* way to add a genuinely new, differently-named branch to an existing account. Blocking name collisions fixes the actual harm (silent duplicate data) without breaking that.
2. **Name uniqueness scoped to `brandId`, not tenant-wide.** A multi-brand tenant could legitimately want the same branch name reused across two different brands (e.g. two unrelated hotel brands the same group owns); scoping tighter than that would be a real, unrequested restriction with no problem behind it.

### Verified
`npx tsc --noEmit`, `eslint`, and the full test suite (65 tests, including 2 new cases: rejects a same-name collision, excludes soft-deleted branches from the check) all clean. Live against the real backend: re-submitting `POST /brands/:brandId/branches` with an already-used name for that brand returns a real `409 BRANCH_NAME_TAKEN` with a clear message; a genuinely different name for the same brand still succeeds normally (no false positive).

### Carried forward
- Everything else already carried forward from the entry below — unchanged.

## Room Status Board — two new read endpoints (2026-08-25)

First real dashboard screen (see `roomick-pms-frontend`'s own `PHASE_NOTES.md` for the frontend half). Room *status* was already fully modeled (`Room.occupancyStatus`/`cleanlinessStatus`/`heldStatus`, `PATCH /rooms/:roomId/status` all existed) — this phase only needed to add the two read endpoints the grid consumes.

### Delivered
- `GET /branches` (`PropertyService.listBranches`) — resolves an owner's branch(es) for dashboard routing. **Owner-only, deliberately not Manager too**: verified directly in `roles.guard.ts` that a route with no `:branchId` param lets *any* role assignment matching the required role through, regardless of that assignment's own branch scope — a branch-A-scoped manager would see every branch in the tenant if this endpoint allowed Manager. Owner-only is safe because an owner's `branchId: null` role already means all-branches by definition. Deliberately a new endpoint, not an extension of `GET /auth/me/branches` — that endpoint's contract ("branches I hold an *explicit* per-branch role at") has a passing test asserting exactly the case that would otherwise break (`auth.service.spec.ts`: `[{branchId: null, role: 'owner'}]` → `[]`).
- `GET /branches/:branchId/rooms` (`RoomsService.listRoomsForBranch`) — the grid's data, one row per room with floor/building/room-type nested via `include` rather than separate list calls. No `@Roles()`, matching `listRoomTypes`'s existing "open to any authenticated role at this branch" precedent (front_desk and housekeeper both need this board). Known, accepted gap: a floor with zero rooms won't render, since building/floor data only arrives nested inside a room row.

### Verified
`npx tsc --noEmit`, `npm run lint`, and the full `npm test` suite (63 tests, including new `listBranches`/`listRoomsForBranch` cases) all clean. Live, against a freshly seeded real tenant (2 branches, 2 buildings, 24 rooms, a housekeeper on an explicit branch role): `GET /branches` returns both branches for the owner; `GET /branches/:branchId/rooms` returns correctly nested floor/building/room-type data; `PATCH /rooms/:roomId/status` exercised through the full housekeeping ladder (dirty→cleaning→clean→inspected) plus an occupancy correction and a hold/release, all as owner; a direct, unauthorized `PATCH` call as the housekeeper (no UI involved) confirmed a real 403 for occupancy correction, not just a hidden button on the frontend.

### Carried forward
- Everything from the entries below — unchanged.

## Plain email+password login, no subdomain (2026-08-23)

Direct user decision: match Cloudbeds' model — plain email+password login, then a post-login branch/property picker if the account has roles on more than one branch (see `roomick-pms-frontend`'s own `PHASE_NOTES.md` for the frontend half). Scoped via Plan Mode specifically because it's bigger than a login-form simplification: `User.email` had to become globally unique (was `@@unique([tenantId, email])`), and that ran straight into a real architectural constraint.

### Delivered
- **`users` has `FORCE ROW LEVEL SECURITY`** (`20260712000001_rls_and_constraints`), and `PrismaService.withTenant()`'s own doc comment already says it's *"the ONLY sanctioned way to touch tenant-scoped tables"* — verified directly, not assumed: a plain `prisma.user.findFirst({ where: { email } })` with no `app.tenant_id` set returns **zero rows**, always (confirmed both by reading the policy SQL and by querying `pg_roles` for the app's own connection — `rolsuper: false, rolbypassrls: false` — then running `SELECT COUNT(*) FROM users` with no tenant context set and getting `0`). Login genuinely cannot resolve "which tenant does this email belong to" against `users` directly, no matter how the query is phrased, as long as RLS stays on the way it's documented to.
- **New `UserEmailIndex` model** (`user_email_index` table) resolves that — deliberately *not* RLS-scoped, same category the RLS migration's own comment already carves out for `tenants`/`feature_flags`/`backup_records`. Holds only `email → tenantId/userId`, nothing else (no `passwordHash`, no `name`, no `phone`) — an attacker who somehow queried it directly learns only "does an account with this email exist, and where," no worse than what `EMAIL_TAKEN` already leaks today. Written via `tx` inside the same transaction as `user.create()` in both `register()` and `acceptInvite()`, not as a separate top-level call after — a separate call would leave a real crash window (a user that exists but isn't indexed, unable to log in *and* unable to re-register cleanly).
- **Migration** (`20260823010000_global_email_uniqueness`): creates the index table, backfills it from every existing tenant's `users` looping with `set_config('app.tenant_id', ...)` per tenant (a bare `INSERT ... SELECT FROM users` would silently match zero rows under FORCE RLS), then replaces `users_tenantId_email_key` with a global unique index on `email`. **Pre-migration guard actually run, not skipped**: since the app's own `roomick` role can't bypass RLS for a single global query either, the "any cross-tenant email duplicates?" check was done the same RLS-respecting way the backfill itself needs — looped every tenant via `withTenant`, compared emails in application code. Zero duplicates found across all 42 existing tenants. Post-migration, backfill row count verified to exactly match the real per-tenant user count (43 = 43), not just assumed correct because the migration didn't error.
- `AuthService.login()` is now a two-step lookup: `UserEmailIndex` resolves the tenant (still runs `bcrypt.compare` against `DUMMY_HASH` on a miss — timing-safety is preserved even at this earlier gate), then the real RLS-protected `users` row for password/verification exactly as before. `LoginDto` drops `subdomain` entirely.
- `AuthService.register()` no longer takes a `subdomain` from the client — `RegisterDto` drops the field. A new `generateUniqueSubdomain()` slugifies `groupName` and retries with a random suffix on collision (up to 5 attempts), so `SUBDOMAIN_TAKEN` is now unreachable by any client (the error code stays defined — never rename existing codes — just dead from the outside). The real uniqueness check moved to email: `EMAIL_TAKEN` is thrown from `register()` now, wiring up a codepath the frontend was already built for but the backend never actually threw.
- **Real, named behavior change in `acceptInvite()`**: email is global now, so a new cross-tenant guard rejects accepting an invite with `EMAIL_TAKEN` when that email already belongs to a *different* tenant's account. Before this change, the same address could be staff at multiple independent hotel groups; after it, it can't. This is inherent to "plain email+password, no org selection at login," not an incidental regression — verified live (invited an existing multi-tenant email into a second, unrelated tenant's branch, confirmed the invite-accept correctly rejects with `EMAIL_TAKEN` rather than silently creating a second identity).
- New `GET /auth/me/branches` (`AuthService.listMyBranches`) — resolves display *names* for the caller's own branch-scoped roles (the JWT's `roles` claim only ever carries `branchId`s). Not a general `GET /branches` list (deliberately deferred elsewhere in this codebase, same reasoning `GET /tenants/me/onboarding-status`'s own entry above already gives) — it only ever returns names for branch IDs the caller's own JWT already grants a role on.

### Decisions & deviations
1. **Global email uniqueness, not a lighter-weight alternative.** Could have kept per-tenant uniqueness and shown a "which organization?" picker on login collision — rejected because that reintroduces exactly the disambiguation-at-login-time step subdomain removal was meant to eliminate, and doesn't match how Cloudbeds/Mews/Opera actually work (plain email+password, org/property selection happens *after* identity is established, not as part of it).
2. **`UserEmailIndex` over any form of RLS bypass.** Never considered granting `BYPASSRLS` or `SET row_security = off` to the app role for this — that would weaken the fail-closed guarantee FORCE RLS exists to provide for every other query this app ever runs, to solve one narrow pre-authentication lookup. A minimal, deliberately non-sensitive side table is a smaller, more auditable surface.

### Verified
`npx tsc --noEmit` and the updated `auth.service.spec.ts` suite (23 tests) both clean. Live, against the real running backend and database, not mocked: registered a new account with no `subdomain` in the request body and confirmed a real slugified one was generated; logged in with only email+password; registered a second account with the same email and confirmed a clean `EMAIL_TAKEN` (409), not a raw 500; created a genuine multi-branch staff account (two branch invites, same email, both accepted) and called `GET /auth/me/branches` with their real token, confirming it returns the actual branch names, correctly deduped and sorted; invited that same email into a second, different tenant and confirmed the cross-tenant `acceptInvite` guard fires.

### Carried forward
- Everything else already carried forward from the onboarding-status entry below — unchanged.

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
