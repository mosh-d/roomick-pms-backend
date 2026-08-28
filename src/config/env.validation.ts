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
  JWT_REFRESH_TTL: Joi.string().default('30d'),
  // 32 bytes hex — AES-256-GCM key for guest ID document encryption
  ENCRYPTION_KEY: Joi.string().hex().length(64).required(),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  // Optional — error tracking (src/instrument.ts) stays off entirely until this is set.
  SENTRY_DSN: Joi.string().uri().allow('').optional(),
});
