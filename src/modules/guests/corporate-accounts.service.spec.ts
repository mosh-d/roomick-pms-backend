import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { CorporateAccountsService } from './corporate-accounts.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const PLAN_ID = '55555555-5555-4555-8555-555555555555';

function makeTx() {
  return {
    corporateAccount: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'acct-1', isActive: true, ...data })),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'acct-1', name: 'Dangote Group', emailDomains: [], ratePlanId: null, contactName: null, contactEmail: null, isActive: true, ...data })),
    },
    ratePlan: { findFirst: jest.fn().mockResolvedValue({ id: PLAN_ID, type: 'negotiated', isActive: true }) },
    reservation: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('CorporateAccountsService', () => {
  let service: CorporateAccountsService;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(async () => {
    tx = makeTx();
    const moduleRef = await Test.createTestingModule({
      providers: [CorporateAccountsService, { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } }],
    }).compile();
    service = moduleRef.get(CorporateAccountsService);
  });

  describe('create', () => {
    it('cleans the email domains, takes a negotiated plan as the contract, and audits it', async () => {
      await service.create(TENANT_ID, { name: ' Dangote Group ', emailDomains: ['@Dangote.com', 'dangote.com', ' dangote-cement.com '], ratePlanId: PLAN_ID, contactEmail: 'Travel@Dangote.com' }, ACTOR_ID);
      const data = (tx.corporateAccount.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
      expect(data).toMatchObject({ name: 'Dangote Group', emailDomains: ['dangote.com', 'dangote-cement.com'], ratePlanId: PLAN_ID, contactEmail: 'travel@dangote.com' });
      expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'corporate_account.created' }) }));
    });

    it('refuses something that is not an email domain, by name', async () => {
      await expect(service.create(TENANT_ID, { name: 'Acme', emailDomains: ['not a domain'] }, ACTOR_ID)).rejects.toThrow(/"not a domain" isn't an email domain/);
    });

    it('only a live negotiated plan can be the contract', async () => {
      tx.ratePlan.findFirst.mockResolvedValueOnce({ id: PLAN_ID, type: 'seasonal', isActive: true });
      await expect(service.create(TENANT_ID, { name: 'Acme', ratePlanId: PLAN_ID }, ACTOR_ID)).rejects.toBeInstanceOf(BadRequestException);
      tx.ratePlan.findFirst.mockResolvedValueOnce({ id: PLAN_ID, type: 'negotiated', isActive: false });
      await expect(service.create(TENANT_ID, { name: 'Acme', ratePlanId: PLAN_ID }, ACTOR_ID)).rejects.toBeInstanceOf(BadRequestException);
      tx.ratePlan.findFirst.mockResolvedValueOnce(null);
      await expect(service.create(TENANT_ID, { name: 'Acme', ratePlanId: PLAN_ID }, ACTOR_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('two companies with one name would be indistinguishable at booking', async () => {
      tx.corporateAccount.findFirst.mockResolvedValueOnce({ name: 'Dangote Group' });
      await expect(service.create(TENANT_ID, { name: 'dangote group' }, ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('switches an account off, auditing only what changed', async () => {
      tx.corporateAccount.findFirst.mockResolvedValueOnce({ id: 'acct-1', name: 'Dangote Group', emailDomains: [], ratePlanId: null, contactName: null, contactEmail: null, isActive: true });
      await service.update(TENANT_ID, 'acct-1', { isActive: false }, ACTOR_ID);
      const entry = (tx.auditLog.create.mock.calls[0] as [{ data: { after: Record<string, unknown> } }])[0].data;
      expect(entry.after).toEqual({ isActive: { from: true, to: false } });
    });

    it('clears the contract with null', async () => {
      tx.corporateAccount.findFirst.mockResolvedValueOnce({ id: 'acct-1', name: 'Dangote Group', emailDomains: [], ratePlanId: PLAN_ID, contactName: null, contactEmail: null, isActive: true });
      await service.update(TENANT_ID, 'acct-1', { ratePlanId: null }, ACTOR_ID);
      expect((tx.corporateAccount.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data).toEqual({ ratePlanId: null });
    });
  });

  describe('detail', () => {
    it('lists each traveler once, with how often and when they last stayed', async () => {
      tx.corporateAccount.findFirst.mockResolvedValueOnce({ id: 'acct-1', name: 'Dangote Group' });
      const ada = { id: 'g-1', name: 'Ada Obi', email: 'ada@dangote.com', phone: null };
      tx.reservation.findMany.mockResolvedValueOnce([
        { id: 'r-2', guest: ada, checkInDate: new Date('2026-10-01') },
        { id: 'r-1', guest: ada, checkInDate: new Date('2026-09-01') },
        { id: 'r-3', guest: { id: 'g-2', name: 'Bayo Ade', email: null, phone: null }, checkInDate: new Date('2026-08-01') },
      ]);
      const result = await service.detail(TENANT_ID, 'acct-1');
      expect(result.travelers.map((t) => [t.guest.name, t.stays, t.lastStay.toISOString().slice(0, 10)])).toEqual([
        ['Ada Obi', 2, '2026-10-01'],
        ['Bayo Ade', 1, '2026-08-01'],
      ]);
    });
  });
});
