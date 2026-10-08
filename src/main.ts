import './instrument';

import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Express } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ProblemJsonExceptionFilter } from './common/filters/problem-json.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Behind Render's load balancer every request arrives from the proxy's own
  // address. Trusting that one hop makes `req.ip` the real client, so the
  // per-IP rate limits and the audit trail's addresses mean something —
  // without it every user shared one bucket (10 sign-ins a minute for the
  // whole company, 10 public bookings an hour for the whole internet).
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', 1);

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

  // The interactive API docs describe every route. Always on in development;
  // in production only when switched on (SWAGGER_ENABLED=true) for the
  // integrators who need them — not published to the whole internet by default.
  const serveDocs = process.env.NODE_ENV !== 'production' || process.env.SWAGGER_ENABLED === 'true';
  if (serveDocs) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Roomick PMS API')
      .setDescription(
        'Multi-tenant hotel Property Management System. Every request sends the account ID as X-Tenant-ID and signs in either as a person ' +
          '(the access token from POST /auth/login) or with an API key made on the Integrations & APIs page — use the rk_… key as the bearer ' +
          'token. A key makes GET requests only, to the areas it was given (and one branch, if it was kept to one).',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .addGlobalParameters({
        name: 'X-Tenant-ID',
        in: 'header',
        required: false,
        schema: { type: 'string', format: 'uuid' },
      })
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = Number(process.env.PORT ?? 3000);
  // Bind 0.0.0.0 explicitly rather than relying on Node's default. Node 17+
  // can resolve the default host to IPv6 `::`, which a container platform
  // routing only IPv4 won't reach — the failure mode is a deploy that reports
  // success while every health check times out, with nothing in the logs.
  // Harmless locally (0.0.0.0 still covers localhost).
  await app.listen(port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`Roomick API listening on http://localhost:${port}/api/v1`);
  if (serveDocs) logger.log(`Swagger docs at http://localhost:${port}/api/docs`);
}

void bootstrap();
