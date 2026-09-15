import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { HousekeepingTask, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { todayInTimezone, toBranchDate } from '../../common/utils/branch-date';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { CLEANLINESS_TRANSITIONS } from '../property/rooms.service';
import { UsersService } from '../users/users.service';
import { AssignTaskDto, CreateTaskDto, ListTasksQueryDto, ReportIssueDto } from './dto/housekeeping.dto';

const TASK_INCLUDE = {
  room: { select: { id: true, number: true } },
} as const;

/** Roles that may distribute rooms to housekeepers (Staff Assignment, ref p29) — the same set `RoomsService` already treats as supervisors. */
const SUPERVISOR_ROLES = new Set(['owner', 'manager']);

/**
 * Housekeeping (ref p27-31): Task Board, Staff Assignment, and the plain-text
 * side of Report Issue. Inspection Workflow's own approve/reject actions
 * need no new backend surface at all — `clean → inspected` (supervisor-only)
 * and the drop-back-to-`dirty` transition both already exist on
 * `RoomsService.changeStatus`, which the frontend calls directly.
 */
@Injectable()
export class HousekeepingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    private readonly usersService: UsersService,
  ) {}

  /** Manual task creation — front desk or a supervisor flagging a room that needs attention outside the normal checkout trigger. */
  async createTask(tenantId: string, branchId: string, dto: CreateTaskDto, actorId: string): Promise<HousekeepingTask> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const branch = await this.propertyService.assertBranch(tx, branchId);
      const room = await tx.room.findFirst({ where: { id: dto.roomId, branchId, deletedAt: null } });
      if (!room) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found at this branch' });
      }
      return this.createTaskInTx(tx, tenantId, branchId, {
        roomId: dto.roomId,
        priority: dto.priority,
        notes: dto.notes,
        triggerEvent: 'manual',
        taskDate: toBranchDate(todayInTimezone(branch.timezone)),
        actorId,
      });
    });
  }

  /**
   * Shared by `createTask` and `ReservationsService.checkOut`'s own
   * transaction (`triggerEvent: 'checkout'`) — the schema's
   * `triggeredByReservationId` exists precisely so Task Board reflects a
   * checked-out room automatically, not just ones a human remembered to
   * flag. Takes an already-open `tx` rather than wrapping its own
   * `withTenant`, matching how `FoliosService`/`RoomsService` compose
   * inside a caller's transaction elsewhere in this codebase.
   */
  async createTaskInTx(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
    opts: {
      roomId: string;
      priority?: number;
      notes?: string;
      triggerEvent: string;
      triggeredByReservationId?: string;
      taskDate: Date;
      /** `null` when a guest raised it from the booking portal — `AuditLog.userId`'s own "no staff actor" convention. */
      actorId: string | null;
    },
  ): Promise<HousekeepingTask> {
    const task = await tx.housekeepingTask.create({
      data: {
        tenantId,
        branchId,
        roomId: opts.roomId,
        taskDate: opts.taskDate,
        priority: opts.priority,
        notes: opts.notes,
        triggerEvent: opts.triggerEvent,
        triggeredByReservationId: opts.triggeredByReservationId,
      },
      include: TASK_INCLUDE,
    });
    await this.audit(tx, tenantId, opts.actorId, 'housekeeping.task_created', task.id, { roomId: opts.roomId, triggerEvent: opts.triggerEvent });
    return task;
  }

  /** Task Board (all tasks, optionally by status) and "my assigned rooms" (assigneeId = the caller). */
  async listTasks(tenantId: string, branchId: string, query: ListTasksQueryDto) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      return tx.housekeepingTask.findMany({
        where: {
          branchId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
        },
        include: TASK_INCLUDE,
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
    });
  }

  /** Staff Assignment (ref p29) — every housekeeper visible at this branch, reusing `UsersService.listStaff` rather than a second staff query. */
  async listHousekeepers(tenantId: string, branchId: string) {
    const staff = await this.usersService.listStaff(tenantId, branchId);
    return staff.filter((s) => s.roles.some((r) => r.role === 'housekeeper' && (r.branchId === null || r.branchId === branchId)));
  }

  /** Supervisor distributes a room to a specific housekeeper — assignment alone doesn't start the clock; the housekeeper still calls `startTask`. */
  async assignTask(tenantId: string, taskId: string, dto: AssignTaskDto, actor: JwtPayload): Promise<HousekeepingTask> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const task = await this.findTaskOrThrow(tx, taskId);
      const isSupervisor = actor.roles.some((r) => SUPERVISOR_ROLES.has(r.role) && (r.branchId === null || r.branchId === task.branchId));
      if (!isSupervisor) {
        throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Only a supervisor may assign a task to a housekeeper' });
      }
      const updated = await tx.housekeepingTask.update({ where: { id: taskId }, data: { assigneeId: dto.assigneeId }, include: TASK_INCLUDE });
      await this.audit(tx, tenantId, actor.sub, 'housekeeping.task_assigned', taskId, { assigneeId: dto.assigneeId });
      return updated;
    });
  }

  /**
   * "Start Cleaning" — a housekeeper picking up ANY unclaimed task self-
   * assigns it (the reference's own Task Board shows plain, unassigned-
   * looking cards any housekeeper can act on; Staff Assignment is for a
   * supervisor who wants to distribute proactively, not a hard gate on
   * self-service). A task someone else already claimed can't be started by
   * a different housekeeper. Drives the room's own cleanliness ladder
   * (dirty → cleaning) in the same transaction — one user action, one
   * consistent state change, not two separate calls the frontend has to
   * sequence itself.
   */
  async startTask(tenantId: string, taskId: string, actorId: string): Promise<HousekeepingTask> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const task = await this.findTaskOrThrow(tx, taskId);
      if (task.status !== 'pending') {
        throw new ConflictException({ code: ErrorCode.INVALID_STATUS_TRANSITION, message: `Cannot start a task with status "${task.status}"` });
      }
      if (task.assigneeId && task.assigneeId !== actorId) {
        throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'This task is already assigned to someone else' });
      }
      await this.transitionRoomCleanliness(tx, tenantId, task.roomId, 'cleaning', actorId);
      const updated = await tx.housekeepingTask.update({
        where: { id: taskId },
        data: { status: 'in_progress', assigneeId: task.assigneeId ?? actorId },
        include: TASK_INCLUDE,
      });
      await this.audit(tx, tenantId, actorId, 'housekeeping.task_started', taskId, {});
      return updated;
    });
  }

  /** "Complete" — only the assignee (or a task nobody else claimed) may finish it. Drives cleaning → clean; a supervisor still has to inspect it separately. */
  async completeTask(tenantId: string, taskId: string, actorId: string): Promise<HousekeepingTask> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const task = await this.findTaskOrThrow(tx, taskId);
      if (task.status !== 'in_progress') {
        throw new ConflictException({ code: ErrorCode.INVALID_STATUS_TRANSITION, message: `Cannot complete a task with status "${task.status}"` });
      }
      if (task.assigneeId && task.assigneeId !== actorId) {
        throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'This task is assigned to someone else' });
      }
      await this.transitionRoomCleanliness(tx, tenantId, task.roomId, 'clean', actorId);
      const updated = await tx.housekeepingTask.update({
        where: { id: taskId },
        data: { status: 'done', completedAt: new Date(), completedBy: actorId },
        include: TASK_INCLUDE,
      });
      await this.audit(tx, tenantId, actorId, 'housekeeping.task_completed', taskId, {});
      return updated;
    });
  }

  /**
   * Report Issue (ref p28's modal, minus image uploads — those need
   * encrypted file storage that doesn't exist yet, same gap
   * `GuestProfile.idDocUrl`'s own comment already names). Marks the task
   * `skipped` — it needed something other than a normal clean — and
   * appends the area/description to its `notes`. Deliberately does NOT
   * create a `RoomBlock`: whether a reported issue is serious enough to
   * pull the room from inventory is a supervisor's separate call, made in
   * Room Blocking / OOO after reviewing the report, not an automatic
   * consequence of reporting it.
   */
  async reportIssue(tenantId: string, taskId: string, dto: ReportIssueDto, actorId: string): Promise<HousekeepingTask> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const task = await this.findTaskOrThrow(tx, taskId);
      const note = `[${dto.areaOfIssue}] ${dto.description}`;
      const updated = await tx.housekeepingTask.update({
        where: { id: taskId },
        data: { status: 'skipped', notes: task.notes ? `${task.notes}\n${note}` : note },
        include: TASK_INCLUDE,
      });
      await this.audit(tx, tenantId, actorId, 'housekeeping.issue_reported', taskId, { areaOfIssue: dto.areaOfIssue });
      return updated;
    });
  }

  private async transitionRoomCleanliness(tx: TenantTx, tenantId: string, roomId: string, to: 'cleaning' | 'clean', actorId: string): Promise<void> {
    const room = await tx.room.findFirst({ where: { id: roomId, deletedAt: null } });
    if (!room) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Room not found' });
    }
    const from = room.cleanlinessStatus;
    if (from !== to && !CLEANLINESS_TRANSITIONS[from].includes(to)) {
      throw new ConflictException({
        code: ErrorCode.INVALID_STATUS_TRANSITION,
        message: `Cleanliness cannot go ${from} → ${to} (ladder: dirty → cleaning → clean → inspected)`,
      });
    }
    if (from === to) return;
    await tx.room.update({ where: { id: roomId }, data: { cleanlinessStatus: to, statusChangedAt: new Date(), statusChangedBy: actorId } });
    // Entity is the ROOM here, not the task — same `room.status_changed`
    // action and `entityType` `RoomsService.changeStatus` already uses, so
    // this shows up in the room's own audit trail alongside every other
    // status change, not siloed under a housekeeping-only event.
    await tx.auditLog.create({
      data: { tenantId, userId: actorId, action: 'room.status_changed', entityType: 'room', entityId: roomId, after: { cleanlinessStatus: to, reason: 'housekeeping_task' } },
    });
  }

  private async findTaskOrThrow(tx: TenantTx, taskId: string): Promise<HousekeepingTask> {
    const task = await tx.housekeepingTask.findFirst({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Housekeeping task not found' });
    }
    return task;
  }

  private async audit(tx: TenantTx, tenantId: string, userId: string | null, action: string, entityId: string, after: Prisma.InputJsonValue): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, userId, action, entityType: 'housekeeping_task', entityId, after } });
  }
}
