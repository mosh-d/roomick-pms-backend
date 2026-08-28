import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { RoomsService } from '../property/rooms.service';
import { GuestsService } from '../guests/guests.service';
import { FoliosService } from '../folios/folios.service';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { ReservationsService } from './reservations.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const TYPE_ID = '88888888-8888-4888-8888-888888888888';
const ROOM_ID = '77777777-7777-4777-8777-777777777777';
const GUEST_ID = '55555555-5555-4555-8555-555555555555';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';

function reservation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RESERVATION_ID,
    branchId: BRANCH_ID,
    roomTypeId: TYPE_ID,
    roomId: null,
    status: 'confirmed',
    checkInDate: new Date('2026-09-01T00:00:00.000Z'),
    checkOutDate: new Date('2026-09-04T00:00:00.000Z'),
    adults: 2,
    children: 0,
    confirmedRate: { toFixed: () => '300.00' },
    deletedAt: null,
    ...overrides,
  };
}

function makeTx() {
  return {
    room: { count: jest.fn().mockResolvedValue(5), findFirst: jest.fn() },
    roomType: {
      findFirst: jest.fn().mockResolvedValue({ id: TYPE_ID, branchId: BRANCH_ID, baseRate: '100.00' }),
      findMany: jest.fn().mockResolvedValue([{ id: TYPE_ID, name: 'Standard' }]),
    },
    roomBlock: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    reservation: {
      findMany: jest.fn().mockResolvedValue([]),
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
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
}

describe('ReservationsService', () => {
  let service: ReservationsService;
  let tx: ReturnType<typeof makeTx>;
  let propertyService: { assertBranch: jest.Mock };
  let roomsService: { applyReservationOccupancy: jest.Mock };
  let guestsService: { findOrCreateGuestInTx: jest.Mock };
  let foliosService: {
    ensurePrimaryFolio: jest.Mock;
    postRoomChargeForDate: jest.Mock;
    backfillRoomCharges: jest.Mock;
    settleIfFullyPaid: jest.Mock;
  };
  let housekeepingService: { createTaskInTx: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    propertyService = { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, timezone: 'Africa/Lagos' }) };
    roomsService = { applyReservationOccupancy: jest.fn().mockResolvedValue({}) };
    guestsService = { findOrCreateGuestInTx: jest.fn().mockResolvedValue({ id: GUEST_ID, name: 'John Doe' }) };
    foliosService = {
      ensurePrimaryFolio: jest.fn().mockResolvedValue({ id: 'folio-1', status: 'open' }),
      postRoomChargeForDate: jest.fn().mockResolvedValue({ id: 'li-room' }),
      backfillRoomCharges: jest.fn().mockResolvedValue(0),
      settleIfFullyPaid: jest.fn().mockResolvedValue(true),
    };
    housekeepingService = { createTaskInTx: jest.fn().mockResolvedValue({ id: 'task-1' }) };

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

    it('a held room reduces the pool for every night, not just some (heldStatus is a static flag, not date-scoped)', async () => {
      tx.room.count.mockResolvedValue(4); // count() itself already excludes heldStatus rooms — pool is pre-reduced
      const result = await service.getAvailability(TENANT_ID, BRANCH_ID, { from: '2026-09-01', to: '2026-09-03', roomTypeId: TYPE_ID });
      expect(tx.room.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ heldStatus: null }) }));
      expect(result.every((n) => n.available === 4)).toBe(true);
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
  });

  describe('createReservation', () => {
    const dto = { guestId: GUEST_ID, roomTypeId: TYPE_ID, checkInDate: '2026-09-01', checkOutDate: '2026-09-04', adults: 2 };

    it('sets confirmedRate = baseRate × nights as a Decimal', async () => {
      const result = await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(tx.reservation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ confirmedRate: expect.objectContaining({ toString: expect.any(Function) }) }) }),
      );
      expect(String((result as unknown as { confirmedRate: unknown }).confirmedRate)).toBe('300'); // 100 × 3 nights
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

    it('retries confirmation-number generation on a PREDICTED collision (findUnique), not throw', async () => {
      tx.reservation.findUnique
        .mockResolvedValueOnce({ id: 'clash' }) // first candidate taken
        .mockResolvedValueOnce(null); // second candidate free
      await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(tx.reservation.create).toHaveBeenCalled();
    });

    /**
     * confirmationNumber used to be a bare global `@unique`, checked with a
     * plain `findUnique({ where: { confirmationNumber } })`. Under RLS that
     * check is blind to every OTHER tenant's rows — on a shared DB it would
     * report a candidate as free when it was really already claimed by an
     * unrelated tenant, and the real insert would then collide every time
     * (found live against Sope Hotel's data). The fix scopes the constraint
     * itself to `(tenantId, confirmationNumber)`; this asserts the
     * generator's own collision probe was updated to match — using the
     * composite key, not the bare column, and keyed to THIS tenant.
     */
    it('checks confirmation-number collisions scoped to this tenant, not globally', async () => {
      await service.createReservation(TENANT_ID, BRANCH_ID, dto, ACTOR_ID);
      expect(tx.reservation.findUnique).toHaveBeenCalledWith({
        where: { tenantId_confirmationNumber: { tenantId: TENANT_ID, confirmationNumber: expect.any(String) } },
      });
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
  });

  describe('walkIn', () => {
    const dto = { guestId: GUEST_ID, roomTypeId: TYPE_ID, roomId: ROOM_ID, checkOutDate: '2026-09-04', adults: 2 };

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
  });

  describe('checkOut', () => {
    it('rejects a non-checked_in reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await expect(service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('happy path marks the room vacant + dirty in one call', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR_ID);
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
      await expect(service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR_ID)).resolves.toBeDefined();
      expect(roomsService.applyReservationOccupancy).toHaveBeenCalled(); // room released regardless
    });

    it('settles the folio when it is fully paid', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR_ID);
      expect(foliosService.settleIfFullyPaid).toHaveBeenCalled();
    });

    // Task Board reflects a checked-out room automatically — nobody has to remember to flag it.
    it('creates a housekeeping task for the room, traceable back to this reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR_ID);
      expect(housekeepingService.createTaskInTx).toHaveBeenCalledWith(
        tx, TENANT_ID, BRANCH_ID,
        expect.objectContaining({ roomId: ROOM_ID, triggerEvent: 'checkout', triggeredByReservationId: RESERVATION_ID }),
      );
    });

    // Safety net: a guest leaving before the night audit next runs would
    // otherwise depart with un-posted nights.
    it('backfills any elapsed-but-unposted night before settling', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in', roomId: ROOM_ID }));
      await service.checkOut(TENANT_ID, RESERVATION_ID, ACTOR_ID);
      expect(foliosService.backfillRoomCharges).toHaveBeenCalledWith(
        tx, expect.anything(), expect.anything(), expect.any(Date), 'Check-out', ACTOR_ID,
      );
      const backfillOrder = foliosService.backfillRoomCharges.mock.invocationCallOrder[0];
      const settleOrder = foliosService.settleIfFullyPaid.mock.invocationCallOrder[0];
      expect(backfillOrder).toBeLessThan(settleOrder);
    });
  });

  describe('cancel', () => {
    it('allowed from confirmed', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await service.cancel(TENANT_ID, RESERVATION_ID, {}, ACTOR_ID);
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'cancelled' } }));
    });

    it('rejected from checked_in', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'checked_in' }));
      await expect(service.cancel(TENANT_ID, RESERVATION_ID, {}, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('rejected when already cancelled', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'cancelled' }));
      await expect(service.cancel(TENANT_ID, RESERVATION_ID, {}, ACTOR_ID)).rejects.toThrow(ConflictException);
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

    it('recomputes confirmedRate = baseRate × the NEW night count', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      const result = await service.modifyReservation(TENANT_ID, RESERVATION_ID, dto, ACTOR_ID);
      // 2026-09-01 -> 2026-09-05 = 4 nights, baseRate 100 -> 400
      expect(String((result as unknown as { confirmedRate: unknown }).confirmedRate)).toBe('400');
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

  describe('promoteFromWaitlist', () => {
    it('rejects a non-waitlisted reservation', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'confirmed' }));
      await expect(service.promoteFromWaitlist(TENANT_ID, RESERVATION_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('promotes to confirmed when a room has opened up', async () => {
      tx.reservation.findFirst.mockResolvedValue(reservation({ status: 'waitlisted' }));
      tx.room.count.mockResolvedValue(3);
      await service.promoteFromWaitlist(TENANT_ID, RESERVATION_ID, ACTOR_ID);
      expect(tx.reservation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'confirmed' } }));
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

    it('caps results at 100', async () => {
      await service.listReservations(TENANT_ID, BRANCH_ID, {});
      expect(tx.reservation.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
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
