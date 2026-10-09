import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { RoomsService } from '../property/rooms.service';
import { GuestsService } from '../guests/guests.service';
import { FoliosService } from '../folios/folios.service';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { RateResolverService } from '../rate-resolver/rate-resolver.service';
import { PackagesService } from '../rate-resolver/packages.service';
import { ChannelAllotmentsService } from '../revenue-management/channel-allotments.service';
import { RegistrationCardsService } from '../registration-cards/registration-cards.service';
import { CommsLogService } from '../comms-log/comms-log.service';
import { RestrictionsService } from '../revenue-management/restrictions.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { WebhookEventsService } from '../integrations/webhook-events.service';
import { TaxesService } from '../taxes/taxes.service';
import { RefundsService } from '../folios/refunds.service';
import { ReservationsService } from './reservations.service';

/** Webhook events are raised from the same audit calls these tests exercise; what they send is `WebhookEventsService`'s own spec. */
const webhookEvents = { reservationChanged: jest.fn().mockResolvedValue(undefined), paymentRecorded: jest.fn().mockResolvedValue(undefined) };
const taxesService = {
  priceCharge: jest.fn().mockImplementation((_tx: unknown, _branchId: string, _type: string, price: Prisma.Decimal) =>
    Promise.resolve({ price, net: price, taxes: [], taxTotal: new Prisma.Decimal(0), includedTax: new Prisma.Decimal(0), addedTax: new Prisma.Decimal(0), total: price }),
  ),
};
const refundsService = { refundable: jest.fn().mockResolvedValue({ credit: new Prisma.Decimal(0), available: new Prisma.Decimal(0) }), requestInTx: jest.fn().mockResolvedValue({ id: 'refund-1' }) };

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const TYPE_ID = '88888888-8888-4888-8888-888888888888';
const ROOM_ID = '77777777-7777-4777-8777-777777777777';
const GUEST_ID = '55555555-5555-4555-8555-555555555555';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR = { sub: ACTOR_ID, tenantId: TENANT_ID, email: '', roles: [{ role: 'manager', branchId: null }], tokenType: 'access' as const };

function reservation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RESERVATION_ID,
    branchId: BRANCH_ID,
    guestId: GUEST_ID,
    roomTypeId: TYPE_ID,
    roomId: null,
    confirmationNumber: 'RES-2026-00001',
    status: 'confirmed',
    checkInDate: new Date('2026-09-01T00:00:00.000Z'),
    checkOutDate: new Date('2026-09-04T00:00:00.000Z'),
    adults: 2,
    children: 0,
    confirmedRate: { toFixed: () => '300.00' },
    deletedAt: null,
    branch: { currency: 'NGN' },
    guest: { id: GUEST_ID, name: 'Ada Obi', email: 'ada@example.com', phone: null },
    roomType: { name: 'Standard' },
    ...overrides,
  };
}

/**
 * The rooms a pool query finds: `count`'s value as that many rooms in service
 * — so a test sets the pool with `room.count` whichever of the two the code
 * reads — plus any held ones a test adds with a release date.
 */
function roomPool(room: { count: jest.Mock }, held: Array<{ heldUntil: Date }> = []) {
  return jest.fn().mockImplementation(async () => [
    ...Array.from({ length: Number(await room.count()) }, (_, i) => ({ id: i === 0 ? ROOM_ID : `room-${i}`, heldStatus: null, heldUntil: null })),
    ...held.map((h, i) => ({ id: `held-${i}`, heldStatus: 'out_of_order', heldUntil: h.heldUntil })),
  ]);
}

function makeTx() {
  const room: { count: jest.Mock; findFirst: jest.Mock; findMany?: jest.Mock } = { count: jest.fn().mockResolvedValue(5), findFirst: jest.fn() };
  room.findMany = roomPool(room);
  return {
    room,
    roomType: {
      findFirst: jest.fn().mockResolvedValue({ id: TYPE_ID, branchId: BRANCH_ID, name: 'Standard', baseRate: '100.00', capacity: { adults: 10, children: 10 } }),
      findMany: jest.fn().mockResolvedValue([{ id: TYPE_ID, name: 'Standard' }]),
    },
    roomBlock: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    overbookingConfig: { findMany: jest.fn().mockResolvedValue([]) },
    groupBlock: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
    branch: { findFirst: jest.fn().mockResolvedValue({ timezone: 'Africa/Lagos' }) },
    walkRecord: { create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'walk-1', ...data })) },
    folio: { findFirst: jest.fn().mockResolvedValue(null) },
    payment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
    reservation: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(reservation({ ...data })),
      ),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(reservation({ ...data })),
      ),
    },
    lineItem: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    corporateAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'corp-1' }) },
    noShowRecord: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'nsr-1', penaltyWaived: false, ...data })),
      findFirst: jest.fn(),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'nsr-1', ...data })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    // The room-type lock ignores its result; the tenant's confirmation counter returns the next number.
    $queryRaw: jest.fn().mockResolvedValue([{ reservationSeq: 42 }]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
}

