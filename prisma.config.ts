// Prisma CLI configuration (replaces the deprecated package.json#prisma block).
// NOTE: when this file exists, Prisma no longer auto-loads .env — dotenv does it.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'ts-node --transpile-only prisma/seed.ts',
  },
});
