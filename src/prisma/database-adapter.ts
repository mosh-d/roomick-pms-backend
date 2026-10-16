import { PrismaPg } from '@prisma/adapter-pg';

/**
 * How Prisma 7 reaches Postgres: through the `pg` driver, with its own
 * connection pool. Used by the app (`PrismaService`), the seed and the
 * command-line tools alike.
 *
 * `pg` waits for a free connection for ever unless told otherwise; ten
 * seconds is what Prisma 6's own pool waited before giving up, so a starved
 * pool fails a request instead of hanging it.
 */
export function databaseAdapter(connectionString = process.env.DATABASE_URL): PrismaPg {
  return new PrismaPg({ connectionString, connectionTimeoutMillis: 10_000 });
}
