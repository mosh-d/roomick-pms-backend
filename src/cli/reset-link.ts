import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { webUrl } from '../common/utils/web-url';

/**
 * Break-glass: a one-use, 24-hour password-reset link for an account, made
 * from the server's command line. For the owner locked out before email is
 * set up — nobody in the app can make the owner one — or for anyone while
 * email is down. Run where the production `DATABASE_URL` and
 * `PUBLIC_WEB_BASE_URL` are set (the Render shell, or a machine with them):
 *
 *   npm run reset-link -- owner@hotel.example
 *
 * Prints the link once. Hand it over in person or by a channel you trust —
 * anyone holding it can set the password. Any older link for the same person
 * stops working, and the audit trail records that one was made this way.
 *
 * The same rules as a link made on Staff Management (`PasswordService`):
 * only a hash of the secret is stored, the link is `<tenantId>.<secret>`, and
 * using it ends every session the account had. It's recorded as made by
 * hand, so using it proves nothing about the email address.
 */
const VALID_FOR_HOURS = 24;

async function main(): Promise<void> {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    process.stderr.write('Usage: npm run reset-link -- <email>\n');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const indexRow = await prisma.userEmailIndex.findUnique({ where: { email } });
    if (!indexRow) {
      process.stderr.write(`No account uses ${email}.\n`);
      process.exit(1);
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${indexRow.tenantId}, true)`;
      const user = await tx.user.findFirst({ where: { id: indexRow.userId, deletedAt: null } });
      if (!user) return null;
      const now = new Date();
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      const secret = randomBytes(32).toString('hex');
      const expiresAt = new Date(now.getTime() + VALID_FOR_HOURS * 3_600_000);
      await tx.passwordResetToken.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          tokenHash: createHash('sha256').update(secret).digest('hex'),
          expiresAt,
          // Made by hand, not asked for by email — so using it doesn't confirm the address.
          createdBy: user.id,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: null,
          action: 'auth.password_reset_link_created',
          entityType: 'user',
          entityId: user.id,
          after: { for: user.email, by: 'command line' },
        },
      });
      return { name: user.name, link: webUrl(`/reset-password?token=${encodeURIComponent(`${user.tenantId}.${secret}`)}`), expiresAt };
    });

    if (!result) {
      process.stderr.write(`${email} belongs to a deactivated account — reactivate it on Staff Management first.\n`);
      process.exit(1);
    }
    process.stdout.write(`Password-reset link for ${result.name} <${email}>, valid once until ${result.expiresAt.toISOString()}:\n\n${result.link}\n\nHand it over in person or by a channel you trust. Anyone holding it can set the password.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
