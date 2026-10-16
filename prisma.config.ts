// Prisma CLI configuration (replaces the deprecated package.json#prisma block).
// NOTE: when this file exists, Prisma no longer auto-loads .env — dotenv does it.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'ts-node --transpile-only prisma/seed.ts',
  },
  // What migrate, db execute and db seed connect to. Read as it stands, not
  // through Prisma's env(), which refuses to load without it: `prisma
  // generate` runs where no database is set (the Docker build, `npm ci`).
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    // Only `prisma migrate diff --from-migrations` (CI's drift check) needs it.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
