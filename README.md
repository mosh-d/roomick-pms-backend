# Roomick PMS — Backend

Multi-tenant, multi-brand hotel Property Management System (SaaS). NestJS + PostgreSQL 16 + Prisma.

**Read [`backend-execution-spec.md`](./backend-execution-spec.md) before writing any code.** Business rules in its §4 override everything, including framework defaults. Companion docs: `pms-database-architecture-3.html` (schema v1.2), `pms-frontend-structure-2.html` (API contract), `pms-mvp-timeline.html`.

## Getting started

```bash
# 1. Postgres (needs Docker; or point DATABASE_URL at any Postgres 16+)
docker compose up -d postgres

# 2. Environment
cp .env.example .env   # then replace the JWT secrets and ENCRYPTION_KEY

# 3. Install, migrate, seed
npm install
npx prisma migrate deploy
npx prisma db seed     # demo tenant: owner@demo.local / Demo!Password1

# 4. Run
npm run start:dev      # http://localhost:3000/api/v1 — Swagger at /api/docs
```

## Key invariants (enforced by the scaffold — do not weaken)

- **Tenant isolation**: every tenant-scoped table has `ENABLE + FORCE ROW LEVEL SECURITY` with a `tenantId = current_setting('app.tenant_id')::uuid` policy. Database access to tenant data **must** go through `PrismaService.withTenant(tenantId, fn)`, which sets the GUC with `SET LOCAL` semantics inside a transaction. Queries outside that wrapper see zero rows — that is deliberate (fail closed).
- **Guard chain** (global, in order): `JwtAuthGuard` → `TenantGuard` (X-Tenant-ID header must equal the JWT tenant claim; mismatches are 403 + logged to `audit_log`) → `RolesGuard` (branch-scoped roles). Opt out per-route only with `@Public()`.
- **Audit**: `AuditInterceptor` writes an `audit_log` row for every mutating request and `?reveal=true` reads.
- **Money**: `NUMERIC(12,2)` via `Prisma.Decimal` — never JS floats. Financial rows are append-only (void/correct, never update/delete).
- **Time**: business-date logic uses the **branch timezone** (`branches.timezone`), never server time.
- **Errors**: `application/problem+json` with stable codes from `src/common/errors/error-codes.ts`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run start:dev` | watch mode |
| `npm run lint` / `typecheck` / `test` / `test:e2e` | what CI runs |
| `npm run prisma:migrate` | create + apply a dev migration |
| `npm run db:reset` | drop, re-migrate, re-seed |

## Testing endpoints with httpYac

Every module keeps its requests in an `http/` folder, one file per HTTP verb, named `<module>.<verb>.endpoints.http` — e.g. `src/modules/rooms/http/rooms.get.endpoints.http`, `rooms.post.endpoints.http`, `rooms.put.endpoints.http`, `rooms.delete.endpoints.http`. See `src/modules/system/http/` for the working example.

- **VS Code**: install the recommended `httpYac` extension and click *send* above a request.
- **CLI**: `npx httpyac send <file> --env local` (or `--all` to run every request).
- `{{baseUrl}}` lives in `http-client.env.json` (committed). Secrets — `{{tenantId}}`, `{{accessToken}}` — live in `http-client.private.env.json` (**gitignored**; copy the `.example` to create it).
- Every protected request needs both `Authorization: Bearer {{accessToken}}` and `X-Tenant-ID: {{tenantId}}` headers.

## Repository layout

See spec §2. Each module = `controller + service + dto/`; Prisma models are central (`prisma/schema.prisma`), business logic lives in the module. Cross-module calls go through exported services — never another module's repository.

## Build phases

P0 (this scaffold) → P1 identity & property → P2 guests/reservations/rates → P3 front desk → P4 money → P5 ops & reporting → P6 hardening. Per-phase decisions are logged in `PHASE_NOTES.md`.
