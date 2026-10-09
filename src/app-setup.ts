import { INestApplication, Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { json, urlencoded, type Express } from 'express';
import helmet from 'helmet';
import { ProblemJsonExceptionFilter } from './common/filters/problem-json.filter';
import { visitorBehindWebProxy, WEB_PROXY_SECRET_MIN_LENGTH } from './common/utils/web-proxy';

/**
 * Express's own default is 100 KB, which refused every real ID-document
 * photo: the check-in and walk-in bodies carry `photoBase64` (up to four
 * million characters by its DTO), and a phone camera frame is far past
 * 100 KB before base64 adds a third. 8 MB covers the largest photo the DTO
 * accepts with room to spare and is still far too small to be a nuisance.
 */
export const REQUEST_BODY_LIMIT = '8mb';

/**
 * Everything the API sets on the app before it listens. `main.ts` calls it,
 * and so do the end-to-end tests — they used to build their own, laxer
 * copy (no body limit, no `forbidNonWhitelisted`), so they tested an API
 * that wasn't the one that runs. The app must be created with
 * `{ bodyParser: false }`: the parsers here carry the limit.
 */
export function configureApp(app: INestApplication): void {
  app.use(json({ limit: REQUEST_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

  // Behind Render's load balancer every request arrives from the proxy's own
  // address. Trusting that one hop makes `req.ip` the real client, so the
  // per-IP rate limits and the audit trail's addresses mean something —
  // without it every user shared one bucket (10 sign-ins a minute for the
  // whole company, 10 public bookings an hour for the whole internet).
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', 1);
  // The sign-in routes come through the web app's own proxy; it vouches for
  // the visitor's address with WEB_PROXY_SECRET (see web-proxy.ts).
  const proxySecret = process.env.WEB_PROXY_SECRET;
  app.use(visitorBehindWebProxy(proxySecret));
  if (process.env.NODE_ENV === 'production' && (proxySecret ?? '').length < WEB_PROXY_SECRET_MIN_LENGTH) {
    new Logger('WebProxy').warn(
      'WEB_PROXY_SECRET is not set: sign-ins through the web app share one rate limit. Set the same value on the API and the web app.',
    );
  }

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new ProblemJsonExceptionFilter());
}
