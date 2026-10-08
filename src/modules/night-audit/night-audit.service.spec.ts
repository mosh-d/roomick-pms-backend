import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { FoliosService } from '../folios/folios.service';
import { ReservationsService } from '../reservations/reservations.service';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { NightAuditService } from './night-audit.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const AUDIT_DATE = '2026-09-02';

function reservation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'res-1',
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    guestId: 'guest-1',
    createdBy: ACTOR_ID,
    confirmationNumber: 'RES-1',
    confirmedRate: new Prisma.Decimal('300'),
    overrideRate: null,
    checkInDate: new Date('2026-09-01T00:00:00.000Z'),
    checkOutDate: new Date('2026-09-04T00:00:00.000Z'),
    roomType: { name: 'Deluxe Room' },
    guest: { name: 'John Doe' },
    ...overrides,
  };
}

function makeTx() {
  return {
    branch: { findFirst: jest.fn().mockResolvedValue({ id: BRANCH_ID, timezone: 'Africa/Lagos', noShowPolicy: null }), findMany: jest.fn().mockResolvedValue([]) },
    nightAuditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: BigInt(1) }),
      update: jest.fn().mockResolvedValue({ id: BigInt(1) }),
    },
    reservation: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    folio: { findMany: jest.fn().mockResolvedValue([]) },
    maintenanceOrder: { count: jest.fn().mockResolvedValue(0) },
    shift: { findMany: jest.fn().mockResolvedValue([]) },
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
}

