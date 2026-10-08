import * as Joi from 'joi';

/**
 * Validated at boot — the app refuses to start with missing/invalid config
 * (spec §6: ".env validated at boot (fail fast). Secrets never logged.").
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('900s'),
  JWT_REFRESH_TTL: Joi.string().default('7d'),
  // 32 bytes hex — AES-256-GCM key for guest ID document encryption
  ENCRYPTION_KEY: Joi.string().hex().length(64).required(),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  // The interactive API docs at /api/docs are always served in development; in
  // production only with this set to true (for integrators who need them).
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').optional(),
  // Optional — error tracking (src/instrument.ts) stays off entirely until this is set.
  SENTRY_DSN: Joi.string().uri().allow('').optional(),
  // Optional — defaults to <os temp dir>/roomick-backups (see LocalFilesystemBackupStorage).
  BACKUP_STORAGE_DIR: Joi.string().allow('').optional(),
  // Optional — defaults to <os temp dir>/roomick-documents (see LocalFilesystemDocumentStorage).
  DOCUMENT_STORAGE_DIR: Joi.string().allow('').optional(),
  // Where a guest's mail client reaches this API: the open pixel, click redirect and
  // unsubscribe link in a marketing email are absolute URLs, and they are baked into a
  // message that outlives any request. Required in production — a campaign sent before it
  // was set carried `http://localhost` tracking and unsubscribe links, and an unsubscribe
  // link that goes nowhere is a compliance problem, not just a broken statistic. Local
  // development defaults to http://localhost:<PORT>.
  PUBLIC_API_BASE_URL: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().uri({ scheme: ['https', 'http'] }).required(),
    otherwise: Joi.string().uri().allow('').optional(),
  }),
  // Where people reach the web app — the links in invitation, password reset and
  // verification emails, and a guest's "Manage your booking", point here. Required in
  // production, where defaulting to localhost would send people nowhere; local
  // development defaults to http://localhost:3001.
  PUBLIC_WEB_BASE_URL: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().uri({ scheme: ['https', 'http'] }).required(),
    otherwise: Joi.string().uri({ scheme: ['https', 'http'] }).allow('').optional(),
  }),
  // Optional — email goes out through this SMTP server once SMTP_HOST is set (any
  // provider: Resend, Postmark, Amazon SES, Mailtrap…); without it every message is
  // only written to the log. Port 465 is implicit TLS, anything else upgrades with STARTTLS.
  SMTP_HOST: Joi.string().hostname().allow('').optional(),
  SMTP_PORT: Joi.number().integer().min(1).max(65535).optional(),
  SMTP_USER: Joi.string().allow('').optional(),
  SMTP_PASS: Joi.string().allow('').optional(),
  // The sender: "Hotel Bookings <bookings@yourdomain>" or a bare address. Required with SMTP_HOST.
  MAIL_FROM: Joi.when('SMTP_HOST', {
    is: Joi.string().min(1).required(),
    then: Joi.string()
      .pattern(/^(?:[^<>]*<\s*[^\s@<>]+@[^\s@<>]+\s*>|[^\s@<>]+@[^\s@<>]+)$/)
      .required()
      .messages({ 'string.pattern.base': 'MAIL_FROM must be an address, or a name and an address in <angle brackets>' }),
    otherwise: Joi.string().allow('').optional(),
  }),
});
