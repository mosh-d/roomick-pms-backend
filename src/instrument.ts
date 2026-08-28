import * as Sentry from '@sentry/nestjs';

/**
 * Error tracking (MVP timeline Month 6: "Sentry integration — frontend +
 * backend, separate DSNs"). Explicitly gated on `SENTRY_DSN` being set,
 * rather than passing an empty string and trusting the SDK to no-op on it
 * — this dev/CI environment has no real Sentry project, so `SENTRY_DSN` is
 * unset everywhere it's run today, and `Sentry.init()` is skipped entirely
 * rather than called with nothing to send to. The moment a real DSN is
 * added to the environment, this activates with zero code changes.
 *
 * Must be imported before anything else in `main.ts` — the SDK
 * auto-instruments modules as they're required, so anything imported
 * before this file runs is invisible to it (Sentry's own documented
 * requirement, not a choice made here).
 */
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 1.0,
  });
}
