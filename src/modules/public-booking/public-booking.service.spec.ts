import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FoliosService } from '../folios/folios.service';
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
  let reservationsService: {
    createReservation: jest.Mock;
    getAvailability: jest.Mock;
    getAvailabilityForRange: jest.Mock;
    quoteCancellationInTx: jest.Mock;
    cancelInTx: jest.Mock;
  };
  let rateResolverService: { calculateQuote: jest.Mock };
  let foliosService: { getFolio: jest.Mock };
  let tx: {
    branch: { findFirst: jest.Mock; findFirstOrThrow: jest.Mock; update: jest.Mock };
    roomType: { findMany: jest.Mock; findFirst: jest.Mock };
    reservation: { findFirstOrThrow: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    guestProfile: { update: jest.Mock };
    auditLog: { create: jest.Mock };
    folio: { findFirst: jest.Mock; count: jest.Mock };
  };

  beforeEach(async () => {
    tx = {
      branch: {
        findFirst: jest.fn().mockResolvedValue({ id: BRANCH_ID }),
        findFirstOrThrow: jest.fn().mockResolvedValue({
          currency: 'NGN', timezone: 'Africa/Lagos', checkInTime: new Date('1970-01-01T14:00:00.000Z'), cancellationPolicy: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      roomType: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ id: ROOM_TYPE_ID, name: 'Standard' }) },
      reservation: { findFirstOrThrow: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
      guestProfile: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      folio: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
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
      quoteCancellationInTx: jest.fn(),
      cancelInTx: jest.fn(),
    };
    rateResolverService = {
      calculateQuote: jest.fn().mockResolvedValue({
        nightlyRate: new Prisma.Decimal('30000'),
        subtotal: new Prisma.Decimal('90000'),
        taxTotal: new Prisma.Decimal('6750'),
        totalWithTax: new Prisma.Decimal('96750'),
      }),
    };

    // Only getFolio — deliberately no ensurePrimaryFolio on this mock, so any
    // accidental call from the public read path would fail loudly.
    foliosService = { getFolio: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PublicBookingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ReservationsService, useValue: reservationsService },
        { provide: RateResolverService, useValue: rateResolverService },
        { provide: FoliosService, useValue: foliosService },
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
      expect(Object.keys(result).sort()).toEqual([
        'address', 'brandName', 'cancellationPolicy', 'category', 'checkInTime', 'checkOutTime', 'currency', 'name', 'slug', 'timezone',
      ]);
      expect(result.checkInTime).toBe('14:00');
      expect(result.checkOutTime).toBe('11:00');
    });

    it('states the cancellation policy for guests to read before booking — the default when none is saved', async () => {
      tx.branch.findFirstOrThrow.mockResolvedValue({
        name: 'Grand Hotel', category: 'hotel', currency: 'NGN', timezone: 'Africa/Lagos',
        checkInTime: new Date('1970-01-01T14:00:00.000Z'), checkOutTime: new Date('1970-01-01T11:00:00.000Z'),
        address: {}, cancellationPolicy: null, brand: { name: 'Grand Group' },
      });
      const result = await service.getProperty(SLUG);
      expect(result.cancellationPolicy).toEqual({
        summary: 'Free cancellation until 24 hours before check-in (14:00 on your arrival day). After that, the first night is charged.',
        freeCancellationHours: 24,
        allowOnlineCancellation: true,
      });
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

    it('states the cancellation terms the stay would book under', async () => {
      const quote = await service.getQuote(SLUG, { roomTypeId: ROOM_TYPE_ID, checkInDate: futureDate(30), checkOutDate: futureDate(33) });
      expect(quote.cancellation.freeCancellationAvailable).toBe(true);
      expect(quote.cancellation.summary).toContain('Free cancellation until 24 hours before check-in');
    });

    it('warns when the stay starts so soon that the free window has already closed', async () => {
      const quote = await service.getQuote(SLUG, { roomTypeId: ROOM_TYPE_ID, checkInDate: futureDate(0), checkOutDate: futureDate(2) });
      expect(quote.cancellation.freeCancellationAvailable).toBe(false);
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
      // An explicit allow-list, not a deny-list: any field added to the
      // response fails this until someone consciously confirms a guest is
      // entitled to see it. Everything here is either the guest's own data or
      // the property's own public information.
      expect(Object.keys(result).sort()).toEqual([
        'adults', 'cancellationPolicySummary', 'checkInDate', 'checkOutDate', 'children', 'confirmationNumber', 'currency',
        'estimatedArrivalTime', 'guestEmail', 'guestName', 'guestNationality', 'guestPhone',
        'houseRules', 'preArrivalCompletedAt', 'property', 'roomTypeName', 'specialRequests',
        'status', 'totalRate',
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

  describe('preArrivalCheckIn', () => {
    const preArrival = { confirmationNumber: 'RES-2026-00001', email: 'ada@example.com', acceptHouseRules: true };

    beforeEach(() => {
      tx.branch.findFirstOrThrow.mockResolvedValue({
        name: 'Grand Hotel', category: 'hotel', currency: 'NGN', timezone: 'Africa/Lagos',
        checkInTime: new Date('1970-01-01T14:00:00.000Z'), checkOutTime: new Date('1970-01-01T11:00:00.000Z'),
        address: {}, brand: { name: 'Grand Group' },
      });
      // First call resolves the reservation for the write; the re-read at the
      // end goes through lookupBooking and needs the fuller shape.
      tx.reservation.findFirst
        .mockResolvedValueOnce({ id: 'res-1', guestId: 'guest-1', status: 'confirmed' })
        .mockResolvedValue({
          confirmationNumber: 'RES-2026-00001', status: 'confirmed',
          checkInDate: new Date('2026-10-01T00:00:00.000Z'), checkOutDate: new Date('2026-10-04T00:00:00.000Z'),
          adults: 2, children: 0, specialRequests: null,
          confirmedRate: { toFixed: () => '90000.00' }, overrideRate: null,
          preArrivalCompletedAt: new Date(), estimatedArrivalTime: '15:30',
          roomType: { name: 'Standard' },
          guest: { name: 'Ada Okafor', email: 'ada@example.com', phone: '+2348012345678', nationality: 'NG' },
          branch: { currency: 'NGN', regCardTemplate: { houseRules: 'No smoking.' } },
        });
    });

    it('rejects a submission that does not accept the house rules, before touching anything', async () => {
      await expect(service.preArrivalCheckIn(SLUG, { ...preArrival, acceptHouseRules: false })).rejects.toMatchObject({ status: 400 });
      expect(tx.reservation.update).not.toHaveBeenCalled();
    });

    it('uses the SAME credential check as the lookup, so the write path is no easier to pass', async () => {
      await service.preArrivalCheckIn(SLUG, preArrival);
      const where = (tx.reservation.findFirst.mock.calls[0][0] as { where: { guest: unknown; confirmationNumber: string } }).where;
      expect(where.confirmationNumber).toBe('RES-2026-00001');
      expect(where.guest).toEqual({ email: { equals: 'ada@example.com', mode: 'insensitive' } });
    });

    it('404s with the generic booking message when credentials do not match', async () => {
      tx.reservation.findFirst.mockReset();
      tx.reservation.findFirst.mockResolvedValue(null);
      await expect(service.preArrivalCheckIn(SLUG, preArrival)).rejects.toMatchObject({ status: 404 });
    });

    it('refuses a stay that has already started or ended', async () => {
      for (const status of ['checked_in', 'checked_out', 'cancelled', 'no_show', 'waitlisted']) {
        tx.reservation.findFirst.mockReset();
        tx.reservation.findFirst.mockResolvedValue({ id: 'res-1', guestId: 'guest-1', status });
        await expect(service.preArrivalCheckIn(SLUG, preArrival)).rejects.toMatchObject({ status: 409 });
      }
    });

    it('records completion and house-rules acceptance on the reservation', async () => {
      await service.preArrivalCheckIn(SLUG, preArrival);
      const data = (tx.reservation.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(data.preArrivalCompletedAt).toBeInstanceOf(Date);
      expect(data.houseRulesAcceptedAt).toBeInstanceOf(Date);
    });

    it('writes corrected contact details to the GUEST profile, not onto the reservation', async () => {
      await service.preArrivalCheckIn(SLUG, { ...preArrival, phone: ' +2348012345678 ', nationality: 'ng' });
      expect(tx.guestProfile.update).toHaveBeenCalledWith({ where: { id: 'guest-1' }, data: { phone: '+2348012345678', nationality: 'NG' } });
      const reservationData = (tx.reservation.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(reservationData).not.toHaveProperty('phone');
      expect(reservationData).not.toHaveProperty('nationality');
    });

    it('does not touch the guest profile when no contact details were supplied', async () => {
      await service.preArrivalCheckIn(SLUG, preArrival);
      expect(tx.guestProfile.update).not.toHaveBeenCalled();
    });

    it('stores the estimated arrival time, and clears it when omitted', async () => {
      await service.preArrivalCheckIn(SLUG, { ...preArrival, estimatedArrivalTime: '15:30' });
      expect((tx.reservation.update.mock.calls[0][0] as { data: { estimatedArrivalTime: string } }).data.estimatedArrivalTime).toBe('15:30');
    });

    it('audits the change with a NULL user — a guest acted, not a staff member', async () => {
      await service.preArrivalCheckIn(SLUG, preArrival);
      const data = (tx.auditLog.create.mock.calls[0][0] as { data: { userId: null; action: string } }).data;
      expect(data.userId).toBeNull();
      expect(data.action).toBe('reservation.pre_arrival_completed');
    });

    it('returns the same shape the lookup returns, rather than a hand-built echo', async () => {
      const result = await service.preArrivalCheckIn(SLUG, preArrival);
      expect(result.confirmationNumber).toBe('RES-2026-00001');
      expect(result.houseRules).toBe('No smoking.');
      expect(result.preArrivalCompletedAt).toBeInstanceOf(Date);
    });
  });

  describe('guest cancellation', () => {
    const creds = { confirmationNumber: 'RES-2026-00001', email: 'ada@example.com' };
    const quote = (overrides: Record<string, unknown> = {}) => ({
      reservationId: 'res-1',
      status: 'confirmed',
      cancellable: true,
      currency: 'NGN',
      policy: {
        freeCancellationHours: 24, lateCancellationPenalty: 'first_night', flatFeeAmount: null, allowOnlineCancellation: true,
        summary: 'Free cancellation until 24 hours before check-in (14:00 on your arrival day). After that, the first night is charged.',
      },
      checkInAt: new Date('2026-10-10T13:00:00.000Z'),
      freeCancellationUntil: new Date('2026-10-09T13:00:00.000Z'),
      withinFreeWindow: false,
      pastCheckInTime: false,
      penaltyType: 'first_night',
      penaltyAmount: '30000.00',
      penaltyTax: '2250.00',
      penaltyTotal: '32250.00',
      paidSoFar: '0.00',
      refundDue: '0.00',
      amountOwed: '32250.00',
      ...overrides,
    });

    beforeEach(() => {
      tx.branch.findFirstOrThrow.mockResolvedValue({
        name: 'Grand Hotel', category: 'hotel', currency: 'NGN', timezone: 'Africa/Lagos',
        checkInTime: new Date('1970-01-01T14:00:00.000Z'), checkOutTime: new Date('1970-01-01T11:00:00.000Z'),
        address: {}, cancellationPolicy: null, brand: { name: 'Grand Group' },
      });
      // First read: the credential check. Any later read is lookupBooking's re-read of the cancelled booking.
      tx.reservation.findFirst
        .mockResolvedValueOnce({ id: 'res-1', confirmationNumber: 'RES-2026-00001', status: 'confirmed' })
        .mockResolvedValue({
          confirmationNumber: 'RES-2026-00001', status: 'cancelled',
          checkInDate: new Date('2026-10-10T00:00:00.000Z'), checkOutDate: new Date('2026-10-13T00:00:00.000Z'),
          adults: 2, children: 0, specialRequests: null,
          confirmedRate: { toFixed: () => '90000.00' }, overrideRate: null,
          preArrivalCompletedAt: null, estimatedArrivalTime: null,
          roomType: { name: 'Standard' },
          guest: { name: 'Ada Okafor', email: 'ada@example.com', phone: null, nationality: null },
          branch: { currency: 'NGN', regCardTemplate: null },
        });
      reservationsService.quoteCancellationInTx.mockResolvedValue(quote());
      reservationsService.cancelInTx.mockResolvedValue({ charged: { toFixed: () => '32250.00' } });
    });

    it('quotes behind the same credential check as the lookup, and exposes no ids', async () => {
      const result = await service.getCancellationQuote(SLUG, creds);
      const where = (tx.reservation.findFirst.mock.calls[0][0] as { where: { guest: unknown } }).where;
      expect(where.guest).toEqual({ email: { equals: 'ada@example.com', mode: 'insensitive' } });
      expect(result).toMatchObject({ canCancelOnline: true, blockedReason: null, charge: { amount: '30000.00', tax: '2250.00', total: '32250.00' } });
      expect(JSON.stringify(result)).not.toContain('res-1');
    });

    it('404s with the generic booking message when credentials do not match', async () => {
      tx.reservation.findFirst.mockReset();
      tx.reservation.findFirst.mockResolvedValue(null);
      await expect(service.getCancellationQuote(SLUG, creds)).rejects.toMatchObject({ status: 404 });
      await expect(service.cancelBooking(SLUG, { ...creds, acknowledgedPenaltyTotal: '0.00' })).rejects.toMatchObject({ status: 404 });
    });

    it('refuses a booking that has already started, ended or been cancelled', async () => {
      for (const status of ['checked_in', 'checked_out', 'cancelled', 'no_show']) {
        tx.reservation.findFirst.mockReset();
        tx.reservation.findFirst.mockResolvedValue({ id: 'res-1', confirmationNumber: 'RES-2026-00001', status });
        await expect(service.getCancellationQuote(SLUG, creds)).rejects.toMatchObject({ status: 409 });
      }
      expect(reservationsService.quoteCancellationInTx).not.toHaveBeenCalled();
    });

    it("says so when the property doesn't take online cancellations — and refuses the cancel", async () => {
      reservationsService.quoteCancellationInTx.mockResolvedValue(quote({ policy: { ...quote().policy, allowOnlineCancellation: false } }));
      const result = await service.getCancellationQuote(SLUG, creds);
      expect(result.canCancelOnline).toBe(false);
      expect(result.blockedReason).toContain("doesn't take cancellations online");
      tx.reservation.findFirst.mockResolvedValueOnce({ id: 'res-1', status: 'confirmed' });
      await expect(service.cancelBooking(SLUG, { ...creds, acknowledgedPenaltyTotal: '32250.00' })).rejects.toMatchObject({ status: 409 });
      expect(reservationsService.cancelInTx).not.toHaveBeenCalled();
    });

    it('stops online cancellation once check-in time on the arrival day has passed', async () => {
      reservationsService.quoteCancellationInTx.mockResolvedValue(quote({ pastCheckInTime: true }));
      const result = await service.getCancellationQuote(SLUG, creds);
      expect(result.blockedReason).toContain('past check-in time');
    });

    it('cancels through the shared staff path — NULL actor, guest source, the acknowledged charge passed through', async () => {
      const result = await service.cancelBooking(SLUG, { ...creds, acknowledgedPenaltyTotal: '32250.00', reason: '  Plans changed ' });
      expect(reservationsService.cancelInTx).toHaveBeenCalledWith(
        tx,
        TENANT_ID,
        'res-1',
        expect.objectContaining({ actorId: null, source: 'guest', acknowledgedPenaltyTotal: '32250.00', reason: 'Plans changed' }),
      );
      expect(result).toMatchObject({ charged: '32250.00', currency: 'NGN' });
      expect(result.booking).toMatchObject({ confirmationNumber: 'RES-2026-00001', status: 'cancelled' });
    });
  });

  describe('getGuestFolio', () => {
    const creds = { confirmationNumber: 'RES-2026-00001', email: 'ada@example.com' };
    const D = (n: string) => ({ toFixed: () => n });
    const line = (over: Record<string, unknown>) => ({
      description: 'Room Charge', chargeType: 'room', amount: D('30000.00'), isVoid: false,
      serviceDate: new Date('2026-09-12T00:00:00.000Z'), postedAt: new Date('2026-09-12T15:00:00.000Z'),
      postedBy: 'staff-user-1', voidedBy: null, outletId: 'outlet-1', taxRuleIds: ['rule-1'], taxAmount: D('2250.00'), ...over,
    });
    const pay = (over: Record<string, unknown>) => ({
      method: 'cash', paymentPurpose: 'payment', amount: D('10000.00'), isVoid: false, recordedAt: new Date('2026-09-12T16:00:00.000Z'),
      reference: 'AUTH-4412', recordedBy: 'staff-user-1', shiftId: 'shift-1', voidReason: null, ...over,
    });

    beforeEach(() => {
      tx.reservation.findFirst.mockResolvedValue({ id: 'res-1', status: 'checked_in', confirmationNumber: 'RES-2026-00001', confirmedRate: D('90000.00') });
      tx.folio.findFirst.mockResolvedValue({ id: 'folio-1' });
      tx.folio.count.mockResolvedValue(0);
      foliosService.getFolio.mockResolvedValue({
        currency: 'NGN',
        lineItems: [
          line({}),
          line({ description: 'VAT 7.5%', chargeType: 'tax', amount: D('2250.00'), taxAmount: D('0.00') }),
          line({ description: 'Minibar — voided', chargeType: 'minibar', amount: D('5000.00'), isVoid: true, voidedBy: 'staff-user-2' }),
        ],
        payments: [pay({}), pay({ method: 'card', amount: D('99999.00'), isVoid: true, voidReason: 'Duplicate swipe' })],
        totals: { subTotal: D('30000.00'), taxTotal: D('2250.00'), totalCost: D('32250.00'), paymentsTotal: D('10000.00'), depositsTotal: D('0.00'), balanceDue: D('22250.00') },
      });
    });

    it('uses the same credential check as the lookup — the email must match', async () => {
      await service.getGuestFolio(SLUG, creds);
      const where = (tx.reservation.findFirst.mock.calls[0][0] as { where: { guest: unknown } }).where;
      expect(where.guest).toEqual({ email: { equals: 'ada@example.com', mode: 'insensitive' } });
    });

    it('404s with the generic booking message when credentials do not match', async () => {
      tx.reservation.findFirst.mockResolvedValue(null);
      await expect(service.getGuestFolio(SLUG, creds)).rejects.toMatchObject({ status: 404 });
      expect(foliosService.getFolio).not.toHaveBeenCalled();
    });

    it('refuses stays with no bill to show yet, without reading any folio', async () => {
      for (const status of ['confirmed', 'cancelled', 'no_show', 'waitlisted', 'walked']) {
        tx.reservation.findFirst.mockResolvedValue({ id: 'res-1', status, confirmationNumber: 'RES-2026-00001', confirmedRate: D('90000.00') });
        await expect(service.getGuestFolio(SLUG, creds)).rejects.toMatchObject({ status: 409 });
      }
      expect(foliosService.getFolio).not.toHaveBeenCalled();
    });

    it('reads only the PRIMARY folio (label null)', async () => {
      await service.getGuestFolio(SLUG, creds);
      expect(tx.folio.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { reservationId: 'res-1', label: null, deletedAt: null } }));
      expect(foliosService.getFolio).toHaveBeenCalledWith(TENANT_ID, 'folio-1');
    });

    it('never conjures a folio — a checked-in stay with none gets a 409, not a write', async () => {
      tx.folio.findFirst.mockResolvedValue(null);
      await expect(service.getGuestFolio(SLUG, creds)).rejects.toMatchObject({ status: 409 });
      expect(foliosService.getFolio).not.toHaveBeenCalled();
    });

    it('drops voided charges and voided payments from what the guest sees', async () => {
      const result = await service.getGuestFolio(SLUG, creds);
      expect(result.lineItems.map((l) => l.description)).toEqual(['Room Charge', 'VAT 7.5%']);
      expect(result.payments).toHaveLength(1);
      expect(result.payments[0].amount).toBe('10000.00');
    });

    it('lines and payments reconcile exactly with the totals shown — the bill adds up', async () => {
      const result = await service.getGuestFolio(SLUG, creds);
      const lineSum = result.lineItems.reduce((s, l) => s + Number(l.amount), 0);
      const paySum = result.payments.reduce((s, p) => s + Number(p.amount), 0);
      expect(lineSum).toBe(Number(result.totalCost));
      expect(paySum).toBe(Number(result.paymentsTotal));
      expect(Number(result.totalCost) - Number(result.paymentsTotal)).toBe(Number(result.balanceDue));
    });

    it("passes getFolio's own totals through untouched rather than recomputing them", async () => {
      const result = await service.getGuestFolio(SLUG, creds);
      expect(result).toMatchObject({ subTotal: '30000.00', taxTotal: '2250.00', totalCost: '32250.00', paymentsTotal: '10000.00', balanceDue: '22250.00', currency: 'NGN' });
    });

    it('exposes no staff ids, card references, shifts, outlets, tax-rule ids or void reasons', async () => {
      const result = await service.getGuestFolio(SLUG, creds);
      expect(Object.keys(result.lineItems[0]).sort()).toEqual(['amount', 'chargeType', 'description', 'postedAt', 'serviceDate']);
      expect(Object.keys(result.payments[0]).sort()).toEqual(['amount', 'method', 'purpose', 'recordedAt']);
      expect(Object.keys(result).sort()).toEqual([
        'asOf', 'balanceDue', 'confirmationNumber', 'currency', 'lineItems', 'otherFoliosExist',
        'payments', 'paymentsTotal', 'roomTotalForStay', 'stillAccruing', 'subTotal', 'taxTotal', 'totalCost',
      ]);
    });

    it('mid-stay, flags the bill as still accruing and shows the full-stay room rate beside it', async () => {
      const result = await service.getGuestFolio(SLUG, creds);
      expect(result.stillAccruing).toBe(true);
      expect(result.roomTotalForStay).toBe('90000.00');
    });

    it('after check-out, the bill is final — no accrual flag, no projection', async () => {
      tx.reservation.findFirst.mockResolvedValue({ id: 'res-1', status: 'checked_out', confirmationNumber: 'RES-2026-00001', confirmedRate: D('90000.00') });
      const result = await service.getGuestFolio(SLUG, creds);
      expect(result.stillAccruing).toBe(false);
      expect(result.roomTotalForStay).toBeNull();
    });

    it('says other folios exist without revealing anything about them', async () => {
      tx.folio.count.mockResolvedValue(1);
      const result = await service.getGuestFolio(SLUG, creds);
      expect(result.otherFoliosExist).toBe(true);
      expect(tx.folio.count).toHaveBeenCalledWith({ where: { reservationId: 'res-1', deletedAt: null, label: { not: null } } });
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
