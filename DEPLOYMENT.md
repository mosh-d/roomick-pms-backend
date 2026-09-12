# Deploying Roomick

Backend → Render (Docker + managed Postgres). Frontend → Vercel.

Nothing here has been run against a real Render account yet. What **has** been
verified locally: the exact build commands the Dockerfile uses, that the
compiled output boots under production env vars and serves a passing health
check, and that a malformed `ENCRYPTION_KEY` fails the boot loudly instead of
starting in a broken state. The Docker image itself is unbuilt — Docker isn't
installed on the dev machine — so treat the first `docker build` as the first
real test of that file.

---

## 1. Generate the secrets first

Three secrets are `required` by `src/config/env.validation.ts` and the app
**refuses to boot** without valid values. Generate them now and keep them
somewhere safe:

```bash
# JWT_ACCESS_SECRET  (min 32 chars)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# JWT_REFRESH_SECRET (min 32 chars, must differ from the access secret)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# ENCRYPTION_KEY — EXACTLY 64 hex chars (32 bytes). Nothing else is accepted.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **`ENCRYPTION_KEY` is effectively permanent.** Guest ID document numbers and
> ID photos are AES-256-GCM encrypted with it. Change it later and every
> previously stored document becomes permanently unreadable — there is no
> recovery path. Store it where you store things you cannot lose.

A wrong-shaped key fails fast and says exactly why, which is the intended
behaviour:

```
Error: Config validation error: "ENCRYPTION_KEY" must only contain hexadecimal
characters. "ENCRYPTION_KEY" length must be 64 characters long
```

---

## 2. Backend on Render

Either apply `render.yaml` (Dashboard → New → Blueprint) or click it together:

| Setting | Value |
|---|---|
| Type | Web Service, **Docker** runtime |
| Dockerfile path | `./Dockerfile` |
| Health check path | `/api/v1/system/health` |
| Pre-deploy command | `npx prisma migrate deploy` |

Create a **Render Postgres** instance alongside it and wire `DATABASE_URL` to
its connection string.

### Environment variables

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | from the Render Postgres instance |
| `JWT_ACCESS_SECRET` | generated above |
| `JWT_REFRESH_SECRET` | generated above |
| `ENCRYPTION_KEY` | generated above (64 hex chars) |
| `CORS_ORIGINS` | the Vercel URL, e.g. `https://roomick.vercel.app` |
| `DOCUMENT_STORAGE_DIR` | `/var/roomick/documents` |
| `BACKUP_STORAGE_DIR` | `/var/roomick/backups` |
| `SENTRY_DSN` | optional; error tracking stays off entirely while unset |

Do **not** set `PORT` — Render injects it, and `main.ts` reads it and binds
`0.0.0.0`.

### The persistent disk

Attach a disk mounted at `/var/roomick` (5 GB is plenty to start).

Everything operational — reservations, guests, folios, rate plans, bookings —
lives in Postgres and is durable regardless. The disk covers the four things
that are written as **files** rather than rows:

| Written by | Contents |
|---|---|
| `guests.service.ts` | encrypted guest ID photos |
| `registration-cards.service.ts` | registration-card PDFs |
| `gdpr.service.ts` | encrypted GDPR export bundles |
| `backups.service.ts` | nightly per-tenant dump files |

A container filesystem without a disk is reset on deploy, so without this mount
those four would not survive a redeploy. If your plan doesn't offer a disk, see
§5.

Note: a service with a disk attached cannot run more than one instance. That's
fine at this size, and it's also the signal for when to move to object storage.

---

## 3. Frontend on Vercel

Import `roomick-pms-frontend`. Next.js is detected automatically; no
`vercel.json` is needed.

| Key | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<your-render-service>.onrender.com/api/v1` |

The `/api/v1` suffix matters — `main.ts` sets a global `api` prefix plus URI
versioning, so every route lives under it.

Once the Vercel domain exists, go back and set `CORS_ORIGINS` on Render to it.
Skipping that produces a frontend that loads fine and fails every request with
an opaque CORS error in the console.

---

## 4. Verify the deployment

In order — each step depends on the previous one working:

1. `GET https://<api>/api/v1/system/health` → `{"status":"ok","checks":{"database":"up"}}`
2. Sign up a new tenant through the deployed frontend and complete onboarding.
3. Create a reservation, check it in, check it out.
4. **Publish a property** (Property Config → Direct Booking Engine), open the
   public `/book/<slug>` URL in a logged-out browser, and complete a booking.
5. **Then redeploy and confirm file durability** — capture a guest ID document,
   trigger a redeploy, and re-open that document. This is the one assumption
   worth testing directly rather than trusting: if it survives, the disk is
   doing its job; if it 404s, go to §5.

---

## 5. If files don't survive (or you outgrow one instance)

Both storage concerns already sit behind adapter interfaces with DI tokens,
written for exactly this swap:

- `src/common/documents/document-storage.interface.ts` (`DOCUMENT_STORAGE_ADAPTER`)
- `src/modules/backups/storage/backup-storage.interface.ts`

Only local-filesystem implementations exist today. Adding an S3-compatible one
(AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces) means writing one
class per interface and selecting it by env — no changes to any calling code.
The existing restore-drill endpoint makes it verifiable: write a backup to the
bucket, then restore from it.

---

## Known gaps at launch

These are real and deliberate, not oversights — each is documented in
`PHASE_NOTES.md`:

- **No card payment.** Guests pay at the property; the booking page says so.
- **No outbound email.** Confirmations are recorded in the comms log but never
  sent — a guest who books online sees a confirmation number on screen and
  receives nothing afterwards. Worth closing early if real guests will use the
  booking engine.
- **No channel manager.** No OTA connectivity; direct bookings only.
- **Single instance only** while a disk is attached (see §2).
- **In-memory rate limiting and metrics**, which is correct for one instance and
  would need a shared store (Redis) beyond that.