describe('ReservationsService', () => {
  let service: ReservationsService;
  let tx: ReturnType<typeof makeTx>;
  let propertyService: { assertBranch: jest.Mock };
  let roomsService: { applyReservationOccupancy: jest.Mock };
  let guestsService: { findOrCreateGuestInTx: jest.Mock; recordIdDocumentInTx: jest.Mock };
  let foliosService: {
    ensurePrimaryFolio: jest.Mock;
    postRoomChargeForDate: jest.Mock;
    backfillRoomCharges: jest.Mock;
    settleIfFullyPaid: jest.Mock;
    postAdHocCharge: jest.Mock;
    previewCharge: jest.Mock;
    reverseChargeInTx: jest.Mock;
    paidOnPrimaryFolio: jest.Mock;
    postChargeInTx: jest.Mock;
  };
  let housekeepingService: { createTaskInTx: jest.Mock; supersedeStayoverTasksInTx: jest.Mock };
  let rateResolverService: { resolveStay: jest.Mock; linkAuditLogsToReservation: jest.Mock };
  let registrationCardsService: { generateCardInTx: jest.Mock };
  let commsLogService: { logAutomatedInTx: jest.Mock };
  let restrictionsService: { assertNoViolation: jest.Mock; assertExtensionAllowed: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    propertyService = {
      assertBranch: jest.fn().mockResolvedValue({
        id: BRANCH_ID,
        name: 'Lekki Suites',
        address: { street: '12 Admiralty Way', city: 'Lagos', country: 'NG' },
        timezone: 'Africa/Lagos',
        currency: 'NGN',
        checkInTime: new Date('1970-01-01T14:00:00.000Z'),
        checkOutTime: new Date('1970-01-01T11:00:00.000Z'),
        noShowPolicy: null,
        cancellationPolicy: null,
        regCardTemplate: null,
      }),
    };
    roomsService = { applyReservationOccupancy: jest.fn().mockResolvedValue({}) };
    guestsService = {
      findOrCreateGuestInTx: jest.fn().mockResolvedValue({ id: GUEST_ID, name: 'John Doe' }),
      recordIdDocumentInTx: jest.fn().mockResolvedValue(undefined),
    };
    foliosService = {
      ensurePrimaryFolio: jest.fn().mockResolvedValue({ id: 'folio-1', status: 'open' }),
      postRoomChargeForDate: jest.fn().mockResolvedValue({ id: 'li-room' }),
      backfillRoomCharges: jest.fn().mockResolvedValue(0),
      settleIfFullyPaid: jest.fn().mockResolvedValue(true),
      postAdHocCharge: jest.fn().mockResolvedValue({ id: 'li-penalty' }),
      previewCharge: jest.fn((_tx: unknown, _branchId: string, _type: string, price: Prisma.Decimal) =>
        Promise.resolve({ price, net: price, taxes: [], taxTotal: new Prisma.Decimal(0), includedTax: new Prisma.Decimal(0), addedTax: new Prisma.Decimal(0), total: price }),
      ),
      reverseChargeInTx: jest.fn().mockResolvedValue({ id: 'li-reversal' }),
      paidOnPrimaryFolio: jest.fn().mockResolvedValue(new Prisma.Decimal(0)),
      postChargeInTx: jest.fn().mockResolvedValue({ id: 'li-fee' }),
    };
    housekeepingService = { createTaskInTx: jest.fn().mockResolvedValue({ id: 'task-1' }), supersedeStayoverTasksInTx: jest.fn().mockResolvedValue(0) };
    // Mirrors the OLD flat baseRate × nights math the resolver replaced —
    // ReservationsService's own tests only need to prove it wires the
    // resolver correctly (right roomType/dates in, `subtotal` out as
    // `confirmedRate`); the cascade/override math itself is
    // rate-resolver.service.spec.ts's job, not re-proven here.
    rateResolverService = {
      resolveStay: jest.fn().mockImplementation((_tx: unknown, _tenantId: string, _branchId: string, roomType: { baseRate: string }, checkInDate: Date, checkOutDate: Date) => {
        const nights = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / 86_400_000);
        const subtotal = new Prisma.Decimal(roomType.baseRate).mul(nights);
        return Promise.resolve({
          subtotal,
          nightlyRate: nights ? subtotal.div(nights) : new Prisma.Decimal(0),
          taxTotal: new Prisma.Decimal(0),
          totalWithTax: subtotal,
          ratePlanId: null,
          ruleApplied: { type: 'base', planName: null, adjustmentApplied: null },
          perNight: [],
          auditLogIds: [],
        });
      }),
      linkAuditLogsToReservation: jest.fn().mockResolvedValue(undefined),
    };
    registrationCardsService = { generateCardInTx: jest.fn().mockResolvedValue({ id: 'card-1' }) };
    commsLogService = { logAutomatedInTx: jest.fn().mockResolvedValue({ id: 'comm-1' }) };
    // Every existing test books a stay with no restrictions configured —
    // matches real behavior exactly (a tenant with none sees no violation).
    restrictionsService = { assertNoViolation: jest.fn().mockResolvedValue(undefined), assertExtensionAllowed: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReservationsService,
        {
          provide: PrismaService,
          useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) },
        },
        { provide: PropertyService, useValue: propertyService },
        { provide: RoomsService, useValue: roomsService },
        { provide: GuestsService, useValue: guestsService },
        { provide: FoliosService, useValue: foliosService },
        { provide: HousekeepingService, useValue: housekeepingService },
        { provide: RateResolverService, useValue: rateResolverService },
        { provide: RegistrationCardsService, useValue: registrationCardsService },
        { provide: CommsLogService, useValue: commsLogService },
        { provide: RestrictionsService, useValue: restrictionsService },
        { provide: PackagesService, useValue: { snapshotsFor: jest.fn().mockResolvedValue([]) } },
        { provide: ChannelAllotmentsService, useValue: { assertWithinAllotment: jest.fn().mockResolvedValue(undefined) } },
        { provide: LoyaltyService, useValue: { earnForStayInTx: jest.fn().mockResolvedValue(0) } },
        { provide: WebhookEventsService, useValue: webhookEvents },
        { provide: TaxesService, useValue: taxesService },
        { provide: RefundsService, useValue: refundsService },
      ],
    }).compile();
    service = moduleRef.get(ReservationsService);
  });

  describe('availability', () => {
    it('full pool, no blocks/reservations — every night equals the physical pool', async () => {
      tx.room.count.mockResolvedValue(5);
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-03', roomTypeId: TYPE_ID });
      expect(result).toEqual([
        { date: '2026-09-01', available: 5 },
        { date: '2026-09-02', available: 5 },
      ]);
    });

    it('a RoomBlock zeroes only the nights it actually covers', async () => {
      tx.room.count.mockResolvedValue(2);
      tx.roomBlock.findMany.mockResolvedValue([
        { roomId: ROOM_ID, fromDate: new Date('2026-09-02T00:00:00.000Z'), toDate: new Date('2026-09-02T00:00:00.000Z') },
      ]);
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-04', roomTypeId: TYPE_ID });
      expect(result).toEqual([
        { date: '2026-09-01', available: 2 },
        { date: '2026-09-02', available: 1 },
        { date: '2026-09-03', available: 2 },
      ]);
    });

    it('a guest still checked in after their departure keeps the room every night from then on — it isn’t sold under them', async () => {
      tx.room.count.mockResolvedValue(2);
      tx.branch.findFirst.mockResolvedValue({ timezone: 'Africa/Lagos', checkOutTime: new Date('1970-01-01T11:00:00.000Z') });
      tx.reservation.findMany.mockResolvedValue([
        // due out on 1 Aug 2026, never checked out
        { checkInDate: new Date('2026-07-30T00:00:00.000Z'), checkOutDate: new Date('2026-08-01T00:00:00.000Z'), status: 'checked_in' },
        // an ordinary confirmed booking that ended before the window
        { checkInDate: new Date('2026-07-30T00:00:00.000Z'), checkOutDate: new Date('2026-08-01T00:00:00.000Z'), status: 'confirmed' },
      ]);
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2099-01-01', to: '2099-01-03', roomTypeId: TYPE_ID });
      expect(tx.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: [{ checkOutDate: { gt: new Date('2099-01-01T00:00:00.000Z') } }, { status: 'checked_in' }] }) }),
      );
      expect(result).toEqual([
        { date: '2099-01-01', available: 1 },
        { date: '2099-01-02', available: 1 },
      ]);
    });

    it('a guest due out today but not yet past check-out time doesn’t hold tonight', async () => {
      tx.room.count.mockResolvedValue(2);
      const today = new Date().toISOString().slice(0, 10);
      // a check-out time of 23:59:59 that can't have passed yet in UTC+14 at the latest
      tx.branch.findFirst.mockResolvedValue({ timezone: 'UTC', checkOutTime: new Date('1970-01-01T23:59:59.000Z') });
      tx.reservation.findMany.mockResolvedValue([
        { checkInDate: new Date('2026-07-30T00:00:00.000Z'), checkOutDate: new Date(`${today}T00:00:00.000Z`), status: 'checked_in' },
      ]);
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: today, to: new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10), roomTypeId: TYPE_ID });
      expect(result).toEqual([{ date: today, available: 2 }]);
    });

    it('a room held with no release date is out of the pool for every night', async () => {
      tx.room.count.mockResolvedValue(4); // the query itself leaves out rooms held with no date — the pool is pre-reduced
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-03', roomTypeId: TYPE_ID });
      expect(tx.room.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: [{ heldStatus: null }, { heldUntil: { not: null } }] }) }),
      );
      expect(result.every((n) => n.available === 4)).toBe(true);
    });

    it('a room held until a date is sold again from that night', async () => {
      tx.room.count.mockResolvedValue(2);
      tx.room.findMany = roomPool(tx.room, [{ heldUntil: new Date('2026-09-02T00:00:00.000Z') }]);
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-04', roomTypeId: TYPE_ID });
      expect(result.map((n) => n.available)).toEqual([2, 3, 3]);
    });

    it('confirmed and checked_in reservations both count against availability', async () => {
      tx.room.count.mockResolvedValue(3);
      tx.reservation.findMany.mockResolvedValue([
        { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-03T00:00:00.000Z') },
      ]);
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-03', roomTypeId: TYPE_ID });
      expect(tx.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: { in: ['confirmed', 'checked_in'] } }) }),
      );
      expect(result).toEqual([
        { date: '2026-09-01', available: 2 },
        { date: '2026-09-02', available: 2 },
      ]);
    });

    it('rejects a range longer than 92 nights', async () => {
      await expect(
        service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-01-01', to: '2026-12-31', roomTypeId: TYPE_ID }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects to <= from', async () => {
      await expect(
        service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-03', to: '2026-09-01', roomTypeId: TYPE_ID }),
      ).rejects.toThrow(BadRequestException);
    });

    describe('overbooking', () => {
      it('by default (no config row), the physical pool is a hard ceiling — no overbooking', async () => {
        tx.room.count.mockResolvedValue(2);
        tx.reservation.findMany.mockResolvedValue([
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
        ]);
        const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02', roomTypeId: TYPE_ID });
        expect(result).toEqual([{ date: '2026-09-01', available: 0 }]);
      });

      it('globalEnabled + maxOverbookPct raises the ceiling past physical capacity', async () => {
        tx.room.count.mockResolvedValue(2);
        tx.overbookingConfig.findMany.mockResolvedValue([
          { roomTypeId: TYPE_ID, globalEnabled: true, maxOverbookPct: new Prisma.Decimal('50'), alertAtPct: null, validFrom: null, validTo: null },
        ]);
        // 2 physical + 50% = ceiling 3 — 2 already reserved leaves 1 available, past physical capacity.
        tx.reservation.findMany.mockResolvedValue([
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
        ]);
        const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02', roomTypeId: TYPE_ID });
        expect(result).toEqual([{ date: '2026-09-01', available: 1 }]);
      });

      it('a config row that exists but is NOT globalEnabled does not raise the ceiling', async () => {
        tx.room.count.mockResolvedValue(2);
        tx.overbookingConfig.findMany.mockResolvedValue([
          { roomTypeId: TYPE_ID, globalEnabled: false, maxOverbookPct: new Prisma.Decimal('50'), alertAtPct: null, validFrom: null, validTo: null },
        ]);
        tx.reservation.findMany.mockResolvedValue([
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
        ]);
        const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02', roomTypeId: TYPE_ID });
        expect(result).toEqual([{ date: '2026-09-01', available: 0 }]);
      });

      it('a night outside the config\'s validFrom/validTo window is NOT overbooked, even with globalEnabled true', async () => {
        tx.room.count.mockResolvedValue(2);
        tx.overbookingConfig.findMany.mockResolvedValue([
          { roomTypeId: TYPE_ID, globalEnabled: true, maxOverbookPct: new Prisma.Decimal('50'), alertAtPct: null, validFrom: new Date('2026-12-01'), validTo: new Date('2026-12-31') },
        ]);
        tx.reservation.findMany.mockResolvedValue([
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
        ]);
        const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02', roomTypeId: TYPE_ID });
        expect(result).toEqual([{ date: '2026-09-01', available: 0 }]);
      });

      it('a room-type-specific config governs over the branch-wide one when both apply to the same night', async () => {
        tx.room.count.mockResolvedValue(2);
        tx.overbookingConfig.findMany.mockResolvedValue([
          { roomTypeId: null, globalEnabled: true, maxOverbookPct: new Prisma.Decimal('10'), alertAtPct: null, validFrom: null, validTo: null },
          { roomTypeId: TYPE_ID, globalEnabled: true, maxOverbookPct: new Prisma.Decimal('50'), alertAtPct: null, validFrom: null, validTo: null },
        ]);
        // If the branch-wide 10% won, ceiling would be floor(2*1.1)=2, leaving 0 available. The room-type 50% should win: ceiling floor(2*1.5)=3.
        tx.reservation.findMany.mockResolvedValue([
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
        ]);
        const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02', roomTypeId: TYPE_ID });
        expect(result).toEqual([{ date: '2026-09-01', available: 1 }]);
      });

      it('falls back to the branch-wide config when no room-type-specific row exists', async () => {
        tx.room.count.mockResolvedValue(2);
        tx.overbookingConfig.findMany.mockResolvedValue([
          { roomTypeId: null, globalEnabled: true, maxOverbookPct: new Prisma.Decimal('50'), alertAtPct: null, validFrom: null, validTo: null },
        ]);
        tx.reservation.findMany.mockResolvedValue([
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
          { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
        ]);
        const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-02', roomTypeId: TYPE_ID });
        expect(result).toEqual([{ date: '2026-09-01', available: 1 }]);
      });
    });
  });

  describe('group block holds', () => {
    const blockDto = { guestId: GUEST_ID, roomTypeId: TYPE_ID, checkInDate: '2026-09-01', checkOutDate: '2026-09-04', adults: 2 };
    const heldBlock = (overrides: Record<string, unknown> = {}) => ({
      id: 'block-1',
      blockSize: 3,
      arrivalDate: new Date('2026-09-01T00:00:00.000Z'),
      departureDate: new Date('2026-09-03T00:00:00.000Z'),
      cutoffDate: new Date('2099-01-01T00:00:00.000Z'),
      ...overrides,
    });
    const openBlock = (overrides: Record<string, unknown> = {}) => ({
      id: 'block-1',
      branchId: BRANCH_ID,
      roomTypeId: TYPE_ID,
      status: 'active',
      blockSize: 10,
      blockRate: new Prisma.Decimal('45000'),
      name: 'Acme Conf',
      ...overrides,
    });

    it("keeps a block's unbooked rooms out of everyone else's availability until its cut-off", async () => {
      tx.groupBlock.findMany.mockResolvedValue([heldBlock()]);
      // One of the block's 3 rooms is booked, for the first night only: it counts once, as a booking,
      // and the block holds 2 more — the bookings it can still take — on each night of its stay.
      tx.reservation.findMany.mockResolvedValue([
        { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z'), groupBlockId: 'block-1' },
      ]);
      tx.reservation.groupBy.mockResolvedValue([{ groupBlockId: 'block-1', _count: { _all: 1 } }]);
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-04', roomTypeId: TYPE_ID });
      expect(result).toEqual([
        { date: '2026-09-01', available: 2 }, // 5 rooms − 1 booked − 2 held
        { date: '2026-09-02', available: 3 }, // 5 rooms − 2 held
        { date: '2026-09-03', available: 5 }, // the group has left
      ]);
    });

    it("stops holding once the allotment is booked up, even on a night a member left early", async () => {
      tx.groupBlock.findMany.mockResolvedValue([heldBlock({ blockSize: 2 })]);
      tx.reservation.findMany.mockResolvedValue([
        { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-03T00:00:00.000Z'), groupBlockId: 'block-1' },
        { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z'), groupBlockId: 'block-1' },
      ]);
      tx.reservation.groupBy.mockResolvedValue([{ groupBlockId: 'block-1', _count: { _all: 2 } }]);
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-03', roomTypeId: TYPE_ID });
      // Night 2: only one member stays, but the block is full — no room is kept off sale for nobody.
      expect(result).toEqual([
        { date: '2026-09-01', available: 3 },
        { date: '2026-09-02', available: 4 },
      ]);
    });

    it('gives the rooms back once the cut-off has passed — nothing has to run', async () => {
      tx.groupBlock.findMany.mockResolvedValue([heldBlock({ cutoffDate: new Date('2020-01-01T00:00:00.000Z') })]);
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-03', roomTypeId: TYPE_ID });
      expect(result.every((night) => night.available === 5)).toBe(true);
    });

    it("books into the block on the block's own held rooms, at its rate, linked in the same transaction", async () => {
      tx.groupBlock.findFirst.mockResolvedValue(openBlock());
      tx.reservation.count.mockResolvedValue(2);
      await service.createReservation(TENANT_ID, BRANCH_ID, blockDto, ACTOR_ID, { groupBlockId: 'block-1' });

      expect(tx.groupBlock.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { not: 'block-1' } }) }));
      const data = (tx.reservation.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
      expect(data).toMatchObject({ groupBlockId: 'block-1', overrideReason: 'Group block: Acme Conf' });
      expect(String(data.overrideRate)).toBe('45000');
    });

    it('refuses a booking into a full or released block, before anything is written', async () => {
      tx.groupBlock.findFirst.mockResolvedValue(openBlock({ blockSize: 2 }));
      tx.reservation.count.mockResolvedValue(2);
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, blockDto, ACTOR_ID, { groupBlockId: 'block-1' })).rejects.toThrow(ConflictException);

      tx.groupBlock.findFirst.mockResolvedValue(openBlock({ status: 'released' }));
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, blockDto, ACTOR_ID, { groupBlockId: 'block-1' })).rejects.toThrow(ConflictException);
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });
  });

  describe('createReservation', () => {
    const dto = { guestId: GUEST_ID, roomTypeId: TYPE_ID, checkInDate: '2026-09-01', checkOutDate: '2026-09-04', adults: 2 };

    it('rejects a party exceeding the room type\'s own capacity', async () => {
      tx.roomType.findFirst.mockResolvedValueOnce({ id: TYPE_ID, branchId: BRANCH_ID, name: 'Standard', baseRate: '100.00', capacity: { adults: 2, children: 0 } });
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, adults: 4, children: 9 }, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('checks adults and children independently — too many children still rejects even with adults within range', async () => {
      tx.roomType.findFirst.mockResolvedValueOnce({ id: TYPE_ID, branchId: BRANCH_ID, name: 'Standard', baseRate: '100.00', capacity: { adults: 2, children: 1 } });
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, adults: 2, children: 2 }, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('allows a party at exactly the room type\'s capacity', async () => {
      tx.roomType.findFirst.mockResolvedValueOnce({ id: TYPE_ID, branchId: BRANCH_ID, name: 'Standard', baseRate: '100.00', capacity: { adults: 2, children: 1 } });
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, adults: 2, children: 1 }, ACTOR_ID)).resolves.toBeDefined();
    });

    it('books a company stay under an active account and keeps the company and promo code on the reservation', async () => {
      await service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, corporateAccountId: 'corp-1', promoCode: ' SAVE10 ' }, ACTOR_ID);
      expect(rateResolverService.resolveStay).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, expect.anything(), expect.any(Date), expect.any(Date), expect.objectContaining({ promoCode: 'SAVE10', corporateAccountId: 'corp-1', occupancy: { adults: 2, children: 0 } }), expect.anything());
      expect(tx.reservation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ corporateAccountId: 'corp-1', promoCode: 'SAVE10' }) }));
    });

    it('refuses a company account that is not active', async () => {
      tx.corporateAccount.findFirst.mockResolvedValueOnce(null);
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, corporateAccountId: 'corp-gone' }, ACTOR_ID)).rejects.toThrow(/company account is not active/);
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('checks Revenue Management restrictions with the resolved branch/room type/dates', async () => {
      await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(restrictionsService.assertNoViolation).toHaveBeenCalledWith(tx, BRANCH_ID, TYPE_ID, new Date('2026-09-01T00:00:00.000Z'), new Date('2026-09-04T00:00:00.000Z'));
    });

    it('propagates a restriction violation and never creates the reservation row', async () => {
      restrictionsService.assertNoViolation.mockRejectedValueOnce(new ConflictException({ code: 'RESERVATION_NOT_AVAILABLE', message: 'A minimum stay of 3 nights is required for these dates' }));
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('sets confirmedRate = baseRate × nights as a Decimal', async () => {
      const result = await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(tx.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ confirmedRate: expect.objectContaining({ toString: expect.any(Function) }) }) }),
      );
      expect(String((result as unknown as { confirmedRate: unknown }).confirmedRate)).toBe('300'); // 100 × 3 nights
    });

    it('becomes a webhook event in the same transaction as the booking', async () => {
      const result = await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(webhookEvents.reservationChanged).toHaveBeenCalledWith(tx, {
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
        action: 'reservation.created',
        reservationId: (result as unknown as { id: string }).id,
        previousRoomId: undefined,
      });
    });

    it('resolves the rate through the Rate Resolver, passing promoCode/corporateAccountId through, and stores its winning ratePlanId', async () => {
      rateResolverService.resolveStay.mockResolvedValueOnce({
        subtotal: new Prisma.Decimal('270'),
        nightlyRate: new Prisma.Decimal('90'),
        taxTotal: new Prisma.Decimal('0'),
        totalWithTax: new Prisma.Decimal('270'),
        ratePlanId: 'plan-promo-1',
        ruleApplied: { type: 'override', planName: 'Labor Day Promo', adjustmentApplied: null },
        perNight: [],
        auditLogIds: [],
      });
      await service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, promoCode: 'LABORDAY', corporateAccountId: 'corp-1' }, ACTOR_ID);

      expect(rateResolverService.resolveStay).toHaveBeenCalledWith(
        tx,
        TENANT_ID,
        BRANCH_ID,
        expect.objectContaining({ id: TYPE_ID }),
        expect.any(Date),
        expect.any(Date),
        expect.objectContaining({ promoCode: 'LABORDAY', corporateAccountId: 'corp-1' }),
        { triggeredBy: 'booking_create', userId: ACTOR_ID },
      );
      expect(tx.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ratePlanId: 'plan-promo-1', confirmedRate: expect.objectContaining({ toString: expect.any(Function) }) }) }),
      );
    });

    /**
     * `resolveStay` resolves the rate BEFORE the reservation row exists (no
     * id yet to attach), so its own RateAuditLog rows are written with
     * `reservationId: null` — the schema's documented "pre-booking
     * calculation" state. Left there permanently, the audit trail for the
     * exact calculation that set the price would be unlinkable, which is
     * the one a real dispute needs. This proves the backfill actually
     * fires with the resolver's own returned ids and the real new
     * reservation id — not just that SOME call happens.
     */
    it('backfills the reservationId onto the audit rows the resolver wrote before the reservation existed', async () => {
      rateResolverService.resolveStay.mockResolvedValueOnce({
        subtotal: new Prisma.Decimal('300'),
        nightlyRate: new Prisma.Decimal('100'),
        taxTotal: new Prisma.Decimal('0'),
        totalWithTax: new Prisma.Decimal('300'),
        ratePlanId: null,
        ruleApplied: { type: 'base', planName: null, adjustmentApplied: null },
        perNight: [],
        auditLogIds: [1n, 2n, 3n],
      });
      const result = await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(rateResolverService.linkAuditLogsToReservation).toHaveBeenCalledWith(tx, [1n, 2n, 3n], (result as unknown as { id: string }).id);
    });

    it('rejects when any night in the stay has 0 availability', async () => {
      tx.room.count.mockResolvedValue(0);
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('rejects when neither guestId nor guest is given', async () => {
      const { guestId: _guestId, ...rest } = dto;
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, rest as never, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('rejects when both guestId and guest are given', async () => {
      await expect(
        service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, guest: { name: 'Jane' } }, ACTOR_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects checkOutDate <= checkInDate', async () => {
      await expect(
        service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, checkOutDate: '2026-09-01' }, ACTOR_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('numbers the booking from the organisation’s own counter — one sequence for every branch', async () => {
      await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      const data = (tx.reservation.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
      expect(data.confirmationNumber).toBe(`RES-${new Date().getFullYear()}-00042`);
      // The counter is bumped on the tenant row, never predicted from a count of this branch's rows.
      const sql = tx.$queryRaw.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(sql.some((text: string) => text.includes('UPDATE tenants SET "reservationSeq"'))).toBe(true);
      expect(tx.reservation.findUnique).not.toHaveBeenCalled();
    });

    /**
     * The TOCTOU case `createReservationRow`'s own comment names: the
     * predicted number looked free, but the real INSERT collides anyway.
     * This is the path that was actually broken — Postgres aborts the
     * WHOLE transaction the instant `create()` throws, so the retry's own
     * `generateConfirmationNumber` queries on that same transaction would
     * fail with `25P02` regardless of what they asked for, unless the
     * failed insert is first rolled back to a savepoint. Found live
     * against real Postgres, not by inspection — this mock can't
     * reproduce Postgres's own abort-the-transaction behavior, so it only
     * proves the SAVEPOINT/ROLLBACK calls happen in the right order and
     * that a genuine INSERT-time collision still recovers.
     */
    it('recovers from a REAL insert-time collision via a savepoint, not just a predicted one', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on confirmationNumber', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      tx.reservation.create.mockRejectedValueOnce(p2002).mockImplementationOnce(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(reservation({ ...data })),
      );
      const result = await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(result).toBeDefined();
      expect(tx.reservation.create).toHaveBeenCalledTimes(2);
      expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SAVEPOINT create_reservation_attempt');
      expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT create_reservation_attempt');
      expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('RELEASE SAVEPOINT create_reservation_attempt');
      // Rollback must happen before the retry re-derives a confirmation
      // number — on real Postgres, calling generateConfirmationNumber
      // (its own count/findUnique queries) on a still-aborted transaction
      // is exactly the bug this fixes.
      const calls = tx.$executeRawUnsafe.mock.calls.map((c: unknown[]) => c[0]);
      const rollbackIndex = calls.indexOf('ROLLBACK TO SAVEPOINT create_reservation_attempt');
      const secondSavepointIndex = calls.indexOf('SAVEPOINT create_reservation_attempt', rollbackIndex + 1);
      expect(rollbackIndex).toBeGreaterThanOrEqual(0);
      expect(secondSavepointIndex).toBeGreaterThan(rollbackIndex);
    });

    it('exhausting all 3 attempts on real collisions throws the app\'s own clean error, not the raw Prisma one', async () => {
      const p2002 = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed on confirmationNumber', { code: 'P2002', clientVersion: '5.0.0' });
      tx.reservation.create.mockRejectedValue(p2002()); // every attempt collides for real
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
      expect(tx.reservation.create).toHaveBeenCalledTimes(3);
    });

    it('a non-collision error still rolls back its savepoint but rethrows immediately, without retrying', async () => {
      tx.reservation.create.mockRejectedValueOnce(new Error('connection reset'));
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID)).rejects.toThrow('connection reset');
      expect(tx.reservation.create).toHaveBeenCalledTimes(1);
      expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT create_reservation_attempt');
    });

    it('defaults channel to direct when omitted', async () => {
      await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(tx.reservation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ channel: 'direct' }) }));
    });

    it("keeps each night's own price on the booking, so a 30,000 + 45,000 stay never bills as two nights of 37,500", async () => {
      rateResolverService.resolveStay.mockResolvedValueOnce({
        subtotal: new Prisma.Decimal('75000'),
        nightlyRate: new Prisma.Decimal('37500'),
        taxTotal: new Prisma.Decimal(0),
        totalWithTax: new Prisma.Decimal('75000'),
        ratePlanId: null,
        ruleApplied: { type: 'cascade', planName: 'Weekend', adjustmentApplied: null },
        perNight: [
          { date: '2026-09-01', finalRate: '30000.00', isOverride: false, ratePlanId: null },
          { date: '2026-09-02', finalRate: '45000.00', isOverride: false, ratePlanId: 'plan-weekend' },
        ],
        auditLogIds: [],
      });
      await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(tx.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nightlyRates: [
              { date: '2026-09-01', rate: '30000.00' },
              { date: '2026-09-02', rate: '45000.00' },
            ],
          }),
        }),
      );
    });

    it('writes down the cancellation terms in force at booking — the resolved default when the branch has none', async () => {
      await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(tx.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellationPolicy: { freeCancellationHours: 24, lateCancellationPenalty: 'first_night', flatFeeAmount: null, allowOnlineCancellation: true },
          }),
        }),
      );
    });

    it('joinWaitlist SKIPS the availability check and creates as waitlisted', async () => {
      tx.room.count.mockResolvedValue(0); // zero availability — would reject a normal booking
      await service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, joinWaitlist: true }, ACTOR_ID);
      expect(tx.reservation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'waitlisted' }) }));
    });

    it('joinWaitlist still rejects an invalid date range', async () => {
      await expect(
        service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, joinWaitlist: true, checkOutDate: '2026-09-01' }, ACTOR_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('without joinWaitlist, zero availability is still rejected as before', async () => {
      tx.room.count.mockResolvedValue(0);
      await expect(service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('logs a booking_confirmation comms row for a real booking — with the nights, the price, the times and the address', async () => {
      await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(commsLogService.logAutomatedInTx).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, expect.objectContaining({ guestId: GUEST_ID, trigger: 'booking_confirmation' }));
      const { body } = commsLogService.logAutomatedInTx.mock.calls[0][3] as { body: string };
      expect(body).toContain('at Lekki Suites is confirmed');
      expect(body).toContain('Rate: NGN 300.00 for the stay');
      expect(body).toContain('Check-in from 14:00 · Check-out by 11:00');
      expect(body).toContain('12 Admiralty Way, Lagos, NG');
    });

    it('does NOT log a booking_confirmation for a waitlist join — nothing is confirmed yet', async () => {
      tx.room.count.mockResolvedValue(0);
      await service.createReservation(TENANT_ID, BRANCH_ID, { ...dto, joinWaitlist: true }, ACTOR_ID);
      expect(commsLogService.logAutomatedInTx).not.toHaveBeenCalled();
    });
  });

  describe('walkIn', () => {
    // Computed forward from today, never hardcoded: `walkIn` deliberately
    // forces checkInDate to TODAY in the branch timezone, so a fixed
    // checkOutDate literal silently becomes a past date once real time passes
    // it and every test here starts failing on "checkOutDate must be after
    // checkInDate". That is exactly what happened to the previous
    // '2026-09-04' literal.
    const dto = { guestId: GUEST_ID, roomTypeId: TYPE_ID, roomId: ROOM_ID, checkOutDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), adults: 2 };

    it('rejects a party exceeding the room type\'s own capacity', async () => {
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      tx.roomType.findFirst.mockResolvedValueOnce({ id: TYPE_ID, branchId: BRANCH_ID, name: 'Standard', baseRate: '100.00', capacity: { adults: 2, children: 0 } });
      await expect(service.walkIn(TENANT_ID, BRANCH_ID, { ...dto, adults: 4, children: 9 }, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('forces checkInDate to today in the branch timezone, never client-supplied', async () => {
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      await service.walkIn(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(tx.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'checked_in', channel: 'walk_in', roomId: ROOM_ID }) }),
      );
      expect(roomsService.applyReservationOccupancy).toHaveBeenCalledWith(tx, TENANT_ID, ROOM_ID, { occupancyStatus: 'occupied' }, ACTOR_ID);
    });

    it('rejects a room from a different room type', async () => {
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: 'other-type', occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      await expect(service.walkIn(TENANT_ID, BRANCH_ID, dto, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('rejects an occupied room', async () => {
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'occupied', heldStatus: null, deletedAt: null });
      await expect(service.walkIn(TENANT_ID, BRANCH_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('a walk-in IS a check-in — the registration card is generated the same way', async () => {
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      await service.walkIn(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(registrationCardsService.generateCardInTx).toHaveBeenCalledWith(tx, TENANT_ID, expect.objectContaining({ branch: { currency: 'NGN', regCardTemplate: null } }), ACTOR_ID);
    });

    it('does not record an ID document when none is given', async () => {
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      await service.walkIn(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(guestsService.recordIdDocumentInTx).not.toHaveBeenCalled();
    });

    it('records the ID document against the walked-in guest when given', async () => {
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      const idDocument = { idDocType: 'passport' as const, idDocNumber: 'P1234567' };
      await service.walkIn(TENANT_ID, BRANCH_ID, { ...dto, idDocument }, ACTOR_ID);
      expect(guestsService.recordIdDocumentInTx).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, GUEST_ID, idDocument, ACTOR_ID);
    });
  });

  describe('checkIn', () => {
    it('rejects a non-confirmed reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in' }));
      await expect(service.checkIn(TENANT_ID, RESERVATION_ID, {}, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('requires a roomId when the reservation has none yet', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null }));
      await expect(service.checkIn(TENANT_ID, RESERVATION_ID, {}, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('rejects a room with an overlapping RoomBlock', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      tx.roomBlock.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID }, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('refuses to check in before the arrival day — the dates are moved first, so the nights until then are priced', async () => {
      tx.reservation.findFirst.mockResolvedValue(
        reservation({ status: 'confirmed', roomId: null, checkInDate: new Date('2030-06-01T00:00:00.000Z'), checkOutDate: new Date('2030-06-03T00:00:00.000Z') }),
      );
      await expect(service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID }, ACTOR_ID)).rejects.toThrow(/arrives on 2030-06-01/);
      expect(tx.reservation.update).not.toHaveBeenCalled();
    });

    it('happy path sets roomId + actualCheckIn and marks the room occupied', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      await service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID }, ACTOR_ID);
      expect(tx.reservation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'checked_in', roomId: ROOM_ID }) }),
      );
      expect(roomsService.applyReservationOccupancy).toHaveBeenCalledWith(tx, TENANT_ID, ROOM_ID, { occupancyStatus: 'occupied' }, ACTOR_ID);
    });

    it('opens the folio and accrues ONLY the arrival night (night audit posts the rest)', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      await service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID }, ACTOR_ID);
      expect(foliosService.ensurePrimaryFolio).toHaveBeenCalled();
      expect(foliosService.postRoomChargeForDate).toHaveBeenCalledTimes(1);
      expect(foliosService.postRoomChargeForDate).toHaveBeenCalledWith(
        tx, expect.anything(), expect.anything(), expect.any(Date), 'Check-in', ACTOR_ID,
      );
    });

    it('cleanliness is a soft filter, not enforced server-side (dirty room still allowed)', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, cleanlinessStatus: 'dirty', deletedAt: null });
      await expect(service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID }, ACTOR_ID)).resolves.toBeDefined();
    });

    it('auto-generates the registration card in the same transaction — "auto-generated when check-in is triggered"', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      await service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID }, ACTOR_ID);
      expect(registrationCardsService.generateCardInTx).toHaveBeenCalledWith(tx, TENANT_ID, expect.objectContaining({ branch: { currency: 'NGN', regCardTemplate: null } }), ACTOR_ID);
    });

    it('logs a checkin_receipt comms row', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null, number: '204' });
      await service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID }, ACTOR_ID);
      expect(commsLogService.logAutomatedInTx).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, expect.objectContaining({ guestId: GUEST_ID, trigger: 'checkin_receipt' }));
    });

    it('never blocks check-in when no ID document is given', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      await expect(service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID }, ACTOR_ID)).resolves.toBeDefined();
      expect(guestsService.recordIdDocumentInTx).not.toHaveBeenCalled();
    });

    it('records the ID document against the reservation guest when given', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null }));
      tx.room.findFirst.mockResolvedValue({ id: ROOM_ID, branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null });
      const idDocument = { idDocType: 'national_id' as const, idDocNumber: 'N9988776' };
      await service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID, idDocument }, ACTOR_ID);
      expect(guestsService.recordIdDocumentInTx).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, GUEST_ID, idDocument, ACTOR_ID);
    });
  });

  describe('checkOut', () => {
    it('rejects a non-checked_in reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await expect(service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR)).rejects.toThrow(ConflictException);
    });

    it('happy path marks the room vacant + dirty in one call', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR);
      expect(roomsService.applyReservationOccupancy).toHaveBeenCalledWith(
        tx, TENANT_ID, ROOM_ID, { occupancyStatus: 'vacant', cleanlinessStatus: 'dirty' }, ACTOR_ID,
      );
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'checked_out' }) }));
    });

    // The City Ledger rule (see checkOut's own comment): a departing guest
    // who still owes must NOT be held hostage — the room has to release.
    it('SUCCEEDS with an outstanding balance and leaves the folio open (City Ledger receivable)', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      foliosService.settleIfFullyPaid.mockResolvedValue(false); // balance still owed
      await expect(service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR)).resolves.toBeDefined();
      expect(roomsService.applyReservationOccupancy).toHaveBeenCalled(); // room released regardless
    });

    it('settles the folio when it is fully paid', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR);
      expect(foliosService.settleIfFullyPaid).toHaveBeenCalled();
    });

    // Task Board reflects a checked-out room automatically — nobody has to remember to flag it.
    it('creates a housekeeping task for the room, traceable back to this reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR);
      expect(housekeepingService.createTaskInTx).toHaveBeenCalledWith(
        tx, TENANT_ID, BRANCH_ID,
        expect.objectContaining({ roomId: ROOM_ID, triggerEvent: 'checkout', triggeredByReservationId: RESERVATION_ID }),
      );
    });

    it("retires the room's waiting stay-over service first — the check-out clean replaces it", async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR);
      expect(housekeepingService.supersedeStayoverTasksInTx).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, ROOM_ID, expect.stringContaining('checked out'), ACTOR_ID);
      expect(housekeepingService.supersedeStayoverTasksInTx.mock.invocationCallOrder[0]).toBeLessThan(housekeepingService.createTaskInTx.mock.invocationCallOrder[0]);
    });

    // Safety net: a guest leaving before the night audit next runs would
    // otherwise depart with un-posted nights.
    it('backfills any elapsed-but-unposted night before settling', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR);
      expect(foliosService.backfillRoomCharges).toHaveBeenCalledWith(
        tx, expect.anything(), expect.anything(), expect.any(Date), 'Check-out', ACTOR_ID,
      );
      const backfillOrder = foliosService.backfillRoomCharges.mock.invocationCallOrder[0];
      const settleOrder = foliosService.settleIfFullyPaid.mock.invocationCallOrder[0];
      expect(backfillOrder).toBeLessThan(settleOrder);
    });

    it('logs a post_stay comms row', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR);
      expect(commsLogService.logAutomatedInTx).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, expect.objectContaining({ guestId: GUEST_ID, trigger: 'post_stay' }));
    });

    describe('late check-out and early departure fees', () => {
      const FRONT_DESK = { ...ACTOR, roles: [{ role: 'front_desk', branchId: BRANCH_ID }] };
      function branchWithFees(stayFeePolicy: unknown) {
        propertyService.assertBranch.mockResolvedValue({
          id: BRANCH_ID,
          timezone: 'Africa/Lagos',
          currency: 'NGN',
          checkInTime: new Date('1970-01-01T14:00:00.000Z'),
          checkOutTime: new Date('1970-01-01T11:00:00.000Z'),
          stayFeePolicy,
        });
      }
      afterEach(() => jest.useRealTimers());

      it('charges the late check-out fee after check-out time on the last day', async () => {
        // 1 p.m. in Lagos on the departure day (the 4th).
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
        branchWithFees({ lateCheckout: { feeType: 'flat', amount: 5000, graceMinutes: 0 } });
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
        await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR);
        expect(foliosService.postChargeInTx).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({ id: 'folio-1' }),
          expect.objectContaining({ description: 'Late check-out fee', amount: new Prisma.Decimal(5000), chargeType: 'penalty' }),
          ACTOR_ID,
        );
        // On the bill before it's checked for settling.
        expect(foliosService.postChargeInTx.mock.invocationCallOrder[0]).toBeLessThan(foliosService.settleIfFullyPaid.mock.invocationCallOrder[0]);
      });

      it('charges the early departure fee when leaving before the booked last night', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(new Date('2026-09-02T08:00:00.000Z'));
        branchWithFees({ earlyDeparture: { feeType: 'flat', amount: 7500 } });
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
        await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR);
        expect(foliosService.postChargeInTx).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ description: 'Early departure fee (2 nights given up)' }), ACTOR_ID);
      });

      it('a manager can waive them, with the reason on record', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(new Date('2026-09-02T08:00:00.000Z'));
        branchWithFees({ earlyDeparture: { feeType: 'flat', amount: 7500 } });
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
        await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR, { waiveFees: true, waiverReason: 'Family emergency' });
        expect(foliosService.postChargeInTx).not.toHaveBeenCalled();
        expect(tx.auditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ action: 'reservation.check_out_fees_waived', after: expect.objectContaining({ reason: 'Family emergency' }) }) }),
        );
      });

      it('the front desk cannot waive them, and a waiver needs a reason', async () => {
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
        await expect(service.checkOut(TENANT_ID, RESERVATION_ID, FRONT_DESK, { waiveFees: true, waiverReason: 'Nice guest' })).rejects.toThrow(ForbiddenException);
        await expect(service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR, { waiveFees: true })).rejects.toThrow(BadRequestException);
      });

      it('charges nothing without a policy', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(new Date('2026-09-04T15:00:00.000Z'));
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
        await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR);
        expect(foliosService.postChargeInTx).not.toHaveBeenCalled();
      });
    });
  });

  describe('cancel', () => {
    // Far enough ahead that the real clock is always inside the free window.
    const farAhead = (overrides: Partial<Record<string, unknown>> = {}) =>
      reservation({
        status: 'confirmed',
        checkInDate: new Date('2030-06-01T00:00:00.000Z'),
        checkOutDate: new Date('2030-06-04T00:00:00.000Z'),
        confirmedRate: new Prisma.Decimal('90000'),
        overrideRate: null,
        ...overrides,
      });

    it('allowed from confirmed', async () => {
      tx.reservation.findFirst.mockResolvedValue(farAhead());
      await service.cancel(TENANT_ID, RESERVATION_ID, {}, ACTOR_ID);
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'cancelled' } }));
    });

    it('rejected from checked_in', async () => {
      tx.reservation.findFirst.mockResolvedValue(farAhead({ status: 'checked_in' }));
      await expect(service.cancel(TENANT_ID, RESERVATION_ID, {}, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('rejected when already cancelled', async () => {
      tx.reservation.findFirst.mockResolvedValue(farAhead({ status: 'cancelled' }));
      await expect(service.cancel(TENANT_ID, RESERVATION_ID, {}, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('logs a cancellation comms row, including the reason and that nothing was charged', async () => {
      tx.reservation.findFirst.mockResolvedValue(farAhead());
      await service.cancel(TENANT_ID, RESERVATION_ID, { reason: 'Guest changed plans' }, ACTOR_ID);
      expect(commsLogService.logAutomatedInTx).toHaveBeenCalledWith(
        tx, TENANT_ID, BRANCH_ID,
        expect.objectContaining({
          guestId: GUEST_ID,
          trigger: 'cancellation',
          body: expect.stringMatching(/Guest changed plans.*No cancellation charge applies/),
        }),
      );
    });

    it('inside the free window nothing is charged and no folio is opened', async () => {
      tx.reservation.findFirst.mockResolvedValue(farAhead());
      await service.cancel(TENANT_ID, RESERVATION_ID, {}, ACTOR_ID);
      expect(foliosService.ensurePrimaryFolio).not.toHaveBeenCalled();
      expect(foliosService.postAdHocCharge).not.toHaveBeenCalled();
    });
  });

  describe('cancellation policy — quote and cancelInTx', () => {
    // Lagos (UTC+1) with a 14:00 check-in: 13:00Z on the arrival day. The
    // default policy is free until 24 hours before that.
    const stay = (overrides: Partial<Record<string, unknown>> = {}) =>
      reservation({
        status: 'confirmed',
        checkInDate: new Date('2026-10-10T00:00:00.000Z'),
        checkOutDate: new Date('2026-10-13T00:00:00.000Z'),
        confirmedRate: new Prisma.Decimal('90000'),
        overrideRate: null,
        ...overrides,
      });
    const IN_FREE_WINDOW = new Date('2026-10-09T12:59:00.000Z');
    const IN_LATE_WINDOW = new Date('2026-10-09T13:00:00.000Z');
    const lastAudit = () => (tx.auditLog.create.mock.calls[tx.auditLog.create.mock.calls.length - 1][0] as { data: { userId: unknown; after: Record<string, unknown> } }).data;

    beforeEach(() => {
      tx.reservation.findFirst.mockResolvedValue(stay());
      // 7.5% VAT on the charge, the way the branch's tax rules would compute it.
      foliosService.previewCharge.mockImplementation((_tx: unknown, _branchId: string, _type: string, price: Prisma.Decimal) => {
        const addedTax = price.mul('0.075').toDecimalPlaces(2);
        return Promise.resolve({ price, net: price, taxes: [], taxTotal: addedTax, includedTax: new Prisma.Decimal(0), addedTax, total: price.plus(addedTax) });
      });
    });

    it('quotes a free cancellation up to 24 hours before check-in time, and says so in one sentence', async () => {
      const quote = await service.quoteCancellationInTx(tx as never, RESERVATION_ID, IN_FREE_WINDOW);
      expect(quote).toMatchObject({ withinFreeWindow: true, penaltyTotal: '0.00', cancellable: true, currency: 'NGN' });
      expect(quote.freeCancellationUntil.toISOString()).toBe('2026-10-09T13:00:00.000Z');
      expect(quote.policy.summary).toBe('Free cancellation until 24 hours before check-in (14:00 on your arrival day). After that, the first night is charged.');
    });

    it('from that moment on, quotes the first night plus its tax', async () => {
      const quote = await service.quoteCancellationInTx(tx as never, RESERVATION_ID, IN_LATE_WINDOW);
      expect(quote).toMatchObject({
        withinFreeWindow: false,
        penaltyType: 'first_night',
        penaltyAmount: '30000.00',
        penaltyTax: '2250.00',
        penaltyTaxIncluded: '0.00',
        penaltyTotal: '32250.00',
        amountOwed: '32250.00',
        refundDue: '0.00',
      });
    });

    it('a branch with tax-inclusive rates charges the night as priced, and says how much tax is inside it', async () => {
      foliosService.previewCharge.mockImplementation((_tx: unknown, _branchId: string, _type: string, price: Prisma.Decimal) => {
        const includedTax = price.minus(price.div('1.075')).toDecimalPlaces(2);
        return Promise.resolve({ price, net: price.minus(includedTax), taxes: [], taxTotal: includedTax, includedTax, addedTax: new Prisma.Decimal(0), total: price });
      });
      const quote = await service.quoteCancellationInTx(tx as never, RESERVATION_ID, IN_LATE_WINDOW);
      expect(quote).toMatchObject({ penaltyAmount: '30000.00', penaltyTax: '0.00', penaltyTaxIncluded: '2093.02', penaltyTotal: '30000.00', amountOwed: '30000.00' });
    });

    it('a late cancellation posts the charge as an ordinary penalty line on the primary folio', async () => {
      await service.cancelInTx(tx as never, TENANT_ID, RESERVATION_ID, { actorId: ACTOR_ID, source: 'staff', now: IN_LATE_WINDOW });
      const call = foliosService.postAdHocCharge.mock.calls[0] as unknown[];
      expect(call[3]).toBe('penalty');
      expect((call[4] as Prisma.Decimal).toFixed(2)).toBe('30000.00');
      expect(call[5]).toBe('Cancellation Charge (first night)');
      expect(call[6]).toBe(ACTOR_ID);
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'cancelled' } }));
      expect(lastAudit().after).toMatchObject({ source: 'staff', withinFreeWindow: false, charged: '32250.00', waived: false });
    });

    it('refuses to charge an amount the person cancelling was not shown — and changes nothing', async () => {
      const error = await service
        .cancelInTx(tx as never, TENANT_ID, RESERVATION_ID, { actorId: ACTOR_ID, source: 'staff', acknowledgedPenaltyTotal: '0.00', now: IN_LATE_WINDOW })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'CANCELLATION_TERMS_CHANGED' });
      expect(tx.reservation.update).not.toHaveBeenCalled();
      expect(foliosService.postAdHocCharge).not.toHaveBeenCalled();
    });

    it('goes ahead when the acknowledged charge matches', async () => {
      await service.cancelInTx(tx as never, TENANT_ID, RESERVATION_ID, { actorId: ACTOR_ID, source: 'staff', acknowledgedPenaltyTotal: '32250.00', now: IN_LATE_WINDOW });
      expect(foliosService.postAdHocCharge).toHaveBeenCalled();
    });

    it("a manager's waiver cancels without charging, and audits the waiver with its reason", async () => {
      await service.cancelInTx(tx as never, TENANT_ID, RESERVATION_ID, { actorId: ACTOR_ID, source: 'staff', waiverReason: 'Flight cancelled', now: IN_LATE_WINDOW });
      expect(foliosService.postAdHocCharge).not.toHaveBeenCalled();
      expect(lastAudit().after).toMatchObject({ waived: true, waiverReason: 'Flight cancelled', charged: '0.00', penaltyTotal: '32250.00' });
    });

    it('a waitlisted booking is always free to cancel', async () => {
      tx.reservation.findFirst.mockResolvedValue(stay({ status: 'waitlisted' }));
      const { charged } = await service.cancelInTx(tx as never, TENANT_ID, RESERVATION_ID, { actorId: ACTOR_ID, source: 'staff', now: IN_LATE_WINDOW });
      expect(charged.toFixed(2)).toBe('0.00');
      expect(foliosService.postAdHocCharge).not.toHaveBeenCalled();
    });

    it("applies the branch's own policy — a 48-hour window and a flat fee", async () => {
      propertyService.assertBranch.mockResolvedValue({
        id: BRANCH_ID, timezone: 'Africa/Lagos', currency: 'NGN', checkInTime: new Date('1970-01-01T14:00:00.000Z'),
        cancellationPolicy: { freeCancellationHours: 48, lateCancellationPenalty: 'flat_fee', flatFeeAmount: 5000, allowOnlineCancellation: true },
      });
      const quote = await service.quoteCancellationInTx(tx as never, RESERVATION_ID, new Date('2026-10-08T13:00:00.000Z'));
      expect(quote.freeCancellationUntil.toISOString()).toBe('2026-10-08T13:00:00.000Z');
      expect(quote).toMatchObject({ penaltyType: 'flat_fee', penaltyAmount: '5000.00', penaltyTotal: '5375.00' });
    });

    it('counts anything already paid: a deposit larger than the charge leaves a refund due', async () => {
      foliosService.paidOnPrimaryFolio.mockResolvedValue(new Prisma.Decimal('50000'));
      const quote = await service.quoteCancellationInTx(tx as never, RESERVATION_ID, IN_LATE_WINDOW);
      expect(quote).toMatchObject({ paidSoFar: '50000.00', refundDue: '17750.00', amountOwed: '0.00' });
    });

    it('a guest cancelling is recorded with a NULL actor — never an empty string or "system"', async () => {
      await service.cancelInTx(tx as never, TENANT_ID, RESERVATION_ID, { actorId: null, source: 'guest', now: IN_LATE_WINDOW });
      expect(foliosService.ensurePrimaryFolio).toHaveBeenCalledWith(tx, expect.anything(), null);
      expect(lastAudit()).toMatchObject({ userId: null, after: expect.objectContaining({ source: 'guest' }) });
    });

    it('reports when check-in time on the arrival day has passed', async () => {
      const quote = await service.quoteCancellationInTx(tx as never, RESERVATION_ID, new Date('2026-10-10T13:00:00.000Z'));
      expect(quote.pastCheckInTime).toBe(true);
    });

    it("uses the terms the booking was made under, not the branch's current policy", async () => {
      // Booked under a strict 30-day window; the branch has since gone back to the default (NULL).
      tx.reservation.findFirst.mockResolvedValue(
        stay({ cancellationPolicy: { freeCancellationHours: 720, lateCancellationPenalty: 'first_night', flatFeeAmount: null, allowOnlineCancellation: true } }),
      );
      const quote = await service.quoteCancellationInTx(tx as never, RESERVATION_ID, IN_FREE_WINDOW);
      expect(quote.policy.freeCancellationHours).toBe(720);
      expect(quote).toMatchObject({ withinFreeWindow: false, penaltyTotal: '32250.00' });
    });
  });

  describe('no-show handling', () => {
    describe('listPendingNoShows', () => {
      it('queries confirmed reservations at this branch whose check-in date has passed', async () => {
        await service.listPendingNoShows(TENANT_ID, BRANCH_ID);
        expect(tx.reservation.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ branchId: BRANCH_ID, status: 'confirmed' }) }),
        );
      });
    });

    describe('markNoShow', () => {
      it('rejects a reservation that is not confirmed', async () => {
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in' }));
        await expect(service.markNoShow(TENANT_ID, RESERVATION_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
      });

      it('flips status to no_show, records the branch default penalty, and posts it as a folio charge', async () => {
        propertyService.assertBranch.mockResolvedValueOnce({ id: BRANCH_ID, timezone: 'Africa/Lagos', noShowPolicy: { defaultPenalty: 'first_night' } });
        tx.reservation.findFirst.mockResolvedValue(
          reservation({ status: 'confirmed', confirmedRate: new Prisma.Decimal('300'), overrideRate: null, checkInDate: new Date('2026-09-01'), checkOutDate: new Date('2026-09-04'), createdBy: ACTOR_ID }),
        );
        const result = await service.markNoShow(TENANT_ID, RESERVATION_ID, ACTOR_ID);
        expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'no_show' } }));
        const createdData = (tx.noShowRecord.create.mock.calls[0] as [{ data: { penaltyType: string; penaltyAmount: Prisma.Decimal; penaltyLineItemId: string | null } }])[0].data;
        expect(createdData.penaltyType).toBe('first_night');
        expect(createdData.penaltyAmount.toFixed(2)).toBe('100.00'); // 300 / 3 nights
        // the record holds on to the line it posted — what a waiver reverses
        expect(createdData.penaltyLineItemId).toBe('li-penalty');
        expect(foliosService.postAdHocCharge).toHaveBeenCalledWith(
          tx,
          expect.anything(),
          expect.anything(),
          'penalty',
          expect.objectContaining({ toString: expect.any(Function) }),
          expect.stringContaining('No-Show'),
          ACTOR_ID,
        );
        expect(result.reservation).toBeDefined();
        expect(result.noShowRecord).toBeDefined();
      });

      it('a "none" penalty policy posts no charge, and the folio still gets a settle check (nothing owed → closes)', async () => {
        propertyService.assertBranch.mockResolvedValueOnce({ id: BRANCH_ID, timezone: 'Africa/Lagos', noShowPolicy: null });
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', confirmedRate: new Prisma.Decimal('300'), overrideRate: null, createdBy: ACTOR_ID }));
        await service.markNoShow(TENANT_ID, RESERVATION_ID, ACTOR_ID);
        expect(foliosService.postAdHocCharge).not.toHaveBeenCalled();
        expect(foliosService.settleIfFullyPaid).toHaveBeenCalledWith(tx, expect.anything(), expect.any(String), 'noShow');
      });

      it('logs a no_show_notice comms row, naming the penalty when one was applied', async () => {
        propertyService.assertBranch.mockResolvedValueOnce({ id: BRANCH_ID, timezone: 'Africa/Lagos', noShowPolicy: { defaultPenalty: 'first_night' } });
        tx.reservation.findFirst.mockResolvedValue(
          reservation({ status: 'confirmed', confirmedRate: new Prisma.Decimal('300'), overrideRate: null, checkInDate: new Date('2026-09-01'), checkOutDate: new Date('2026-09-04'), createdBy: ACTOR_ID }),
        );
        await service.markNoShow(TENANT_ID, RESERVATION_ID, ACTOR_ID);
        expect(commsLogService.logAutomatedInTx).toHaveBeenCalledWith(
          tx, TENANT_ID, BRANCH_ID,
          expect.objectContaining({ guestId: GUEST_ID, trigger: 'no_show_notice', body: expect.stringContaining('penalty') }),
        );
      });

      it('the scheduled sweep (markedBy NULL) writes NULL actors — never "" or "system", which the UUID columns reject', async () => {
        const online = reservation({ status: 'confirmed', confirmedRate: new Prisma.Decimal('300'), overrideRate: null, createdBy: null });
        await service.markNoShowInTx(tx as never, TENANT_ID, online as never, 'first_night', undefined, null);
        expect(foliosService.ensurePrimaryFolio).toHaveBeenCalledWith(tx, expect.anything(), null);
        expect((foliosService.postAdHocCharge.mock.calls[0] as unknown[])[6]).toBeNull();
        expect(foliosService.settleIfFullyPaid).toHaveBeenCalledWith(tx, expect.anything(), null, 'noShow');
        expect((tx.auditLog.create.mock.calls[0][0] as { data: { userId: unknown } }).data.userId).toBeNull();
      });
    });

    describe('waiveNoShowPenalty', () => {
      it('404s on a missing record', async () => {
        tx.noShowRecord.findFirst.mockResolvedValue(null);
        await expect(service.waiveNoShowPenalty(TENANT_ID, 'nsr-x', ACTOR_ID)).rejects.toThrow(NotFoundException);
      });

      it('is idempotent — a no-op when already waived, nothing reversed twice', async () => {
        tx.noShowRecord.findFirst.mockResolvedValue({ id: 'nsr-1', penaltyWaived: true, penaltyAmount: new Prisma.Decimal('100'), reservationId: RESERVATION_ID });
        await service.waiveNoShowPenalty(TENANT_ID, 'nsr-1', ACTOR_ID);
        expect(tx.noShowRecord.update).not.toHaveBeenCalled();
        expect(foliosService.reverseChargeInTx).not.toHaveBeenCalled();
      });

      it('reverses the penalty line it posted, with its own tax, then re-checks settlement — never a fresh charge through today’s tax rules', async () => {
        tx.noShowRecord.findFirst.mockResolvedValue({ id: 'nsr-1', penaltyWaived: false, penaltyAmount: new Prisma.Decimal('100'), reservationId: RESERVATION_ID, penaltyLineItemId: 'li-penalty' });
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'no_show' }));
        await service.waiveNoShowPenalty(TENANT_ID, 'nsr-1', ACTOR_ID);
        expect(tx.noShowRecord.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ penaltyWaived: true, waivedBy: ACTOR_ID }) }),
        );
        expect(foliosService.reverseChargeInTx).toHaveBeenCalledWith(tx, TENANT_ID, 'li-penalty', 'penalty waived', ACTOR_ID);
        expect(foliosService.postAdHocCharge).not.toHaveBeenCalled();
        expect(foliosService.settleIfFullyPaid).toHaveBeenCalledWith(tx, expect.anything(), ACTOR_ID, 'noShowWaived');
      });

      it('finds the penalty line of a no-show recorded before records linked it', async () => {
        tx.noShowRecord.findFirst.mockResolvedValue({ id: 'nsr-1', penaltyWaived: false, penaltyAmount: new Prisma.Decimal('100'), reservationId: RESERVATION_ID, penaltyLineItemId: null });
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'no_show' }));
        tx.lineItem.findFirst.mockResolvedValue({ id: 'li-old-penalty' });
        await service.waiveNoShowPenalty(TENANT_ID, 'nsr-1', ACTOR_ID);
        expect(tx.lineItem.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ folioId: 'folio-1', chargeType: 'penalty', description: { startsWith: 'No-Show Penalty' }, correctedBy: null }) }),
        );
        expect(foliosService.reverseChargeInTx).toHaveBeenCalledWith(tx, TENANT_ID, 'li-old-penalty', 'penalty waived', ACTOR_ID);
      });

      it('a zero/null penalty has nothing to reverse — just marks waived, no folio touched', async () => {
        tx.noShowRecord.findFirst.mockResolvedValue({ id: 'nsr-1', penaltyWaived: false, penaltyAmount: null, reservationId: RESERVATION_ID });
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'no_show' }));
        await service.waiveNoShowPenalty(TENANT_ID, 'nsr-1', ACTOR_ID);
        expect(foliosService.reverseChargeInTx).not.toHaveBeenCalled();
      });
    });

    describe('reinstateFromNoShow', () => {
      const dto = { checkInDate: '2026-09-10', checkOutDate: '2026-09-12' };

      it('rejects a reservation that is not a no_show', async () => {
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
        await expect(service.reinstateFromNoShow(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
      });

      it('re-checks availability and re-resolves the rate for the NEW dates, flips back to confirmed', async () => {
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'no_show' }));
        const result = await service.reinstateFromNoShow(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
        expect(tx.reservation.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'confirmed', checkInDate: expect.any(Date), checkOutDate: expect.any(Date) }) }),
        );
        expect(rateResolverService.resolveStay).toHaveBeenCalled();
        expect(result).toBeDefined();
      });

      it('rejects when the new dates have no availability', async () => {
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'no_show' }));
        tx.room.count.mockResolvedValue(0);
        await expect(service.reinstateFromNoShow(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
      });

      it('a group booking comes back on its block, at its block rate', async () => {
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'no_show', groupBlockId: 'block-1', overrideRate: new Prisma.Decimal('70') }));
        tx.groupBlock.findFirst.mockResolvedValue({ roomTypeId: TYPE_ID, arrivalDate: new Date('2026-09-10T00:00:00.000Z'), departureDate: new Date('2026-09-12T00:00:00.000Z') });
        await service.reinstateFromNoShow(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
        const data = (tx.reservation.update.mock.calls[0][0] as { data: { confirmedRate: Prisma.Decimal } }).data;
        expect(data.confirmedRate.toFixed(2)).toBe('140.00');

        tx.reservation.update.mockClear();
        tx.groupBlock.findFirst.mockResolvedValue({ roomTypeId: TYPE_ID, arrivalDate: new Date('2026-12-10T00:00:00.000Z'), departureDate: new Date('2026-12-12T00:00:00.000Z') });
        await expect(service.reinstateFromNoShow(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(/keeps to its block's nights/);
        expect(tx.reservation.update).not.toHaveBeenCalled();
      });

      it('waivePenalty: true also waives the most recent NoShowRecord for this reservation, atomically in the same transaction', async () => {
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'no_show' }));
        tx.noShowRecord.findFirst.mockResolvedValue({ id: 'nsr-1', penaltyWaived: false, penaltyAmount: new Prisma.Decimal('50'), reservationId: RESERVATION_ID });
        await service.reinstateFromNoShow(TENANT_ID, RESERVATION_ID, { ...dto, waivePenalty: true }, ACTOR_ID);
        expect(tx.noShowRecord.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ penaltyWaived: true }) }));
      });

      it('waivePenalty: false (default) leaves an existing penalty untouched', async () => {
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'no_show' }));
        await service.reinstateFromNoShow(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
        expect(tx.noShowRecord.findFirst).not.toHaveBeenCalled();
      });
    });
  });

  describe('walkReservation', () => {
    const dto = { relocationProperty: 'Sister Hotel Downtown', transportProvided: true, transportCost: 20, compensationOffered: 'One free night' };

    it('rejects a reservation that is not confirmed', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in' }));
      await expect(service.walkReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR)).rejects.toThrow(ConflictException);
    });

    it('creates a WalkRecord and sets status to "walked" — a distinct status from a plain cancellation', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await service.walkReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR);
      expect(tx.walkRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ relocationProperty: 'Sister Hotel Downtown', approvedBy: ACTOR_ID }) }),
      );
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'walked' } }));
    });

    it('no folio exists yet (the common case — no deposit-at-booking) — nothing to refund, no refund raised', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      tx.folio.findFirst.mockResolvedValue(null);
      const result = await service.walkReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR);
      expect(tx.payment.create).not.toHaveBeenCalled();
      expect(refundsService.requestInTx).not.toHaveBeenCalled();
      expect(result.refundRequested).toBe('0.00');
    });

    it('a bill holding the guest’s money raises a refund through the refund workflow — by the method they paid, never as a reversal row written into the ledger', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      tx.folio.findFirst.mockResolvedValue({ id: 'folio-1', branchId: BRANCH_ID });
      refundsService.refundable.mockResolvedValueOnce({ credit: new Prisma.Decimal('150'), available: new Prisma.Decimal('150') });
      tx.payment.findFirst.mockResolvedValue({ method: 'card' });
      const result = await service.walkReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR);
      expect(tx.payment.create).not.toHaveBeenCalled();
      expect(refundsService.requestInTx).toHaveBeenCalledWith(
        tx,
        TENANT_ID,
        expect.objectContaining({ id: 'folio-1' }),
        expect.objectContaining({ amount: 150, method: 'card', reason: expect.stringContaining('Sister Hotel Downtown') }),
        ACTOR,
      );
      expect(result.refundRequested).toBe('150.00');
    });
  });

  describe('getOverbookingExposure', () => {
    it('flags a night as overbooked once reservedCount exceeds physical capacity', async () => {
      tx.room.count.mockResolvedValue(2);
      tx.reservation.findMany.mockResolvedValue([
        { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
        { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
        { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
      ]);
      tx.overbookingConfig.findMany.mockResolvedValue([
        { roomTypeId: TYPE_ID, globalEnabled: true, maxOverbookPct: new Prisma.Decimal('100'), alertAtPct: null, validFrom: null, validTo: null },
      ]);
      const result = await service.getOverbookingExposure(TENANT_ID, BRANCH_ID, { year: 2026, month: 9 });
      const sep1 = result.roomTypes[0].nights.find((n) => n.date === '2026-09-01');
      expect(sep1?.isOverbooked).toBe(true);
      expect(sep1?.reservedCount).toBe(3);
      expect(sep1?.physicalPool).toBe(2);
    });

    it('flags a night as alerting once reservedCount crosses alertAtPct of physical capacity', async () => {
      tx.room.count.mockResolvedValue(4);
      tx.reservation.findMany.mockResolvedValue([
        { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
        { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
        { checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-02T00:00:00.000Z') },
      ]);
      tx.overbookingConfig.findMany.mockResolvedValue([
        { roomTypeId: TYPE_ID, globalEnabled: true, maxOverbookPct: new Prisma.Decimal('50'), alertAtPct: new Prisma.Decimal('70'), validFrom: null, validTo: null },
      ]);
      // physical 4, alert threshold floor(4 * 0.7) = 2 — 3 reserved crosses it, but not yet overbooked (ceiling floor(4*1.5)=6).
      const result = await service.getOverbookingExposure(TENANT_ID, BRANCH_ID, { year: 2026, month: 9 });
      const sep1 = result.roomTypes[0].nights.find((n) => n.date === '2026-09-01');
      expect(sep1?.isAlerting).toBe(true);
      expect(sep1?.isOverbooked).toBe(false);
    });
  });

  describe('getById', () => {
    it('404s on a missing reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(null);
      await expect(service.getById(TENANT_ID, RESERVATION_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('modifyReservation', () => {
    const dto = { checkInDate: '2026-09-01', checkOutDate: '2026-09-05', reason: 'Guest requested an extra night' };

    it('rejects a checked_in reservation — needs folio reconciliation, out of scope here', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in' }));
      await expect(service.modifyReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('rejects a cancelled reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'cancelled' }));
      await expect(service.modifyReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('rejects raising the party size past the room type\'s own capacity', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      tx.roomType.findFirst.mockResolvedValueOnce({ id: TYPE_ID, branchId: BRANCH_ID, name: 'Standard', baseRate: '100.00', capacity: { adults: 2, children: 0 } });
      await expect(service.modifyReservation(TENANT_ID, RESERVATION_ID, { ...dto, adults: 4, children: 9 }, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('recomputes confirmedRate = baseRate × the NEW night count', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      const result = await service.modifyReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      // 2026-09-01 -> 2026-09-05 = 4 nights, baseRate 100 -> 400
      expect(String((result as unknown as { confirmedRate: unknown }).confirmedRate)).toBe('400');
    });

    it('re-prices under the deal the stay was booked with — its company and promo code carry over', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', corporateAccountId: 'corp-1', promoCode: 'SAVE10' }));
      await service.modifyReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      expect(rateResolverService.resolveStay).toHaveBeenCalledWith(
        tx,
        TENANT_ID,
        BRANCH_ID,
        expect.objectContaining({ id: TYPE_ID }),
        expect.any(Date),
        expect.any(Date),
        expect.objectContaining({ promoCode: 'SAVE10', corporateAccountId: 'corp-1' }),
        { triggeredBy: 'modify', userId: ACTOR_ID, reservationId: RESERVATION_ID },
      );
    });

    it('re-checks availability EXCLUDING its own current hold when dates change', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await service.modifyReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      expect(tx.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { not: RESERVATION_ID } }) }),
      );
    });

    it('does NOT re-check availability for a waitlisted reservation (it holds no inventory)', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'waitlisted' }));
      await service.modifyReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      expect(tx.reservation.findMany).not.toHaveBeenCalled();
    });

    it('skips the availability check entirely when neither dates nor room type change', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await service.modifyReservation(TENANT_ID, RESERVATION_ID, { adults: 3, reason: 'One more guest' }, ACTOR_ID);
      expect(tx.reservation.findMany).not.toHaveBeenCalled();
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ adults: 3 }) }));
    });

    it('rejects checkOutDate <= checkInDate', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await expect(
        service.modifyReservation(TENANT_ID, RESERVATION_ID, { checkInDate: '2026-09-05', checkOutDate: '2026-09-01', reason: 'x' }, ACTOR_ID),
      ).rejects.toThrow(BadRequestException);
    });

    describe('a group booking', () => {
      const block = { roomTypeId: TYPE_ID, arrivalDate: new Date('2026-09-01T00:00:00.000Z'), departureDate: new Date('2026-09-04T00:00:00.000Z') };

      it('keeps its block rate on new dates — the record says what the folio will post', async () => {
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', groupBlockId: 'block-1', overrideRate: new Prisma.Decimal('70') }));
        tx.groupBlock.findFirst.mockResolvedValue(block);
        const result = await service.modifyReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID); // 4 nights, inside the block plus a shoulder night
        expect(String((result as unknown as { confirmedRate: unknown }).confirmedRate)).toBe('280'); // 70 x 4, not the public 100 x 4
        const data = (tx.reservation.update.mock.calls[0][0] as { data: { nightlyRates: Array<{ rate: string }> } }).data;
        expect(data.nightlyRates.map((n) => n.rate)).toEqual(['70.00', '70.00', '70.00', '70.00']);
      });

      it("can't be moved off its block's nights, or out of its room type", async () => {
        tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', groupBlockId: 'block-1', overrideRate: new Prisma.Decimal('70') }));
        tx.groupBlock.findFirst.mockResolvedValue(block);
        await expect(
          service.modifyReservation(TENANT_ID, RESERVATION_ID, { checkInDate: '2026-10-01', checkOutDate: '2026-10-03', reason: 'x' }, ACTOR_ID),
        ).rejects.toThrow(/keeps to its block's nights/);
        await expect(service.modifyReservation(TENANT_ID, RESERVATION_ID, { roomTypeId: 'another-type', reason: 'x' }, ACTOR_ID)).rejects.toThrow(/its block's room type/);
        expect(tx.reservation.update).not.toHaveBeenCalled();
      });
    });

    it("a manager's pinned nightly rate is what a re-dated stay is recorded at", async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', overrideRate: new Prisma.Decimal('85') }));
      const result = await service.modifyReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      expect(String((result as unknown as { confirmedRate: unknown }).confirmedRate)).toBe('340'); // 85 x 4
    });

    it('rejects when the new dates/room type have no availability', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      tx.room.count.mockResolvedValue(0);
      await expect(service.modifyReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('a field left unset keeps its current value', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', adults: 2, children: 1 }));
      await service.modifyReservation(TENANT_ID, RESERVATION_ID, { adults: 4, reason: 'x' }, ACTOR_ID);
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ adults: 4, children: 1 }) }));
    });
  });

  describe('extendStay', () => {
    const dto = { checkOutDate: '2026-09-06' };

    it('rejects a reservation that is not checked_in — modifyReservation covers pre-check-in date changes', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: ROOM_ID }));
      await expect(service.extendStay(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('rejects a checked_in reservation with no room assigned', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: null }));
      await expect(service.extendStay(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(BadRequestException);
    });

    it('rejects a new checkOutDate that does not come after the current one', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID, checkOutDate: new Date('2026-09-04T00:00:00.000Z') }));
      await expect(
        service.extendStay(TENANT_ID, RESERVATION_ID, { checkOutDate: '2026-09-04' }, ACTOR_ID),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.extendStay(TENANT_ID, RESERVATION_ID, { checkOutDate: '2026-09-01' }, ACTOR_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when the room type has no pool availability for the extension window', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      tx.room.count.mockResolvedValue(0);
      await expect(service.extendStay(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('checks pool availability scoped to just the extension nights, excluding its own hold', async () => {
      tx.reservation.findFirst.mockResolvedValue(
        reservation({ status: 'checked_in', roomId: ROOM_ID, checkOutDate: new Date('2026-09-04T00:00:00.000Z') }),
      );
      await service.extendStay(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      expect(tx.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { not: RESERVATION_ID } }) }),
      );
    });

    it('rejects when the specific assigned room is blocked for part of the extension', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      tx.roomBlock.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(service.extendStay(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('re-resolves the rate over check-in → NEW check-out and rewrites confirmedRate/ratePlanId', async () => {
      tx.reservation.findFirst.mockResolvedValue(
        reservation({ status: 'checked_in', roomId: ROOM_ID, checkInDate: new Date('2026-09-01T00:00:00.000Z'), checkOutDate: new Date('2026-09-04T00:00:00.000Z') }),
      );
      const result = await service.extendStay(TENANT_ID, RESERVATION_ID, { checkOutDate: '2026-09-06' }, ACTOR_ID);
      expect(rateResolverService.resolveStay).toHaveBeenCalledWith(
        tx,
        TENANT_ID,
        BRANCH_ID,
        expect.objectContaining({ id: TYPE_ID }),
        new Date('2026-09-01T00:00:00.000Z'),
        new Date('2026-09-06T00:00:00.000Z'),
        expect.objectContaining({ occupancy: expect.any(Object) }),
        { triggeredBy: 'extend_stay', userId: ACTOR_ID, reservationId: RESERVATION_ID },
      );
      // 2026-09-01 -> 2026-09-06 = 5 nights, baseRate 100 -> 500
      expect(String((result as unknown as { confirmedRate: unknown }).confirmedRate)).toBe('500');
      expect(tx.reservation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ checkOutDate: new Date('2026-09-06T00:00:00.000Z') }) }),
      );
    });

    it('writes an audit log and an automated stay_extended comms entry', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.extendStay(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      expect(tx.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'reservation.extended' }) }),
      );
      expect(commsLogService.logAutomatedInTx).toHaveBeenCalledWith(
        tx,
        TENANT_ID,
        BRANCH_ID,
        expect.objectContaining({ reservationId: RESERVATION_ID, trigger: 'stay_extended' }),
      );
    });
  });

  describe('moveRoom — Room Move / Upgrade', () => {
    const SUITE_ID = '66666666-6666-4666-8666-666666666666';
    const NEW_ROOM_ID = '99999999-9999-4999-8999-999999999999';
    const DAY = 86_400_000;
    // The stay spans today in Lagos, whatever today is: in yesterday, out the day after tomorrow — 3 nights at 100.
    const today = new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })}T00:00:00.000Z`);
    const yesterday = new Date(today.getTime() - DAY);
    const inHouse = (overrides: Record<string, unknown> = {}) =>
      reservation({
        status: 'checked_in',
        roomId: ROOM_ID,
        checkInDate: yesterday,
        checkOutDate: new Date(today.getTime() + 2 * DAY),
        confirmedRate: new Prisma.Decimal('300'),
        overrideRate: null,
        ...overrides,
      });
    const newRoom = (overrides: Record<string, unknown> = {}) => ({
      id: NEW_ROOM_ID,
      number: '305',
      branchId: BRANCH_ID,
      roomTypeId: TYPE_ID,
      occupancyStatus: 'vacant',
      heldStatus: null,
      cleanlinessStatus: 'clean',
      deletedAt: null,
      ...overrides,
    });

    beforeEach(() => {
      Object.assign(tx.lineItem, { findMany: jest.fn().mockResolvedValue([{ serviceDate: yesterday }]) });
      tx.roomType.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === SUITE_ID
            ? { id: SUITE_ID, branchId: BRANCH_ID, name: 'Suite', baseRate: '180.00', capacity: { adults: 4, children: 2 } }
            : { id: TYPE_ID, branchId: BRANCH_ID, name: 'Standard', baseRate: '100.00', capacity: { adults: 10, children: 10 } },
        ),
      );
      // The new type's nights left: tonight and tomorrow at 180.
      rateResolverService.resolveStay.mockImplementation((_tx: unknown, _t: string, _b: string, roomType: { baseRate: string }, from: Date, to: Date) => {
        const perNight = [];
        for (let night = new Date(from); night < to; night = new Date(night.getTime() + DAY)) {
          perNight.push({ date: night.toISOString().slice(0, 10), finalRate: new Prisma.Decimal(roomType.baseRate) });
        }
        const subtotal = perNight.reduce((sum, n) => sum.plus(n.finalRate), new Prisma.Decimal(0));
        return Promise.resolve({ subtotal, perNight, ratePlanId: null });
      });
    });

    it('only an in-house guest changes rooms', async () => {
      tx.reservation.findFirst.mockResolvedValue(inHouse({ status: 'confirmed', roomId: null }));
      await expect(service.moveRoom(TENANT_ID, RESERVATION_ID, { roomId: NEW_ROOM_ID, reason: 'x', chargeNewRate: false }, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('refuses the room they are already in, and a room someone is in', async () => {
      tx.reservation.findFirst.mockResolvedValue(inHouse());
      await expect(service.moveRoom(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID, reason: 'x', chargeNewRate: false }, ACTOR_ID)).rejects.toThrow(BadRequestException);
      tx.room.findFirst.mockResolvedValue(newRoom({ occupancyStatus: 'occupied' }));
      await expect(service.moveRoom(TENANT_ID, RESERVATION_ID, { roomId: NEW_ROOM_ID, reason: 'x', chargeNewRate: false }, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('same type: the guest moves, the rate is untouched, the old room goes dirty with a task', async () => {
      tx.reservation.findFirst.mockResolvedValue(inHouse());
      tx.room.findFirst.mockResolvedValue(newRoom());
      await service.moveRoom(TENANT_ID, RESERVATION_ID, { roomId: NEW_ROOM_ID, reason: 'AC failed', chargeNewRate: false }, ACTOR_ID);
      expect(tx.reservation.update.mock.calls[0][0].data).toEqual({ roomId: NEW_ROOM_ID, roomTypeId: TYPE_ID });
      expect(roomsService.applyReservationOccupancy).toHaveBeenCalledWith(tx, TENANT_ID, ROOM_ID, { occupancyStatus: 'vacant', cleanlinessStatus: 'dirty' }, ACTOR_ID);
      expect(roomsService.applyReservationOccupancy).toHaveBeenCalledWith(tx, TENANT_ID, NEW_ROOM_ID, { occupancyStatus: 'occupied' }, ACTOR_ID);
      expect(housekeepingService.createTaskInTx).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, expect.objectContaining({ roomId: ROOM_ID, triggerEvent: 'room_move' }));
      expect(housekeepingService.supersedeStayoverTasksInTx).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, ROOM_ID, expect.stringContaining('moved'), ACTOR_ID);
    });

    it('bills any past night not yet on the bill at the old rate before anything changes', async () => {
      tx.reservation.findFirst.mockResolvedValue(inHouse());
      tx.room.findFirst.mockResolvedValue(newRoom());
      await service.moveRoom(TENANT_ID, RESERVATION_ID, { roomId: NEW_ROOM_ID, reason: 'AC failed', chargeNewRate: false }, ACTOR_ID);
      expect(foliosService.backfillRoomCharges).toHaveBeenCalledWith(tx, expect.objectContaining({ roomId: ROOM_ID, overrideRate: null }), expect.anything(), today, 'Room move', ACTOR_ID);
      expect(foliosService.backfillRoomCharges.mock.invocationCallOrder[0]).toBeLessThan(tx.reservation.update.mock.invocationCallOrder[0]);
    });

    it('a complimentary upgrade pins the booked nightly rate, so an extension later cannot re-price it', async () => {
      tx.reservation.findFirst.mockResolvedValue(inHouse());
      tx.room.findFirst.mockResolvedValue(newRoom({ roomTypeId: SUITE_ID }));
      await service.moveRoom(TENANT_ID, RESERVATION_ID, { roomId: NEW_ROOM_ID, reason: 'Loyal guest', chargeNewRate: false }, ACTOR_ID);
      const data = tx.reservation.update.mock.calls[0][0].data;
      expect(data).toMatchObject({ roomId: NEW_ROOM_ID, roomTypeId: SUITE_ID });
      expect(String(data.overrideRate)).toBe('100');
      expect(data.confirmedRate).toBeUndefined();
    });

    it('a chargeable upgrade prices the nights left at the new type and keeps the billed night as it was', async () => {
      tx.reservation.findFirst.mockResolvedValue(inHouse());
      tx.room.findFirst.mockResolvedValue(newRoom({ roomTypeId: SUITE_ID }));
      await service.moveRoom(TENANT_ID, RESERVATION_ID, { roomId: NEW_ROOM_ID, reason: 'Asked for a suite', chargeNewRate: true }, ACTOR_ID);
      const data = tx.reservation.update.mock.calls[0][0].data;
      expect(String(data.overrideRate)).toBe('180');
      // Yesterday at 100 (billed) + tonight and tomorrow at 180.
      expect(String(data.confirmedRate)).toBe('460');
      expect(data.overrideReason).toMatch(/^Room move to Suite — Asked for a suite/);
    });

    it('a different type needs a room of it to spare for the nights left', async () => {
      tx.reservation.findFirst.mockResolvedValue(inHouse());
      tx.room.findFirst.mockResolvedValue(newRoom({ roomTypeId: SUITE_ID }));
      tx.room.count.mockResolvedValue(0);
      await expect(service.moveRoom(TENANT_ID, RESERVATION_ID, { roomId: NEW_ROOM_ID, reason: 'x', chargeNewRate: false }, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('quotes both prices for the nights left without writing anything', async () => {
      tx.reservation.findFirst.mockResolvedValue(inHouse());
      const quote = await service.roomMoveQuote(TENANT_ID, RESERVATION_ID, SUITE_ID);
      expect(quote).toMatchObject({ nightsLeft: 2, currentNightly: '100.00', keepTotal: '200.00', newNightly: '180.00', newTotal: '360.00', tonightAlreadyBilled: false });
      expect(rateResolverService.resolveStay).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, expect.objectContaining({ id: SUITE_ID }), today, expect.any(Date), expect.objectContaining({ occupancy: expect.any(Object) }), expect.objectContaining({ persistAudit: false }));
      expect(tx.reservation.update).not.toHaveBeenCalled();
    });
  });

  describe('checkInGroup — group check-in', () => {
    const BLOCK_ID = '12121212-1212-4121-8121-121212121212';
    const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const R2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const ROOM_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const ROOM_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const dto = { assignments: [{ reservationId: R1, roomId: ROOM_A }, { reservationId: R2, roomId: ROOM_B }] };

    beforeEach(() => {
      tx.groupBlock.findFirst.mockResolvedValue({ id: BLOCK_ID, branchId: BRANCH_ID, name: 'Shell Conference', contactName: 'Kemi (Shell travel)' });
      tx.reservation.findMany.mockImplementation(({ where }: { where: { id?: { in: string[] } } }) =>
        Promise.resolve(where.id?.in ? where.id.in.map((id) => ({ id })) : []),
      );
      Object.assign(tx.reservation, { updateMany: jest.fn().mockResolvedValue({ count: 2 }) });
      Object.assign(foliosService, { createAdditionalFolioInTx: jest.fn().mockResolvedValue({ id: 'master-folio' }) });
      tx.reservation.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(reservation({ id: where.id, status: 'confirmed', roomId: null, groupBlockId: BLOCK_ID })),
      );
      tx.room.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id, number: where.id === ROOM_A ? '201' : '202', branchId: BRANCH_ID, roomTypeId: TYPE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null }),
      );
      tx.reservation.update.mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Promise.resolve(reservation({ id: where.id, ...data, guest: { id: GUEST_ID, name: 'Delegate' }, room: { number: data.roomId === ROOM_A ? '201' : '202' } })),
      );
    });

    it('refuses one room for two guests, and a guest listed twice', async () => {
      await expect(service.checkInGroup(TENANT_ID, BLOCK_ID, { assignments: [{ reservationId: R1, roomId: ROOM_A }, { reservationId: R2, roomId: ROOM_A }] }, ACTOR_ID)).rejects.toThrow(/same room/);
      await expect(service.checkInGroup(TENANT_ID, BLOCK_ID, { assignments: [{ reservationId: R1, roomId: ROOM_A }, { reservationId: R1, roomId: ROOM_B }] }, ACTOR_ID)).rejects.toThrow(/listed twice/);
    });

    it("refuses a reservation that isn't in the group", async () => {
      tx.reservation.findMany.mockResolvedValueOnce([{ id: R1 }]);
      await expect(service.checkInGroup(TENANT_ID, BLOCK_ID, dto, ACTOR_ID)).rejects.toThrow(/not in this group/);
      expect(tx.reservation.update).not.toHaveBeenCalled();
    });

    it('checks every guest into their room', async () => {
      const result = await service.checkInGroup(TENANT_ID, BLOCK_ID, dto, ACTOR_ID);
      expect(result.checkedIn).toHaveLength(2);
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: R1 }, data: expect.objectContaining({ status: 'checked_in', roomId: ROOM_A }) }));
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: R2 }, data: expect.objectContaining({ status: 'checked_in', roomId: ROOM_B }) }));
      expect(result.masterFolioId).toBeNull();
    });

    it("a master bill opens on the lead's stay, paid by the organiser, and every guest's room nights go to it — before any night is posted", async () => {
      const result = await service.checkInGroup(TENANT_ID, BLOCK_ID, { ...dto, masterBill: { leadReservationId: R1 } }, ACTOR_ID);
      expect((foliosService as unknown as { createAdditionalFolioInTx: jest.Mock }).createAdditionalFolioInTx).toHaveBeenCalledWith(
        tx,
        TENANT_ID,
        R1,
        { label: 'Group — Shell Conference', payerName: 'Kemi (Shell travel)' },
        ACTOR_ID,
      );
      const updateMany = (tx.reservation as unknown as { updateMany: jest.Mock }).updateMany;
      expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: [R1, R2] } }, data: { billToFolioId: 'master-folio' } });
      expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(foliosService.postRoomChargeForDate.mock.invocationCallOrder[0]);
      expect(result.masterFolioId).toBe('master-folio');
    });
  });

  describe('checkIn — Manual Room Override', () => {
    const SUITE_ID = '66666666-6666-4666-8666-666666666666';
    const suiteRoom = { id: ROOM_ID, number: '401', branchId: BRANCH_ID, roomTypeId: SUITE_ID, occupancyStatus: 'vacant', heldStatus: null, deletedAt: null };

    beforeEach(() => {
      tx.roomType.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === SUITE_ID ? { id: SUITE_ID, branchId: BRANCH_ID, name: 'Suite', baseRate: '180.00' } : { id: TYPE_ID, branchId: BRANCH_ID, name: 'Standard', baseRate: '100.00' }),
      );
    });

    it('a room of another type needs the reason', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null, confirmedRate: new Prisma.Decimal('300') }));
      tx.room.findFirst.mockResolvedValue(suiteRoom);
      await expect(service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID }, ACTOR_ID)).rejects.toThrow(/Room 401 is a Suite and this booking is for a Standard/);
    });

    it('with one, the stay becomes that type at the booked rate, pinned, and the reason is on record', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', roomId: null, confirmedRate: new Prisma.Decimal('300'), overrideRate: null }));
      tx.room.findFirst.mockResolvedValue(suiteRoom);
      await service.checkIn(TENANT_ID, RESERVATION_ID, { roomId: ROOM_ID, overrideReason: 'Standards all being cleaned' }, ACTOR_ID);
      const data = tx.reservation.update.mock.calls[0][0].data;
      expect(data).toMatchObject({ status: 'checked_in', roomId: ROOM_ID, roomTypeId: SUITE_ID });
      expect(String(data.overrideRate)).toBe('100');
      const entry = tx.auditLog.create.mock.calls.map((c: [{ data: { action: string; after: Record<string, unknown> } }]) => c[0].data).find((d: { action: string }) => d.action === 'reservation.checked_in');
      expect(entry?.after).toMatchObject({ overrideReason: 'Standards all being cleaned', bookedRoomTypeId: TYPE_ID, roomTypeId: SUITE_ID });
    });
  });

  describe('extendStay — a pinned nightly rate carries on', () => {
    it('the stay total grows by the pinned rate for the extra nights, not a re-price of the whole stay', async () => {
      tx.reservation.findFirst.mockResolvedValue(
        reservation({ status: 'checked_in', roomId: ROOM_ID, confirmedRate: new Prisma.Decimal('460'), overrideRate: new Prisma.Decimal('180'), checkOutDate: new Date('2026-09-04T00:00:00.000Z') }),
      );
      // The first night was billed at 100 before the rate was pinned; the other two will be at 180 (= 460).
      tx.lineItem.findMany.mockResolvedValue([{ serviceDate: new Date('2026-09-01T00:00:00.000Z'), amount: new Prisma.Decimal(100), correctedBy: null }]);
      const result = await service.extendStay(TENANT_ID, RESERVATION_ID, { checkOutDate: '2026-09-06' }, ACTOR_ID);
      expect(String((result as unknown as { confirmedRate: unknown }).confirmedRate)).toBe('820');
      const { data } = tx.reservation.update.mock.calls[0][0] as { data: { nightlyRates: Array<{ rate: string }> } };
      expect(data.nightlyRates.map((n) => n.rate)).toEqual(['100.00', '180.00', '180.00', '180.00', '180.00']);
    });
  });

  describe('setRateOverride', () => {
    const dto = { overrideRate: 25000, reason: 'Service recovery — delayed check-in' };

    it('allows a confirmed reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await expect(service.setRateOverride(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).resolves.toBeDefined();
      expect(tx.reservation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ overrideRate: 25000, overrideReason: dto.reason }) }),
      );
    });

    it('re-states the stay total at the new rate — every night, before arrival', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await service.setRateOverride(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      const { data } = tx.reservation.update.mock.calls[0][0] as { data: { confirmedRate: { toFixed: (n: number) => string }; nightlyRates: Array<{ date: string; rate: string }> } };
      // 1–4 September: three nights at 25,000.
      expect(data.confirmedRate.toFixed(2)).toBe('75000.00');
      expect(data.nightlyRates).toEqual([
        { date: '2026-09-01', rate: '25000.00' },
        { date: '2026-09-02', rate: '25000.00' },
        { date: '2026-09-03', rate: '25000.00' },
      ]);
    });

    it('keeps the nights already billed at what they were billed at (net of a correction), the rest at the new rate', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in' }));
      tx.lineItem.findMany.mockResolvedValue([
        { serviceDate: new Date('2026-09-01T00:00:00.000Z'), amount: new Prisma.Decimal(30000), correctedBy: null },
        { serviceDate: new Date('2026-09-02T00:00:00.000Z'), amount: new Prisma.Decimal(30000), correctedBy: { amount: new Prisma.Decimal(-30000), isVoid: false, deletedAt: null } },
      ]);
      await service.setRateOverride(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      const { data } = tx.reservation.update.mock.calls[0][0] as { data: { confirmedRate: { toFixed: (n: number) => string }; nightlyRates: Array<{ date: string; rate: string }> } };
      expect(data.nightlyRates.map((n) => n.rate)).toEqual(['30000.00', '0.00', '25000.00']);
      expect(data.confirmedRate.toFixed(2)).toBe('55000.00');
    });

    it('allows a checked_in reservation too — a manager can override a live folio, not just pre-arrival', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in' }));
      await expect(service.setRateOverride(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).resolves.toBeDefined();
    });

    it.each(['checked_out', 'cancelled', 'no_show', 'walked', 'waitlisted'])('rejects a %s reservation — nothing left to charge for (or not confirmed yet)', async (status) => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status }));
      await expect(service.setRateOverride(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('writes an audit log naming the previous and new override rate', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', overrideRate: { toFixed: () => '20000.00' } }));
      await service.setRateOverride(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      expect(tx.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'reservation.rate_overridden',
            after: expect.objectContaining({ previousOverrideRate: '20000.00', overrideRate: '25000.00', reason: dto.reason }),
          }),
        }),
      );
    });

    it('a reservation with no prior override records previousOverrideRate as null', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed', overrideRate: null }));
      await service.setRateOverride(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      expect(tx.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ after: expect.objectContaining({ previousOverrideRate: null }) }) }),
      );
    });
  });

  describe('promoteFromWaitlist', () => {
    it('rejects a non-waitlisted reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await expect(service.promoteFromWaitlist(TENANT_ID, RESERVATION_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('promotes to confirmed when a room has opened up', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'waitlisted' }));
      tx.room.count.mockResolvedValue(3);
      await service.promoteFromWaitlist(TENANT_ID, RESERVATION_ID, ACTOR_ID);
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'confirmed' }) }));
    });

    it('stays waitlisted (throws) when nothing has opened up yet', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'waitlisted' }));
      tx.room.count.mockResolvedValue(0);
      await expect(service.promoteFromWaitlist(TENANT_ID, RESERVATION_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
      expect(tx.reservation.update).not.toHaveBeenCalled();
    });
  });

  describe('listReservations', () => {
    it('filters by status when given', async () => {
      await service.listReservations(TENANT_ID, BRANCH_ID, { status: 'waitlisted' });
      expect(tx.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'waitlisted' }) }),
      );
    });

    it('searches confirmation number OR guest name, case-insensitively', async () => {
      await service.listReservations(TENANT_ID, BRANCH_ID, { search: 'John' });
      expect(tx.reservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { confirmationNumber: { contains: 'John', mode: 'insensitive' } },
              { guest: { name: { contains: 'John', mode: 'insensitive' } } },
            ],
          }),
        }),
      );
    });

    it('returns a page: 100 unless asked, from the offset given', async () => {
      await service.listReservations(TENANT_ID, BRANCH_ID, {});
      expect(tx.reservation.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100, skip: 0 }));
      await service.listReservations(TENANT_ID, BRANCH_ID, { limit: 50, offset: 100 });
      expect(tx.reservation.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 50, skip: 100 }));
    });

    it('counts everything the same filters match — what the page is a page of', async () => {
      tx.reservation.count.mockResolvedValueOnce(342);
      await expect(service.countReservations(TENANT_ID, BRANCH_ID, { status: 'confirmed', search: 'John' })).resolves.toEqual({ count: 342 });
      expect(tx.reservation.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ branchId: BRANCH_ID, deletedAt: null, status: 'confirmed', OR: expect.any(Array) }),
      });
    });
  });

  describe('getAvailabilityCalendar', () => {
    it('returns per-night availability for every active room type at the branch', async () => {
      tx.roomType.findMany.mockResolvedValue([
        { id: TYPE_ID, name: 'Standard' },
        { id: 'other-type', name: 'Deluxe' },
      ]);
      tx.room.count.mockResolvedValue(5);
      const result = await service.getAvailabilityCalendar(TENANT_ID, BRANCH_ID, { year: 2026, month: 6 });
      expect(result.roomTypes).toHaveLength(2);
      expect(result.roomTypes[0]).toEqual(expect.objectContaining({ roomTypeId: TYPE_ID, roomTypeName: 'Standard' }));
      // June 2026 has 30 nights
      expect(result.roomTypes[0].nights).toHaveLength(30);
    });
  });
});
