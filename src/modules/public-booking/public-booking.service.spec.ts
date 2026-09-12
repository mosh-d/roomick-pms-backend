import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RateResolverService } from '../rate-resolver/rate-resolver.service';
import { ReservationsService } from '../reservations/reservations.service';
import { PublicBookingService } from './public-booking.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const ROOM_TYPE_ID = '33333333-3333-4333-8333-333333333333';
const SLUG = 'grand-hotel-ikeja';

function futureDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

describe('PublicBookingService', () => {
  let service: PublicBookingService;
  let prisma: {
    withTenant: jest.Mock;
    bookingSlugIndex: { findUnique: jest.Mock; create: jest.Mock; deleteMany: jest.Mock };
    tenant: { findUnique: jest.Mock };
  };
  let reservationsService: { createReservation: jest.Mock; getAvailability: jest.Mock; getAvailabilityForRange: jest.Mock };
  let rateResolverService: { calculateQuote: jest.Mock };
  let tx: {
    branch: { findFirst: jest.Mock; findFirstOrThrow: jest.Mock; update: jest.Mock };
    roomType: { findMany: jest.Mock; findFirst: jest.Mock };
    reservation: { findFirstOrThrow: jest.Mock; findFirst: jest.Mock };
  };

  beforeEach(async () => {
    tx = {
      branch: {
        findFirst: jest.fn().mockResolvedValue({ id: BRANCH_ID }),
        findFirstOrThrow: jest.fn().mockResolvedValue({ currency: 'NGN' }),
        update: jest.fn().mockResolvedValue({}),
      },
      roomType: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ id: ROOM_TYPE_ID, name: 'Standard' }) },
      reservation: { findFirstOrThrow: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
    };
    prisma = {
      withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)),
      bookingSlugIndex: {
        findUnique: jest.fn().mockResolvedValue({ slug: SLUG, tenantId: TENANT_ID, branchId: BRANCH_ID }),
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      tenant: { findUnique: jest.fn().mockResolvedValue({ status: 'active' }) },
    };
    reservationsService = {
      createReservation: jest.fn().mockResolvedValue({ id: 'res-1' }),
      getAvailability: jest.fn().mockResolvedValue([]),
      getAvailabilityForRange: jest.fn().mockResolvedValue([]),
    };
    rateResolverService = {
      calculateQuote: jest.fn().mockResolvedValue({
        nightlyRate: { toFixed: () => '30000.00' },
        subtotal: { toFixed: () => '90000.00' },
        taxTotal: { toFixed: () => '6750.00' },
        totalWithTax: { toFixed: () => '96750.00' },
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PublicBookingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ReservationsService, useValue: reservationsService },
        { provide: RateResolverService, useValue: rateResolverService },
      ],
    }).compile();
    service = moduleRef.get(PublicBookingService);
  });

  describe('slug resolution', () => {
    it('404s on a slug that has no index pointer at all', async () => {
      prisma.bookingSlugIndex.findUnique.mockResolvedValue(null);
      await expect(service.getProperty('never-existed')).rejects.toMatchObject({ status: 404 });
    });

    it('404s when the pointer exists but the branch is no longer published — the index is never trusted on its own', async () => {
      tx.branch.findFirst.mockResolvedValue(null);
      await expect(service.getProperty(SLUG)).rejects.toMatchObject({ status: 404 });
    });

    it('re-checks bookingEngineEnabled and deletedAt on the real branch row inside the tenant transaction', async () => {
      await service.getProperty(SLUG).catch(() => undefined);
      expect(tx.branch.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: BRANCH_ID, bookingEngineEnabled: true, deletedAt: null } }));
    });

    it('404s when the owning tenant is suspended', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ status: 'suspended' });
      await expect(service.getProperty(SLUG)).rejects.toMatchObject({ status: 404 });
    });

    it('404s when the owning tenant is cancelled', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ status: 'cancelled' });
      await expect(service.getProperty(SLUG)).rejects.toMatchObject({ status: 404 });
    });

    it('serves a trial tenant — trialing properties are still genuinely bookable', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ status: 'trial' });
      tx.branch.findFirstOrThrow.mockResolvedValue({
        name: 'Grand Hotel', category: 'hotel', currency: 'NGN', timezone: 'Africa/Lagos',
        checkInTime: new Date('1970-01-01T14:00:00.000Z'), checkOutTime: new Date('1970-01-01T11:00:00.000Z'),
        address: {}, brand: { name: 'Grand Group' },
      });
      await expect(service.getProperty(SLUG)).resolves.toMatchObject({ name: 'Grand Hotel' });
    });

    it('gives the same generic 404 for every failure mode, so the endpoint is not a property-enumeration oracle', async () => {
      prisma.bookingSlugIndex.findUnique.mockResolvedValue(null);
      const missing = await service.getProperty('a').catch((e: { response: { message: string } }) => e.response.message);
      prisma.bookingSlugIndex.findUnique.mockResolvedValue({ slug: SLUG, tenantId: TENANT_ID, branchId: BRANCH_ID });
      tx.branch.findFirst.mockResolvedValue(null);
      const unpublished = await service.getProperty('b').catch((e: { response: { message: string } }) => e.response.message);
      expect(missing).toBe(unpublished);
    });
  });

  describe('getProperty', () => {
    it('exposes only public-safe fields — never tenantId, branchId, policies or internal config', async () => {
      tx.branch.findFirstOrThrow.mockResolvedValue({
        name: 'Grand Hotel', category: 'hotel', currency: 'NGN', timezone: 'Africa/Lagos',
        checkInTime: new Date('1970-01-01T14:00:00.000Z'), checkOutTime: new Date('1970-01-01T11:00:00.000Z'),
        address: { city: 'Lagos' }, brand: { name: 'Grand Group' },
      });
      const result = await service.getProperty(SLUG);
      expect(Object.keys(result).sort()).toEqual(['address', 'brandName', 'category', 'checkInTime', 'checkOutTime', 'currency', 'name', 'slug', 'timezone']);
      expect(result.checkInTime).toBe('14:00');
      expect(result.checkOutTime).toBe('11:00');
    });
  });

  describe('getQuote', () => {
    it('never persists rate audit rows for an anonymous quote', async () => {
      await service.getQuote(SLUG, { roomTypeId: ROOM_TYPE_ID, checkInDate: '2026-10-01', checkOutDate: '2026-10-04' });
      expect(rateResolverService.calculateQuote).toHaveBeenCalledWith(TENANT_ID, BRANCH_ID, expect.anything(), null, { persistAudit: false });
    });

    it('goes through the real Rate Resolver cascade rather than any separate direct-rate source', async () => {
      const quote = await service.getQuote(SLUG, { roomTypeId: ROOM_TYPE_ID, checkInDate: '2026-10-01', checkOutDate: '2026-10-04' });
      expect(quote).toMatchObject({ nightlyRate: '30000.00', subtotal: '90000.00', taxTotal: '6750.00', totalWithTax: '96750.00', nights: 3, currency: 'NGN' });
    });

    it('passes a promo code through to the resolver', async () => {
      await service.getQuote(SLUG, { roomTypeId: ROOM_TYPE_ID, checkInDate: '2026-10-01', checkOutDate: '2026-10-04', promoCode: 'SAVE10' });
      expect(rateResolverService.calculateQuote).toHaveBeenCalledWith(TENANT_ID, BRANCH_ID, expect.objectContaining({ promoCode: 'SAVE10' }), null, expect.anything());
    });
  });

  describe('createReservation', () => {
    const validDto = {
      roomTypeId: ROOM_TYPE_ID,
      checkInDate: futureDate(5),
      checkOutDate: futureDate(8),
      adults: 2,
      guestName: 'Ada Okafor',
      guestEmail: 'ada@example.com',
    };

    beforeEach(() => {
      tx.reservation.findFirstOrThrow.mockResolvedValue({
        confirmationNumber: 'RES-2026-00001',
        checkInDate: new Date(validDto.checkInDate),
        checkOutDate: new Date(validDto.checkOutDate),
        confirmedRate: { toFixed: () => '90000.00' },
        roomType: { name: 'Standard' },
        guest: { name: 'Ada Okafor' },
        branch: { currency: 'NGN' },
      });
    });

    it('goes through the ordinary createReservation path with a NULL actor', async () => {
      await service.createReservation(SLUG, validDto);
      expect(reservationsService.createReservation).toHaveBeenCalledWith(TENANT_ID, BRANCH_ID, expect.anything(), null);
    });

    it('forces channel to direct so a public booking can never masquerade as an OTA one', async () => {
      await service.createReservation(SLUG, validDto);
      expect(reservationsService.createReservation).toHaveBeenCalledWith(TENANT_ID, BRANCH_ID, expect.objectContaining({ channel: 'direct' }), null);
    });

    it('forces joinWaitlist false so the public can never bypass the availability check', async () => {
      await service.createReservation(SLUG, validDto);
      expect(reservationsService.createReservation).toHaveBeenCalledWith(TENANT_ID, BRANCH_ID, expect.objectContaining({ joinWaitlist: false }), null);
    });

    it('never forwards a guestId or corporateAccountId, even though the internal DTO accepts them', async () => {
      await service.createReservation(SLUG, { ...validDto, guestId: 'sneaky', corporateAccountId: 'sneaky' } as never);
      const forwarded = reservationsService.createReservation.mock.calls[0][2] as Record<string, unknown>;
      expect(forwarded.guestId).toBeUndefined();
      expect(forwarded.corporateAccountId).toBeUndefined();
    });

    it('builds the guest from the public fields rather than accepting a guest id', async () => {
      await service.createReservation(SLUG, validDto);
      const forwarded = reservationsService.createReservation.mock.calls[0][2] as { guest: unknown };
      expect(forwarded.guest).toEqual({ name: 'Ada Okafor', email: 'ada@example.com', phone: undefined });
    });

    it('rejects a check-in date in the past without ever reaching the create path', async () => {
      await expect(service.createReservation(SLUG, { ...validDto, checkInDate: '2020-01-01' })).rejects.toMatchObject({ status: 400 });
      expect(reservationsService.createReservation).not.toHaveBeenCalled();
    });

    it('returns only confirmation-safe fields', async () => {
      const result = await service.createReservation(SLUG, validDto);
      expect(Object.keys(result).sort()).toEqual(['checkInDate', 'checkOutDate', 'confirmationNumber', 'currency', 'guestName', 'roomTypeName', 'totalRate']);
    });
  });

  describe('lookupBooking', () => {
    const lookup = { confirmationNumber: 'RES-2026-00001', email: 'ada@example.com' };

    beforeEach(() => {
      tx.branch.findFirstOrThrow.mockResolvedValue({
        name: 'Grand Hotel', category: 'hotel', currency: 'NGN', timezone: 'Africa/Lagos',
        checkInTime: new Date('1970-01-01T14:00:00.000Z'), checkOutTime: new Date('1970-01-01T11:00:00.000Z'),
        address: {}, brand: { name: 'Grand Group' },
      });
      tx.reservation.findFirst.mockResolvedValue({
        confirmationNumber: 'RES-2026-00001',
        status: 'confirmed',
        checkInDate: new Date('2026-10-01T00:00:00.000Z'),
        checkOutDate: new Date('2026-10-04T00:00:00.000Z'),
        adults: 2,
        children: 0,
        specialRequests: 'Late arrival',
        confirmedRate: { toFixed: () => '90000.00' },
        overrideRate: null,
        roomType: { name: 'Standard' },
        guest: { name: 'Ada Okafor', email: 'ada@example.com' },
        branch: { currency: 'NGN' },
      });
    });

    it('scopes the lookup to this property, since confirmation numbers are only unique per tenant', async () => {
      await service.lookupBooking(SLUG, lookup);
      expect(tx.reservation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ branchId: BRANCH_ID }) }));
    });

    it('requires the email to match the booking, not just the confirmation number', async () => {
      await service.lookupBooking(SLUG, lookup);
      const where = (tx.reservation.findFirst.mock.calls[0][0] as { where: { guest: unknown } }).where;
      expect(where.guest).toEqual({ email: { equals: 'ada@example.com', mode: 'insensitive' } });
    });

    it('matches the email case-insensitively so a differently-cased address still finds the booking', async () => {
      await service.lookupBooking(SLUG, { ...lookup, email: 'Ada@Example.com' });
      const where = (tx.reservation.findFirst.mock.calls[0][0] as { where: { guest: { email: { mode: string } } } }).where;
      expect(where.guest.email.mode).toBe('insensitive');
    });

    it('normalises a lowercase confirmation number the guest typed', async () => {
      await service.lookupBooking(SLUG, { ...lookup, confirmationNumber: '  res-2026-00001 ' });
      const where = (tx.reservation.findFirst.mock.calls[0][0] as { where: { confirmationNumber: string } }).where;
      expect(where.confirmationNumber).toBe('RES-2026-00001');
    });

    it('excludes soft-deleted reservations', async () => {
      await service.lookupBooking(SLUG, lookup);
      const where = (tx.reservation.findFirst.mock.calls[0][0] as { where: { deletedAt: null } }).where;
      expect(where.deletedAt).toBeNull();
    });

    it('404s when nothing matches', async () => {
      tx.reservation.findFirst.mockResolvedValue(null);
      await expect(service.lookupBooking(SLUG, lookup)).rejects.toMatchObject({ status: 404 });
    });

    it('gives an identical message for a wrong number and a wrong email, so sequential numbers cannot be enumerated', async () => {
      tx.reservation.findFirst.mockResolvedValue(null);
      const wrongNumber = await service.lookupBooking(SLUG, { ...lookup, confirmationNumber: 'RES-2026-99999' }).catch((e: { response: { message: string } }) => e.response.message);
      const wrongEmail = await service.lookupBooking(SLUG, { ...lookup, email: 'attacker@example.com' }).catch((e: { response: { message: string } }) => e.response.message);
      expect(wrongNumber).toBe(wrongEmail);
    });

    it('returns only guest-safe fields — no ids, no folio internals, no staff-only data', async () => {
      const result = await service.lookupBooking(SLUG, lookup);
      expect(Object.keys(result).sort()).toEqual([
        'adults', 'checkInDate', 'checkOutDate', 'children', 'confirmationNumber', 'currency',
        'guestEmail', 'guestName', 'property', 'roomTypeName', 'specialRequests', 'status', 'totalRate',
      ]);
    });

    it('reports the confirmed stay total rather than any nightly override', async () => {
      const result = await service.lookupBooking(SLUG, lookup);
      expect(result.totalRate).toBe('90000.00');
      expect(result).not.toHaveProperty('overrideRate');
    });

    it('refuses to look anything up at an unpublished property', async () => {
      tx.branch.findFirst.mockResolvedValue(null);
      await expect(service.lookupBooking(SLUG, lookup)).rejects.toMatchObject({ status: 404 });
      expect(tx.reservation.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('publish / unpublish', () => {
    it('rejects a slug already claimed by a different branch', async () => {
      prisma.bookingSlugIndex.findUnique.mockResolvedValue({ slug: SLUG, tenantId: TENANT_ID, branchId: 'some-other-branch' });
      await expect(service.publish(TENANT_ID, BRANCH_ID, { slug: SLUG })).rejects.toMatchObject({ status: 409 });
    });

    it('allows re-publishing the same slug the branch already holds', async () => {
      prisma.bookingSlugIndex.findUnique.mockResolvedValue({ slug: SLUG, tenantId: TENANT_ID, branchId: BRANCH_ID });
      await expect(service.publish(TENANT_ID, BRANCH_ID, { slug: SLUG })).resolves.toMatchObject({ slug: SLUG, bookingEngineEnabled: true });
    });

    it('clears any previous slug for the branch before claiming the new one, so an old URL stops resolving', async () => {
      prisma.bookingSlugIndex.findUnique.mockResolvedValue(null);
      await service.publish(TENANT_ID, BRANCH_ID, { slug: 'new-address' });
      expect(prisma.bookingSlugIndex.deleteMany).toHaveBeenCalledWith({ where: { branchId: BRANCH_ID } });
      expect(prisma.bookingSlugIndex.create).toHaveBeenCalledWith({ data: { slug: 'new-address', tenantId: TENANT_ID, branchId: BRANCH_ID } });
    });

    it('unpublishing removes the pointer but leaves the slug reserved on the branch row', async () => {
      await service.unpublish(TENANT_ID, BRANCH_ID);
      expect(prisma.bookingSlugIndex.deleteMany).toHaveBeenCalledWith({ where: { branchId: BRANCH_ID } });
      expect(tx.branch.update).toHaveBeenCalledWith({ where: { id: BRANCH_ID }, data: { bookingEngineEnabled: false } });
    });

    it('404s when publishing a branch that does not exist in this tenant', async () => {
      prisma.bookingSlugIndex.findUnique.mockResolvedValue(null);
      tx.branch.findFirst.mockResolvedValue(null);
      await expect(service.publish(TENANT_ID, BRANCH_ID, { slug: 'whatever' })).rejects.toMatchObject({ status: 404 });
    });
  });
});
