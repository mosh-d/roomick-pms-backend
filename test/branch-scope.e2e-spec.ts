import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, book, BranchLayout, Client, deleteOrganisation, headBrand, hire, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * Who can reach what across two branches of one organisation — third audit
 * M3, M10, L4, L9, L11–L15, L28, L32, and the campaign routes found while fixing.
 *
 * The staff here are real accounts made through invitations: a housekeeper
 * at each branch, a manager at Branch B only, and POS staff at Branch A.
 * The tests run in order; the ones that change someone (a new role, a
 * deactivation, a suspension) come last.
 */
describe('Branch boundaries (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let a: BranchLayout;
  let b: BranchLayout;
  let housekeeperA: Session;
  let housekeeperB: Session;
  let managerB: Session;
  let posStaffA: Session;

  const room = (id: string) => inTenant(prisma, owner.tenantId, (tx) => tx.room.findFirst({ where: { id }, select: { cleanlinessStatus: true } }));
  const taskAt = async (branch: BranchLayout, roomIndex: number) => {
    const res = await client.post(`/branches/${branch.id}/housekeeping/tasks`, owner, { roomId: branch.rooms[roomIndex].id });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Branch Scope');
    const brandId = await headBrand(client, owner);
    a = await addBranch(client, owner, brandId, 'Branch A', 6);
    b = await addBranch(client, owner, brandId, 'Branch B', 2, 15_000);
    housekeeperB = await hire(client, owner, b.id, 'housekeeper', 'hk-b');
    housekeeperA = await hire(client, owner, a.id, 'housekeeper', 'hk-a');
    managerB = await hire(client, owner, b.id, 'manager', 'mgr-b');
    posStaffA = await hire(client, owner, a.id, 'pos_staff', 'pos-a');
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it("a Branch-B housekeeper can't list, start, flag, complete or take a Branch A task (start was 201)", async () => {
    const taskId = await taskAt(a, 1);
    expect((await client.get(`/branches/${a.id}/housekeeping/tasks`, housekeeperB)).status).toBe(403);
    expect((await client.post(`/housekeeping/tasks/${taskId}/start`, housekeeperB)).status).toBe(403);
    expect((await client.post(`/housekeeping/tasks/${taskId}/report-issue`, housekeeperB, { areaOfIssue: 'Bathroom', description: 'Leaking tap' })).status).toBe(403);
    expect((await client.post(`/housekeeping/tasks/${taskId}/complete`, housekeeperB)).status).toBe(403);
    expect((await client.post(`/housekeeping/tasks/${taskId}/assign`, housekeeperB, { assigneeId: housekeeperB.userId })).status).toBe(403);
    const task = await inTenant(prisma, owner.tenantId, (tx) => tx.housekeepingTask.findFirst({ where: { id: taskId }, select: { status: true, assigneeId: true } }));
    expect(task).toEqual({ status: 'pending', assigneeId: null });
  });

  it('a task raised for a clean room makes it dirty, so it can be started; an issue mid-clean puts it back to dirty', async () => {
    expect((await room(a.rooms[2].id))?.cleanlinessStatus).toBe('clean');
    const taskId = await taskAt(a, 2);
    expect((await room(a.rooms[2].id))?.cleanlinessStatus).toBe('dirty');
    expect((await client.post(`/housekeeping/tasks/${taskId}/start`, housekeeperA)).status).toBe(201);
    expect((await room(a.rooms[2].id))?.cleanlinessStatus).toBe('cleaning');
    expect((await client.post(`/housekeeping/tasks/${taskId}/report-issue`, housekeeperA, { areaOfIssue: 'Bathroom', description: 'Leaking tap' })).status).toBe(201);
    expect((await room(a.rooms[2].id))?.cleanlinessStatus).toBe('dirty');
  });

  it('the rate trail is for the owner, managers and accountants of that branch', async () => {
    const reservationId = await book(client, owner, a, 'Alice OnlyA', lagosDay(10), lagosDay(12));
    expect((await client.get(`/rate-resolver/audit?reservationId=${reservationId}`, owner)).status).toBe(200);
    expect((await client.get(`/rate-resolver/audit?reservationId=${reservationId}`, housekeeperA)).status).toBe(403);
    expect((await client.get(`/rate-resolver/audit?reservationId=${reservationId}`, managerB)).status).toBe(403);
  });

  it("a Branch-B manager sees none of a Branch A waiter's outlets and can't change them", async () => {
    const outlet = await client.post(`/branches/${a.id}/pos/outlets`, owner, { name: 'Pool Bar', category: 'bar' });
    expect(outlet.status).toBe(201);
    expect((await client.put(`/users/${posStaffA.userId}/outlets`, owner, { branchId: a.id, outletIds: [outlet.body.id] })).status).toBe(200);
    expect((await client.get(`/users/${posStaffA.userId}/outlets`, owner)).body).toHaveLength(1);
    const seenByB = await client.get(`/users/${posStaffA.userId}/outlets`, managerB);
    expect(seenByB.status).toBe(200);
    expect(seenByB.body).toHaveLength(0);
    expect((await client.put(`/users/${posStaffA.userId}/outlets`, managerB, { branchId: a.id, outletIds: [] })).status).toBe(403);
  });

  it("a Branch-B manager reads Branch B's audit trail and the organisation-wide entries, never Branch A's", async () => {
    const mine = await client.get('/audit-logs?limit=100', managerB);
    expect(mine.status).toBe(200);
    for (const row of mine.body.rows as Array<{ branchId: string | null }>) expect([b.id, null]).toContain(row.branchId);
    expect((await client.get(`/audit-logs?branchId=${a.id}`, managerB)).status).toBe(403);
    const ownerView = await client.get(`/audit-logs?branchId=${a.id}`, owner);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.total).toBeGreaterThan(0);
  });

  it("a Branch-B manager can't read, edit or cancel a Branch A campaign", async () => {
    const segment = await client.post('/marketing/segments', owner, { name: 'Everyone', criteria: {} });
    const template = await client.post('/marketing/templates', owner, { name: 'Hello', subject: 'Hello', body: 'Hello {{guest_name}}' });
    const campaign = await client.post(`/branches/${a.id}/marketing/campaigns`, owner, { name: 'A campaign', channel: 'email', segmentId: segment.body.id, templateId: template.body.id, subject: 'Hello' });
    expect(campaign.status).toBe(201);
    expect((await client.get(`/marketing/campaigns/${campaign.body.id}`, managerB)).status).toBe(403);
    expect((await client.patch(`/marketing/campaigns/${campaign.body.id}`, managerB, { name: 'Hijacked' })).status).toBe(403);
    expect((await client.post(`/marketing/campaigns/${campaign.body.id}/cancel`, managerB)).status).toBe(403);
    expect((await client.get(`/marketing/campaigns/${campaign.body.id}`, owner)).status).toBe(200);
  });

  it("the custom report's guests at Branch B leave out guests who only booked at Branch A", async () => {
    const run = (branchId: string) => client.post(`/branches/${branchId}/reports/custom/run`, owner, { dataset: 'guests', fields: ['name', 'email'], from: lagosDay(-1), to: lagosDay(1) });
    const atB = await run(b.id);
    expect(atB.status).toBe(200);
    expect((atB.body.rows as Array<{ name: string }>).map((r) => r.name)).not.toContain('Alice OnlyA');
    expect(((await run(a.id)).body.rows as Array<{ name: string }>).map((r) => r.name)).toContain('Alice OnlyA');
  });

  it("refuses another branch's room type for overbooking, and another branch's room for an asset", async () => {
    expect((await client.patch(`/branches/${b.id}/overbooking-config`, owner, { roomTypeId: a.roomTypeId, globalEnabled: true, maxOverbookPct: 5 })).status).toBe(404);
    expect((await client.patch(`/branches/${b.id}/overbooking-config`, owner, { roomTypeId: b.roomTypeId, globalEnabled: true, maxOverbookPct: 5 })).status).toBe(200);
    expect((await client.post(`/branches/${b.id}/maintenance/assets`, owner, { name: 'AC unit', roomId: a.rooms[0].id })).status).toBe(404);
    expect((await client.post(`/branches/${b.id}/maintenance/assets`, owner, { name: 'AC unit', roomId: b.rooms[0].id })).status).toBe(201);
  });

  it('keeps the other policies when one is sent, and removes one sent as null', async () => {
    const policies = () => inTenant(prisma, owner.tenantId, (tx) => tx.branch.findFirst({ where: { id: a.id }, select: { policies: true } })).then((r) => r?.policies);
    expect((await client.patch(`/branches/${a.id}`, owner, { policies: { petsAllowed: false, smokingAllowed: false } })).status).toBe(200);
    expect((await client.patch(`/branches/${a.id}`, owner, { policies: { petsAllowed: true } })).status).toBe(200);
    expect(await policies()).toMatchObject({ petsAllowed: true, smokingAllowed: false });
    expect((await client.patch(`/branches/${a.id}`, owner, { policies: { smokingAllowed: null } })).status).toBe(200);
    expect(await policies()).not.toHaveProperty('smokingAllowed');
  });

  it('a new role counts from the very next request, on the same sign-in', async () => {
    const roles = (await client.get('/auth/roles', owner)).body as Array<{ id: string; name: string }>;
    expect((await client.get(`/branches/${b.id}/inbox`, housekeeperB)).status).toBe(403);
    const change = await client.patch(`/staff/${housekeeperB.userId}`, owner, { roleId: roles.find((r) => r.name === 'front_desk')?.id, branchId: b.id });
    expect(change.status).toBe(200);
    expect((await client.get(`/branches/${b.id}/inbox`, housekeeperB)).status).toBe(200);
  });

  it("a deactivated housekeeper drops off the list and can't be given a room", async () => {
    const listed = async () => ((await client.get(`/branches/${a.id}/housekeeping/staff`, owner)).body as Array<{ id: string }>).some((s) => s.id === housekeeperA.userId);
    expect(await listed()).toBe(true);
    expect((await client.patch(`/staff/${housekeeperA.userId}`, owner, { active: false })).status).toBe(200);
    expect(await listed()).toBe(false);
    const taskId = await taskAt(a, 3);
    expect((await client.post(`/housekeeping/tasks/${taskId}/assign`, owner, { assigneeId: housekeeperA.userId })).status).toBe(400);
  });

  it("an invitation to a suspended organisation can't be accepted, and makes no account", async () => {
    const roles = (await client.get('/auth/roles', owner)).body as Array<{ id: string; name: string }>;
    const email = `late.joiner.${Date.now()}@example.com`;
    const invited = await client.post(`/branches/${b.id}/staff/invite`, owner, { invites: [{ email, roleId: roles.find((r) => r.name === 'front_desk')?.id }] });
    const { publicToken } = (invited.body as Array<{ publicToken: string }>)[0];
    const status = (await prisma.tenant.findUniqueOrThrow({ where: { id: owner.tenantId } })).status;
    await prisma.tenant.update({ where: { id: owner.tenantId }, data: { status: 'suspended' } });
    try {
      const accepted = await client.post(`/auth/accept-invite/${encodeURIComponent(publicToken)}`, null, { name: 'Late Joiner', password: 'StaffPass!1' });
      expect(accepted.status).toBe(403);
      expect(accepted.body.code).toBe('TENANT_SUSPENDED');
    } finally {
      await prisma.tenant.update({ where: { id: owner.tenantId }, data: { status } });
    }
    expect(await inTenant(prisma, owner.tenantId, (tx) => tx.user.findFirst({ where: { email } }))).toBeNull();
  });
});
