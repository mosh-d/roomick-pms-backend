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
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    reservation: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    folio: { findMany: jest.fn().mockResolvedValue([]) },
    maintenanceOrder: { count: jest.fn().mockResolvedValue(0) },
    shift: { findMany: jest.fn().mockResolvedValue([]) },
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
}

type Stay = ReturnType<typeof reservation>;

describe('NightAuditService', () => {
  let service: NightAuditService;
  let tx: ReturnType<typeof makeTx>;
  let withTenant: jest.Mock;
  let foliosService: { ensurePrimaryFolio: jest.Mock; postRoomChargeForDate: jest.Mock };
  let reservationsService: { markNoShowInTx: jest.Mock };
  let housekeepingService: { ensureStayoverTaskInTx: jest.Mock; ensureTurndownTaskInTx: jest.Mock };

  /** The branch's in-house stays and unarrived bookings, as every listing and batch re-read of them finds them. */
  function stays(inHouse: Stay[], unarrived: Stay[] = []) {
    tx.reservation.findMany.mockImplementation(({ where }: { where: { status?: string; id?: { in: string[] } } }) => {
      const pool = where.status === 'checked_in' ? inHouse : where.status === 'confirmed' ? unarrived : [];
      const ids = where.id?.in;
      return Promise.resolve(ids ? pool.filter((r) => ids.includes(r.id)) : pool);
    });
  }

  beforeEach(async () => {
    tx = makeTx();
    foliosService = {
      ensurePrimaryFolio: jest.fn().mockResolvedValue({ id: 'folio-1' }),
      postRoomChargeForDate: jest.fn().mockResolvedValue({ amount: new Prisma.Decimal('100'), taxAmount: new Prisma.Decimal('7.5') }),
    };
    reservationsService = { markNoShowInTx: jest.fn().mockResolvedValue({ reservation: {}, noShowRecord: {} }) };
    housekeepingService = { ensureStayoverTaskInTx: jest.fn().mockResolvedValue(true), ensureTurndownTaskInTx: jest.fn().mockResolvedValue(true) };
    withTenant = jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx));
    const moduleRef = await Test.createTestingModule({
      providers: [
        NightAuditService,
        {
          provide: PrismaService,
          useValue: {
            withTenant,
            tenant: { findMany: jest.fn().mockResolvedValue([]) },
          },
        },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, timezone: 'Africa/Lagos' }) } },
        { provide: FoliosService, useValue: foliosService },
        { provide: ReservationsService, useValue: reservationsService },
        { provide: HousekeepingService, useValue: housekeepingService },
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
      stays([reservation({ id: 'bad' }), reservation({ id: 'good' })]);
      foliosService.postRoomChargeForDate
        .mockRejectedValueOnce(new Error('folio is settled'))
        .mockResolvedValueOnce({ amount: new Prisma.Decimal('100'), taxAmount: new Prisma.Decimal('0') });
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      const calls = tx.$executeRawUnsafe.mock.calls.map((call: unknown[]) => call[0]);
      expect(calls).toEqual(['SAVEPOINT night_audit_stay', 'ROLLBACK TO SAVEPOINT night_audit_stay', 'SAVEPOINT night_audit_stay', 'RELEASE SAVEPOINT night_audit_stay']);
    });

    it('refuses a second run once the night is closed', async () => {
      tx.nightAuditLog.findFirst.mockResolvedValue({ id: BigInt(1), status: 'completed', triggeredAt: new Date() });
      await expect(service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID)).rejects.toThrow(/has already run/);
      expect(tx.nightAuditLog.create).not.toHaveBeenCalled();
      expect(tx.nightAuditLog.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a run while another is still closing the same night', async () => {
      tx.nightAuditLog.findFirst.mockResolvedValue({ id: BigInt(1), status: 'running', triggeredAt: new Date(Date.now() - 60_000) });
      await expect(service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID)).rejects.toThrow(/running now/);
      expect(foliosService.postRoomChargeForDate).not.toHaveBeenCalled();
    });

    it('turns a run that raced it to the insert into the same "running now" refusal', async () => {
      tx.nightAuditLog.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }));
      await expect(service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID)).rejects.toThrow(ConflictException);
    });

    it('picks up a failed run where it stopped, keeping what it had already posted', async () => {
      tx.nightAuditLog.findFirst.mockResolvedValue({ id: BigInt(7), status: 'failed', triggeredAt: new Date(), chargesPosted: 3, totalAmountPosted: new Prisma.Decimal('322.50') });
      stays([reservation()]);
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(tx.nightAuditLog.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: BigInt(7), status: 'failed' }, data: expect.objectContaining({ status: 'running', triggeredBy: ACTOR_ID }) }),
      );
      expect(tx.nightAuditLog.create).not.toHaveBeenCalled();
      expect(result.chargesPosted).toBe(4); // the three from before, and this one
      expect(result.totalAmountPosted).toBe('430.00');
      expect(result.status).toBe('completed');
    });

    it('takes over a run that died part-way once it has gone stale — and only one taker wins', async () => {
      tx.nightAuditLog.findFirst.mockResolvedValue({ id: BigInt(7), status: 'running', triggeredAt: new Date(Date.now() - 11 * 60_000), chargesPosted: null, totalAmountPosted: null });
      tx.nightAuditLog.updateMany.mockResolvedValueOnce({ count: 0 }); // someone else took it first
      await expect(service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID)).rejects.toThrow(/running now/);
      const where = (tx.nightAuditLog.updateMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
      expect(where).toMatchObject({ id: BigInt(7), status: 'running', triggeredAt: { lt: expect.any(Date) } });

      stays([reservation()]);
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.status).toBe('completed');
    });

    it('closes the stays in batches, each its own transaction with room to finish, moving the totals with each', async () => {
      stays(Array.from({ length: 60 }, (_, i) => reservation({ id: `res-${String(i).padStart(2, '0')}` })));
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.chargesPosted).toBe(60);
      const batchCalls = withTenant.mock.calls.filter((call) => (call[2] as { timeout?: number } | undefined)?.timeout);
      expect(batchCalls).toHaveLength(3); // 25 + 25 + 10 stays; no-shows had none to batch
      // Progress after each batch, then the finished row.
      const progress = tx.nightAuditLog.update.mock.calls.map((call) => (call[0] as { data: { chargesPosted: number; status?: string } }).data);
      expect(progress.map((d) => d.chargesPosted)).toEqual([25, 50, 60, 60]);
      expect(progress.at(-1)?.status).toBe('completed');
    });

    it('a batch that fails as a whole leaves the run failed, its stays named, and the other batches posted', async () => {
      stays(Array.from({ length: 60 }, (_, i) => reservation({ id: `res-${String(i).padStart(2, '0')}` })));
      tx.nightAuditLog.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('connection lost'));
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.status).toBe('failed');
      expect(result.chargesPosted).toBe(35); // batches one and three
      expect(result.errors).toHaveLength(25);
      expect(result.errors[0]).toEqual({ reservationId: 'res-25', reason: 'Not closed this run, run it again: connection lost' });
      const finished = (tx.nightAuditLog.update.mock.calls.at(-1)?.[0] as { data: { status: string } }).data;
      expect(finished.status).toBe('failed');
    });

    it('posts one night per in-house reservation and totals the amount incl. tax', async () => {
      stays([reservation(), reservation({ id: 'res-2' })]);
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.chargesPosted).toBe(2);
      expect(result.foliosProcessed).toBe(2);
      expect(result.totalAmountPosted).toBe('215.00'); // 2 x (100 + 7.5)
      expect(result.status).toBe('completed');
    });

    it('raises the evening turndown for guests staying the night — only VIPs’ rooms when the branch says so', async () => {
      tx.branch.findFirst.mockResolvedValue({ id: BRANCH_ID, timezone: 'Africa/Lagos', noShowPolicy: null, turndownPolicy: { scope: 'vip' } });
      stays([
        reservation({ id: 'res-vip', roomId: 'room-a', guest: { name: 'Ada', vipLevel: 2 } }),
        reservation({ id: 'res-plain', roomId: 'room-b', guest: { name: 'Bayo', vipLevel: 0 } }),
        reservation({ id: 'res-leaving', roomId: 'room-c', guest: { name: 'Chi', vipLevel: 3 }, checkOutDate: new Date('2026-09-03T00:00:00.000Z') }),
      ]);
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(housekeepingService.ensureStayoverTaskInTx).toHaveBeenCalledTimes(3);
      expect(housekeepingService.ensureTurndownTaskInTx).toHaveBeenCalledTimes(1);
      expect(housekeepingService.ensureTurndownTaskInTx).toHaveBeenCalledWith(tx, TENANT_ID, BRANCH_ID, 'room-a', 'res-vip', new Date('2026-09-03T00:00:00.000Z'));
    });

    it('raises no turndown where the branch offers none', async () => {
      stays([reservation({ id: 'res-vip', roomId: 'room-a', guest: { name: 'Ada', vipLevel: 5 } })]);
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(housekeepingService.ensureStayoverTaskInTx).toHaveBeenCalledTimes(1);
      expect(housekeepingService.ensureTurndownTaskInTx).not.toHaveBeenCalled();
    });

    it('bills everyone checked in that night — whatever their booked departure date', async () => {
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      const where = (tx.reservation.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
      expect(where).toMatchObject({ status: 'checked_in', checkInDate: { lte: new Date('2026-09-02T00:00:00.000Z') } });
      expect(where).not.toHaveProperty('checkOutDate');
    });

    it('does not bill a stay checked out after the run listed it', async () => {
      const leaving = reservation({ id: 'leaving' });
      const staying = reservation({ id: 'staying' });
      // Listed while in-house; checked out by the time its batch reads it again.
      tx.reservation.findMany.mockImplementation(({ where }: { where: { status?: string; id?: { in: string[] } } }) =>
        Promise.resolve(where.status !== 'checked_in' ? [] : where.id?.in ? [staying] : [leaving, staying]),
      );
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.chargesPosted).toBe(1);
      expect(foliosService.postRoomChargeForDate).toHaveBeenCalledTimes(1);
    });

    it('charges a guest still in the room after their departure date, and labels the night an overstay', async () => {
      const overstayer = reservation({ id: 'stayed-on', checkInDate: new Date('2026-08-28T00:00:00.000Z'), checkOutDate: new Date('2026-08-30T00:00:00.000Z') });
      stays([overstayer, reservation()]);
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.chargesPosted).toBe(2);
      const labels = foliosService.postRoomChargeForDate.mock.calls.map((call) => (call as unknown[])[4]);
      expect(labels).toEqual(['Night Audit — overstay', 'Night Audit']);
    });

    it('counts a night the guard already billed as processed but not re-posted', async () => {
      stays([reservation()]);
      foliosService.postRoomChargeForDate.mockResolvedValue(null); // already posted for this date
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.foliosProcessed).toBe(1);
      expect(result.chargesPosted).toBe(0);
      expect(result.totalAmountPosted).toBe('0.00');
    });

    it('continues the batch when one reservation fails, recording the error', async () => {
      stays([reservation({ id: 'bad' }), reservation({ id: 'good' })]);
      foliosService.postRoomChargeForDate
        .mockRejectedValueOnce(new Error('folio is settled'))
        .mockResolvedValueOnce({ amount: new Prisma.Decimal('100'), taxAmount: new Prisma.Decimal('0') });
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.errors).toEqual([{ reservationId: 'bad', reason: 'folio is settled' }]);
      expect(result.chargesPosted).toBe(1); // the good one still went through
      expect(result.status).toBe('completed');
    });

    it('writes the run log with its counts on completion', async () => {
      stays([reservation()]);
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(tx.nightAuditLog.update).toHaveBeenLastCalledWith(
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
      stays([], [reservation({ id: 'noshow-1' })]);
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
      stays([], [reservation()]);
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(reservationsService.markNoShowInTx).toHaveBeenCalledWith(tx, TENANT_ID, expect.anything(), 'flat_fee', 50, ACTOR_ID);
    });

    it('respects autoMark:false — leaves the call to front desk', async () => {
      tx.branch.findFirst.mockResolvedValue({ id: BRANCH_ID, noShowPolicy: { autoMark: false } });
      stays([], [reservation()]);
      const result = await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(result.noShowsMarked).toBe(0);
      expect(reservationsService.markNoShowInTx).not.toHaveBeenCalled();
    });

    it('defaults to penaltyType "none" when the branch has no policy set', async () => {
      stays([], [reservation()]);
      await service.runAudit(TENANT_ID, BRANCH_ID, AUDIT_DATE, ACTOR_ID);
      expect(reservationsService.markNoShowInTx).toHaveBeenCalledWith(tx, TENANT_ID, expect.anything(), 'none', undefined, ACTOR_ID);
    });

    it('one reservation failing to mark does not stop the rest of the batch', async () => {
      tx.branch.findFirst.mockResolvedValue({ id: BRANCH_ID, noShowPolicy: { defaultPenalty: 'none' } });
      stays([], [reservation({ id: 'bad-1' }), reservation({ id: 'good-1' })]);
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

    it('counts a night as done only once it closed, or while a fresh run is closing it — a failed or abandoned one stays pending', async () => {
      await service.datesToAudit(TENANT_ID, BRANCH_ID, 'UTC');
      const where = (tx.nightAuditLog.findMany.mock.calls[0] as [{ where: { OR: unknown[] } }])[0].where;
      expect(where.OR).toEqual([{ status: 'completed' }, { status: 'running', triggeredAt: { gte: expect.any(Date) } }]);
    });

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

    it('says so when the next night to close stopped part-way last time', async () => {
      const yesterday = service.yesterdayForBranch('Africa/Lagos');
      tx.nightAuditLog.findFirst.mockImplementation(({ where }: { where: { status?: unknown } }) =>
        Promise.resolve(
          where.status
            ? { auditDate: new Date(`${yesterday}T00:00:00.000Z`), status: 'failed', chargesPosted: 12, errors: [{ reservationId: 'r1', reason: 'Not closed this run, run it again: connection lost' }] }
            : null,
        ),
      );
      const result = await service.getPreflight(TENANT_ID, BRANCH_ID);
      expect(result.pendingDates).toEqual([yesterday]);
      expect(result.lastStoppedRun).toEqual({ auditDate: yesterday, status: 'failed', chargesPosted: 12, errorCount: 1, reason: 'Not closed this run, run it again: connection lost' });
    });

    it('fails the departures check while someone is still in-house past check-out', async () => {
      tx.reservation.findMany.mockResolvedValue([reservation()]);
      const result = await service.getPreflight(TENANT_ID, BRANCH_ID);
      const departures = result.checklist.find((c) => c.key === 'departures_resolved');
      expect(departures?.passed).toBe(false);
    });
  });
});
