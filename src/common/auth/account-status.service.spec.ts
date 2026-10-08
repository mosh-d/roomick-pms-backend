import { PrismaService } from '../../prisma/prisma.service';
import { ACCOUNT_STATUS_TTL_MS, AccountStatusService } from './account-status.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const person = { sub: USER_ID, tenantId: TENANT_ID };

function setup() {
  const tx = { user: { findFirst: jest.fn().mockResolvedValue({ id: USER_ID }) } };
  const prisma = {
    withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)),
    tenant: { findUnique: jest.fn().mockResolvedValue({ status: 'active' }) },
  };
  return { tx, prisma, service: new AccountStatusService(prisma as unknown as PrismaService) };
}

describe('AccountStatusService', () => {
  it('reads the account once, then trusts the answer until it lapses', async () => {
    const { tx, prisma, service } = setup();
    const t0 = 1_000_000;
    expect(await service.isOpen(person, t0)).toBe(true);
    expect(await service.isOpen(person, t0 + ACCOUNT_STATUS_TTL_MS - 1)).toBe(true);
    expect(tx.user.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.user.findFirst).toHaveBeenCalledWith({ where: { id: USER_ID, deletedAt: null }, select: { id: true } });
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);

    expect(await service.isOpen(person, t0 + ACCOUNT_STATUS_TTL_MS)).toBe(true);
    expect(tx.user.findFirst).toHaveBeenCalledTimes(2);
  });

  it('refuses an account that is deactivated or gone, and keeps asking', async () => {
    const { tx, service } = setup();
    tx.user.findFirst.mockResolvedValue(null);
    expect(await service.check(person)).toBe('closed');
    expect(await service.isOpen(person)).toBe(false);
    expect(tx.user.findFirst).toHaveBeenCalledTimes(2);
  });

  it('refuses everyone in a suspended or cancelled organisation — the person is fine, the organisation is shut', async () => {
    const { prisma, service } = setup();
    prisma.tenant.findUnique.mockResolvedValue({ status: 'suspended' });
    expect(await service.check(person)).toBe('suspended');
    prisma.tenant.findUnique.mockResolvedValue({ status: 'cancelled' });
    expect(await service.check(person)).toBe('suspended');
    prisma.tenant.findUnique.mockResolvedValue(null);
    expect(await service.check(person)).toBe('suspended');
    expect(await service.isOpen(person)).toBe(false);
  });

  it('forgetting an account makes the next request read the row again — a deactivation takes effect at once', async () => {
    const { tx, service } = setup();
    expect(await service.isOpen(person)).toBe(true);
    service.forget(USER_ID);
    tx.user.findFirst.mockResolvedValue(null);
    expect(await service.isOpen(person)).toBe(false);
  });

  it('forgetting an organisation re-checks everyone in it — a suspension takes effect at once', async () => {
    const { prisma, service } = setup();
    expect(await service.check(person)).toBe('open');
    prisma.tenant.findUnique.mockResolvedValue({ status: 'suspended' });
    expect(await service.check(person)).toBe('open');
    service.forgetTenant(TENANT_ID);
    expect(await service.check(person)).toBe('suspended');
  });
});
