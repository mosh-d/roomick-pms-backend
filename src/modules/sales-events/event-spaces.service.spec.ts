import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxesService } from '../taxes/taxes.service';
import { EventSpacesService } from './event-spaces.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_BRANCH_ID = '99999999-9999-4999-8999-999999999999';
const ACTOR = '33333333-3333-4333-8333-333333333333';

function actor(role = 'manager', branchId: string | null = BRANCH_ID): JwtPayload {
  return { sub: ACTOR, tenantId: TENANT_ID, email: 'events@example.com', roles: [{ branchId, role }], tokenType: 'access' };
}

const BALLROOM = {
  id: 'space-1',
  tenantId: TENANT_ID,
  branchId: BRANCH_ID,
  name: 'Grand Ballroom',
  category: 'ballroom',
  capacity: 150,
  setupCapacities: { banquet: 120, theater: 200 },
  createdAt: new Date(),
};

describe('EventSpacesService', () => {
  let service: EventSpacesService;
  let tx: {
    eventSpace: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
    eventBooking: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    branch: { findFirst: jest.Mock };
    auditLog: { create: jest.Mock };
  };
  let taxesService: { computeTaxesForCharge: jest.Mock };

  beforeEach(async () => {
    tx = {
      eventSpace: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
      eventBooking: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
      branch: { findFirst: jest.fn().mockResolvedValue({ name: 'Lekki Palms Hotel', timezone: 'Africa/Lagos', currency: 'NGN' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    taxesService = { computeTaxesForCharge: jest.fn().mockResolvedValue([{ taxAmount: new Prisma.Decimal('76500') }]) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventSpacesService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: TaxesService, useValue: taxesService },
      ],
    }).compile();
    service = moduleRef.get(EventSpacesService);
  });

  describe('createBooking', () => {
    const startsAt = '2026-10-05T09:00:00.000Z';
    const endsAt = '2026-10-05T17:00:00.000Z';

    it('rejects endsAt at or before startsAt', async () => {
      await expect(service.createBooking(TENANT_ID, 'space-1', { title: 'X', startsAt, endsAt: startsAt }, ACTOR)).rejects.toMatchObject({ status: 409 });
      expect(tx.eventBooking.create).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND for an unknown event space', async () => {
      tx.eventSpace.findFirst.mockResolvedValue(null);
      await expect(service.createBooking(TENANT_ID, 'nonexistent', { title: 'X', startsAt, endsAt }, ACTOR)).rejects.toMatchObject({ status: 404 });
    });

    it('rejects a booking that overlaps an existing one on the same space', async () => {
      tx.eventSpace.findFirst.mockResolvedValue(BALLROOM);
      tx.eventBooking.findFirst.mockResolvedValue({ id: 'existing-booking' });
      await expect(service.createBooking(TENANT_ID, 'space-1', { title: 'X', startsAt, endsAt }, ACTOR)).rejects.toMatchObject({ status: 409 });
      expect(tx.eventBooking.create).not.toHaveBeenCalled();
    });

    it('creates the booking when the space is free for that time range', async () => {
      tx.eventSpace.findFirst.mockResolvedValue(BALLROOM);
      tx.eventBooking.findFirst.mockResolvedValue(null);
      tx.eventBooking.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'booking-1', ...data }));
      const result = await service.createBooking(TENANT_ID, 'space-1', { title: 'Product Launch', startsAt, endsAt }, ACTOR);
      expect(result.title).toBe('Product Launch');
      expect(tx.eventBooking.findFirst).toHaveBeenCalledWith({
        where: { eventSpaceId: 'space-1', startsAt: { lt: new Date(endsAt) }, endsAt: { gt: new Date(startsAt) } },
      });
    });

    it('does NOT reject two bookings on the same day that do not actually overlap in time', async () => {
      tx.eventSpace.findFirst.mockResolvedValue(BALLROOM);
      // Simulates the real query: an existing 9am-12pm booking does not overlap a new 1pm-5pm one.
      tx.eventBooking.findFirst.mockImplementation(({ where }: { where: { startsAt: { lt: Date }; endsAt: { gt: Date } } }) => {
        const existingEnd = new Date('2026-10-05T12:00:00.000Z');
        const existingStart = new Date('2026-10-05T09:00:00.000Z');
        const overlaps = existingStart < where.startsAt.lt && existingEnd > where.endsAt.gt;
        return Promise.resolve(overlaps ? { id: 'existing' } : null);
      });
      tx.eventBooking.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'booking-2', ...data }));
      const result = await service.createBooking(TENANT_ID, 'space-1', { title: 'Afternoon Session', startsAt: '2026-10-05T13:00:00.000Z', endsAt: '2026-10-05T17:00:00.000Z' }, ACTOR);
      expect(result.title).toBe('Afternoon Session');
    });

    it("checks the headcount against the space's seats for the layout, else its general capacity", async () => {
      tx.eventSpace.findFirst.mockResolvedValue(BALLROOM);
      tx.eventBooking.findFirst.mockResolvedValue(null);
      tx.eventBooking.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'booking-3', ...data }));

      await expect(service.createBooking(TENANT_ID, 'space-1', { title: 'Gala', startsAt, endsAt, setupStyle: 'banquet', headcount: 130 }, ACTOR)).rejects.toThrow(
        /Grand Ballroom seats 120 banquet-style/,
      );
      await expect(service.createBooking(TENANT_ID, 'space-1', { title: 'Talk', startsAt, endsAt, setupStyle: 'theater', headcount: 180 }, ACTOR)).resolves.toBeDefined();
      await expect(service.createBooking(TENANT_ID, 'space-1', { title: 'Class', startsAt, endsAt, setupStyle: 'classroom', headcount: 160 }, ACTOR)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('updateBooking', () => {
    const existing = {
      id: 'booking-1',
      eventSpaceId: 'space-1',
      title: 'Gala',
      startsAt: new Date('2026-10-05T18:00:00.000Z'),
      endsAt: new Date('2026-10-05T23:00:00.000Z'),
      setupStyle: 'banquet',
      headcount: 100,
      catering: null,
      eventSpace: BALLROOM,
    };

    beforeEach(() => {
      tx.eventBooking.findFirst.mockImplementation(({ where }: { where: { id?: string | { not: string } } }) =>
        Promise.resolve(typeof where.id === 'string' ? existing : null),
      );
      tx.eventBooking.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...existing, ...data, eventSpace: undefined }));
    });

    it('moving the event re-checks the space, leaving the booking itself out', async () => {
      await service.updateBooking(TENANT_ID, 'booking-1', { startsAt: '2026-10-06T18:00:00.000Z', endsAt: '2026-10-06T23:00:00.000Z' }, actor());
      expect(tx.eventBooking.findFirst).toHaveBeenCalledWith({
        where: { eventSpaceId: 'space-1', startsAt: { lt: new Date('2026-10-06T23:00:00.000Z') }, endsAt: { gt: new Date('2026-10-06T18:00:00.000Z') }, id: { not: 'booking-1' } },
      });
    });

    it('prices the catering: each line, the subtotal, and tax by the branch’s F&B rules', async () => {
      const result = await service.updateBooking(
        TENANT_ID,
        'booking-1',
        { catering: [{ description: 'Buffet dinner', quantity: 100, unitPrice: 8500 }, { description: 'Soft drinks', quantity: 200, unitPrice: 850 }] },
        actor('front_desk'),
      );
      expect(taxesService.computeTaxesForCharge).toHaveBeenCalledWith(tx, BRANCH_ID, 'fnb', new Prisma.Decimal('1020000'));
      expect(result.cateringLines.map((l) => l.amount)).toEqual(['850000.00', '170000.00']);
      expect(result.totals).toEqual({ subtotal: '1020000.00', taxTotal: '76500.00', total: '1096500.00' });
      expect(result.currency).toBe('NGN');
    });

    it('re-checks the headcount when the layout changes', async () => {
      await expect(service.updateBooking(TENANT_ID, 'booking-1', { headcount: 140 }, actor())).rejects.toThrow(/seats 120 banquet-style/);
    });

    it("checks the role at the event's own branch", async () => {
      await expect(service.updateBooking(TENANT_ID, 'booking-1', { title: 'Renamed' }, actor('manager', OTHER_BRANCH_ID))).rejects.toThrow(ForbiddenException);
      expect(tx.eventBooking.update).not.toHaveBeenCalled();
    });
  });

  describe('getBeoPdf', () => {
    it('renders a real PDF named after the event', async () => {
      tx.eventBooking.findFirst.mockResolvedValue({
        id: 'abcdef12-0000-4000-8000-000000000000',
        eventSpaceId: 'space-1',
        title: 'Acme Corp — Annual Gala!',
        startsAt: new Date('2026-10-05T17:00:00.000Z'),
        endsAt: new Date('2026-10-05T22:00:00.000Z'),
        setupStyle: 'banquet',
        headcount: 110,
        contactName: 'Jane Smith',
        contactPhone: '0803 123 4567',
        contactEmail: 'jane@acme.com',
        catering: [{ description: 'Buffet dinner', quantity: 110, unitPrice: 8500 }],
        avRequirements: 'Projector, 2 wireless mics',
        notes: 'Gluten-free options for 6 guests',
        eventSpace: BALLROOM,
      });
      const { filename, pdf } = await service.getBeoPdf(TENANT_ID, 'abcdef12-0000-4000-8000-000000000000', actor());
      expect(filename).toBe('beo-acme-corp-annual-gala.pdf');
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      expect(pdf.length).toBeGreaterThan(1000);
    });
  });

  describe('cancelBooking', () => {
    it('throws NOT_FOUND for an unknown booking', async () => {
      tx.eventBooking.findFirst.mockResolvedValue(null);
      await expect(service.cancelBooking(TENANT_ID, 'nonexistent')).rejects.toMatchObject({ status: 404 });
    });

    it('deletes a real booking, freeing the slot', async () => {
      tx.eventBooking.findFirst.mockResolvedValue({ id: 'booking-1' });
      await service.cancelBooking(TENANT_ID, 'booking-1');
      expect(tx.eventBooking.delete).toHaveBeenCalledWith({ where: { id: 'booking-1' } });
    });
  });

  describe('listBookings', () => {
    it('scopes to the branch via the event space relation and the date-range overlap filter', async () => {
      const from = new Date('2026-10-01');
      const to = new Date('2026-10-31');
      await service.listBookings(TENANT_ID, BRANCH_ID, from, to);
      expect(tx.eventBooking.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { eventSpace: { branchId: BRANCH_ID }, startsAt: { lt: to }, endsAt: { gt: from } } }));
    });
  });
});
