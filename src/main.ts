import './instrument';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app-setup';

async function bootstrap(): Promise<void> {
  // The body parsers (with their size limit), proxy trust, prefix, versioning,
  // headers, CORS, validation and error format — shared with the end-to-end
  // tests so they exercise the API exactly as it runs.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureApp(app);

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
