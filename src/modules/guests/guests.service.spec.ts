import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { GuestsService } from './guests.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '55555555-5555-4555-8555-555555555555';

function makeTx() {
  return {
    guestProfile: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: GUEST_ID, ...data }),
      ),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

describe('GuestsService', () => {
  let service: GuestsService;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(async () => {
    tx = makeTx();
    const moduleRef = await Test.createTestingModule({
      providers: [
        GuestsService,
        {
          provide: PrismaService,
          useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) },
        },
      ],
    }).compile();
    service = moduleRef.get(GuestsService);
  });

  describe('createGuest', () => {
    it('creates with only the allowed fields', async () => {
      const guest = await service.createGuest(TENANT_ID, { name: 'John Doe', email: 'john@doe.com', phone: '090', notes: 'VIP' });
      expect(tx.guestProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { tenantId: TENANT_ID, name: 'John Doe', email: 'john@doe.com', phone: '090', notes: 'VIP' } }),
      );
      expect(guest.id).toBe(GUEST_ID);
    });
  });

  describe('getGuestById', () => {
    it('404s on missing/soft-deleted guest', async () => {
      tx.guestProfile.findFirst.mockResolvedValue(null);
      await expect(service.getGuestById(TENANT_ID, GUEST_ID)).rejects.toThrow(NotFoundException);
    });

    it('returns the guest when found', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John Doe' });
      const guest = await service.getGuestById(TENANT_ID, GUEST_ID);
      expect(guest.id).toBe(GUEST_ID);
    });
  });

  describe('searchGuests', () => {
    it('matches name OR email, case-insensitively, capped at 20', async () => {
      await service.searchGuests(TENANT_ID, 'john');
      expect(tx.guestProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            OR: [
              { name: { contains: 'john', mode: 'insensitive' } },
              { email: { contains: 'john', mode: 'insensitive' } },
            ],
          },
          take: 20,
        }),
      );
    });
  });

  describe('findOrCreateGuestInTx', () => {
    it('resolves an existing guest by id', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({ id: GUEST_ID, name: 'John Doe' });
      const guest = await service.findOrCreateGuestInTx(tx as never, TENANT_ID, { guestId: GUEST_ID });
      expect(guest.id).toBe(GUEST_ID);
      expect(tx.guestProfile.create).not.toHaveBeenCalled();
    });

    it('404s when the referenced guestId does not exist', async () => {
      tx.guestProfile.findFirst.mockResolvedValue(null);
      await expect(service.findOrCreateGuestInTx(tx as never, TENANT_ID, { guestId: GUEST_ID })).rejects.toThrow(NotFoundException);
    });

    it('creates a new guest inline when given a guest payload instead of an id', async () => {
      const guest = await service.findOrCreateGuestInTx(tx as never, TENANT_ID, { guest: { name: 'Jane Doe' } });
      expect(tx.guestProfile.create).toHaveBeenCalled();
      expect(guest.id).toBe(GUEST_ID);
    });
  });
});