describe('NightAuditService', () => {
  let service: NightAuditService;
  let tx: ReturnType<typeof makeTx>;
  let foliosService: { ensurePrimaryFolio: jest.Mock; postRoomChargeForDate: jest.Mock };
  let reservationsService: { markNoShowInTx: jest.Mock };

  beforeEach(async () => {
    tx = makeTx();
    foliosService = {
      ensurePrimaryFolio: jest.fn().mockResolvedValue({ id: 'folio-1' }),
      postRoomChargeForDate: jest.fn().mockResolvedValue({ amount: new Prisma.Decimal('100'), taxAmount: new Prisma.Decimal('7.5') }),
    };
    reservationsService = { markNoShowInTx: jest.fn().mockResolvedValue({ reservation: {}, noShowRecord: {} }) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        NightAuditService,
        {
          provide: PrismaService,
          useValue: {
            withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)),
            tenant: { findMany: jest.fn().mockResolvedValue([]) },
          },
        },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, timezone: 'Africa/Lagos' }) } },
        { provide: FoliosService, useValue: foliosService },
        { provide: ReservationsService, useValue: reservationsService },
        { provide: HousekeepingService, useValue: { ensureStayoverTaskInTx: jest.fn().mockResolvedValue(true) } },
      ],
    }).compile();
    service = moduleRef.get(NightAuditService);
  });

  describe('runAudit', () => {
    it('refuses a night that hasn’t ended — today, or any date in the future', async () => {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
      await expect(service.runAudit(TENANT_ID, BRANCH_ID, today, ACTOR_ID)).rejects.toThrow(/hasn’t ended yet/);
      const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
      await expect(service.runAudit(TENANT_ID, BRANCH_ID, tomorrow, ACTOR_ID)).rejects.toThrow(/hasn’t ended yet/);
      expect(tx.nightAuditLog.create).not.toHaveBeenCalled();
      expect(foliosService.postRoomChargeForDate).not.toHaveBeenCalled();
      expect(reservationsService.markNoShowInTx).not.toHaveBeenCalled();
    });

    it('closes each stay inside its own savepoint, rolling back only the one that failed', async () => {
      tx.reservation.findMany.mockResolvedValueOnce([reservation({ id: 'bad' }), reservation({ id: 'good' })]).mockResolvedValueOnce([]);
      foliosService.postRoomChargeForDate
        .mockRejectedValueOnce(new Error('folio is settled'))
        .mockResolvedValueOnce({ amount: new Prisma.Decimal('100'), taxAmount: new Prisma.Decimal('0') });
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      const calls = tx.$executeRawUnsafe.mock.calls.map((call: unknown[]) => call[0]);
      expect(calls).toEqual(['SAVEPOINT night_audit_stay', 'ROLLBACK TO SAVEPOINT night_audit_stay', 'SAVEPOINT night_audit_stay', 'RELEASE SAVEPOINT night_audit_stay']);
    });

    it('refuses a second run for the same branch and date', async () => {
      tx.nightAuditLog.findFirst.mockResolvedValue({ id: BigInt(1) });
      await expect(service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID)).rejects.toThrow(ConflictException);
      expect(tx.nightAuditLog.create).not.toHaveBeenCalled();
    });

    it('posts one night per in-house reservation and totals the amount incl. tax', async () => {
      tx.reservation.findMany.mockResolvedValueOnce([reservation(), reservation({ id: 'res-2' })]).mockResolvedValueOnce([]);
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.chargesPosted).toBe(2);
      expect(result.foliosProcessed).toBe(2);
      expect(result.totalAmountPosted).toBe('215.00'); // 2 x (100 + 7.5)
      expect(result.status).toBe('completed');
    });

    it('bills everyone checked in that night — whatever their booked departure date', async () => {
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      const where = (tx.reservation.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
      expect(where).toMatchObject({ status: 'checked_in', checkInDate: { lte: new Date('2026-09-02T00:00:00.000Z') } });
      expect(where).not.toHaveProperty('checkOutDate');
    });

    it('charges a guest still in the room after their departure date, and labels the night an overstay', async () => {
      const overstayer = reservation({ id: 'stayed-on', checkInDate: new Date('2026-08-28T00:00:00.000Z'), checkOutDate: new Date('2026-08-30T00:00:00.000Z') });
      tx.reservation.findMany.mockResolvedValueOnce([overstayer, reservation()]).mockResolvedValueOnce([]);
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.chargesPosted).toBe(2);
      const labels = foliosService.postRoomChargeForDate.mock.calls.map((call) => (call as unknown[])[4]);
      expect(labels).toEqual(['Night Audit — overstay', 'Night Audit']);
    });

    it('counts a night the guard already billed as processed but not re-posted', async () => {
      tx.reservation.findMany.mockResolvedValueOnce([reservation()]).mockResolvedValueOnce([]);
      foliosService.postRoomChargeForDate.mockResolvedValue(null); // already posted for this date
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.foliosProcessed).toBe(1);
      expect(result.chargesPosted).toBe(0);
      expect(result.totalAmountPosted).toBe('0.00');
    });

    it('continues the batch when one reservation fails, recording the error', async () => {
      tx.reservation.findMany.mockResolvedValueOnce([reservation({ id: 'bad' }), reservation({ id: 'good' })]).mockResolvedValueOnce([]);
      foliosService.postRoomChargeForDate
        .mockRejectedValueOnce(new Error('folio is settled'))
        .mockResolvedValueOnce({ amount: new Prisma.Decimal('100'), taxAmount: new Prisma.Decimal('0') });
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.errors).toEqual([{ reservationId: 'bad', reason: 'folio is settled' }]);
      expect(result.chargesPosted).toBe(1); // the good one still went through
      expect(result.status).toBe('completed');
    });

    it('writes the run log with its counts on completion', async () => {
      tx.reservation.findMany.mockResolvedValueOnce([reservation()]).mockResolvedValueOnce([]);
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(tx.nightAuditLog.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'completed', chargesPosted: 1 }) }),
      );
    });
  });

  /**
   * The actual marking — status flip, `NoShowRecord`, penalty charge,
   * folio settle — moved to `ReservationsService.markNoShowInTx` (shared
   * with the manual "mark as no-show now" entry point) and is tested
   * there. This batch loop's own job is just: honour `autoMark`, find
   * who's unarrived, call the shared method with the right penalty
   * policy, and keep one bad reservation from stopping the rest.
   */
  describe('no-show marking', () => {
    it('marks unarrived confirmed reservations via the shared ReservationsService method', async () => {
      tx.branch.findFirst.mockResolvedValue({ id: BRANCH_ID, noShowPolicy: { defaultPenalty: 'first_night' } });
      tx.reservation.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([reservation({ id: 'noshow-1' })]);
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.noShowsMarked).toBe(1);
      expect(reservationsService.markNoShowInTx).toHaveBeenCalledWith(
        tx,
        TENANT_ID,
        expect.objectContaining({ id: 'noshow-1' }),
        'first_night',
        undefined,
        ACTOR_ID,
      );
    });

    it('passes the flat fee amount through when the policy uses it', async () => {
      tx.branch.findFirst.mockResolvedValue({ id: BRANCH_ID, noShowPolicy: { defaultPenalty: 'flat_fee', flatFeeAmount: 50 } });
      tx.reservation.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([reservation()]);
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(reservationsService.markNoShowInTx).toHaveBeenCalledWith(tx, TENANT_ID, expect.anything(), 'flat_fee', 50, ACTOR_ID);
    });

    it('respects autoMark:false — leaves the call to front desk', async () => {
      tx.branch.findFirst.mockResolvedValue({ id: BRANCH_ID, noShowPolicy: { autoMark: false } });
      tx.reservation.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([reservation()]);
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.noShowsMarked).toBe(0);
      expect(reservationsService.markNoShowInTx).not.toHaveBeenCalled();
    });

    it('defaults to penaltyType "none" when the branch has no policy set', async () => {
      tx.reservation.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([reservation()]);
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(reservationsService.markNoShowInTx).toHaveBeenCalledWith(tx, TENANT_ID, expect.anything(), 'none', undefined, ACTOR_ID);
    });

    it('one reservation failing to mark does not stop the rest of the batch', async () => {
      tx.branch.findFirst.mockResolvedValue({ id: BRANCH_ID, noShowPolicy: { defaultPenalty: 'none' } });
      tx.reservation.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([reservation({ id: 'bad-1' }), reservation({ id: 'good-1' })]);
      reservationsService.markNoShowInTx.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ reservation: {}, noShowRecord: {} });
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.noShowsMarked).toBe(1);
      expect(result.errors).toEqual([{ reservationId: 'bad-1', reason: 'boom' }]);
    });
  });

  describe('datesToAudit — catching up nights the sweep missed', () => {
    const daysBefore = (n: number) => {
      const date = new Date(`${service.yesterdayForBranch('UTC')}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - n);
      return date;
    };
    const iso = (date: Date) => date.toISOString().slice(0, 10);

    it('a branch never audited starts from yesterday — no backfilling its whole history', async () => {
      expect(await service.datesToAudit(TENANT_ID, BRANCH_ID, 'UTC')).toEqual([iso(daysBefore(0))]);
    });

    it('closes out every night since the last audit, oldest first', async () => {
      tx.nightAuditLog.findFirst.mockResolvedValue({ auditDate: daysBefore(3) });
      tx.nightAuditLog.findMany.mockResolvedValue([{ auditDate: daysBefore(3) }]);
      expect(await service.datesToAudit(TENANT_ID, BRANCH_ID, 'UTC')).toEqual([iso(daysBefore(2)), iso(daysBefore(1)), iso(daysBefore(0))]);
    });

    it('nothing to do once yesterday is audited', async () => {
      tx.nightAuditLog.findFirst.mockResolvedValue({ auditDate: daysBefore(0) });
      tx.nightAuditLog.findMany.mockResolvedValue([{ auditDate: daysBefore(0) }]);
      expect(await service.datesToAudit(TENANT_ID, BRANCH_ID, 'UTC')).toEqual([]);
    });

    it('goes back a week at most — a branch idle for longer restarts from yesterday', async () => {
      tx.nightAuditLog.findFirst.mockResolvedValue({ auditDate: daysBefore(20) });
      expect(await service.datesToAudit(TENANT_ID, BRANCH_ID, 'UTC')).toEqual([iso(daysBefore(0))]);
    });
  });

  describe('yesterdayForBranch', () => {
    it('returns the day before today in the branch timezone', () => {
      const result = service.yesterdayForBranch('UTC');
      const expected = new Date();
      expected.setUTCDate(expected.getUTCDate() - 1);
      expect(result).toBe(expected.toISOString().slice(0, 10));
    });
  });

  describe('getPreflight', () => {
    it('checks for urgent work orders and an open night shift', async () => {
      tx.maintenanceOrder.count.mockResolvedValue(2);
      tx.shift.findMany.mockResolvedValue([{ shiftType: 'evening' }]);
      const result = await service.getPreflight(TENANT_ID, BRANCH_ID);
      const byKey = Object.fromEntries(result.checklist.map((c) => [c.key, c]));
      expect(byKey.maintenance_clear).toMatchObject({ passed: false, detail: '2 urgent work orders still open' });
      expect(byKey.shift_open).toMatchObject({ passed: false, detail: 'A shift is open, but not a night shift' });
      expect(tx.maintenanceOrder.count).toHaveBeenCalledWith({ where: { branchId: BRANCH_ID, priority: 'urgent', status: { in: ['open', 'in_progress', 'on_hold'] } } });
    });

    it('passes both once the urgent work is done and the night shift is on', async () => {
      tx.shift.findMany.mockResolvedValue([{ shiftType: 'night' }]);
      const result = await service.getPreflight(TENANT_ID, BRANCH_ID);
      expect(result.checklist.filter((c) => c.key !== 'departures_resolved').every((c) => c.passed === true)).toBe(true);
    });

    it('fails the departures check while someone is still in-house past check-out', async () => {
      tx.reservation.findMany.mockResolvedValue([reservation()]);
      const result = await service.getPreflight(TENANT_ID, BRANCH_ID);
      const departures = result.checklist.find((c) => c.key === 'departures_resolved');
      expect(departures?.passed).toBe(false);
    });
  });
});
