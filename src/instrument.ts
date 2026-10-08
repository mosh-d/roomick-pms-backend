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
/**
 * The share of requests traced. Every request (1.0) is right while testing
 * and a quota bill in production: a tenth there unless
 * `SENTRY_TRACES_SAMPLE_RATE` says otherwise. Errors are always captured,
 * whatever this is.
 */
function tracesSampleRate(): number {
  const configured = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
  if (process.env.SENTRY_TRACES_SAMPLE_RATE && Number.isFinite(configured) && configured >= 0 && configured <= 1) return configured;
  return process.env.NODE_ENV === 'production' ? 0.1 : 1.0;
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: tracesSampleRate(),
  });
}
