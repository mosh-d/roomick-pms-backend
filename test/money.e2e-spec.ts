import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, book, BranchLayout, checkIn, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * Money on a bill — third audit M2, L19, L20, and the second audit's credit-balance rule.
 *
 * One approved refund paid out twice when the button was pressed twice;
 * an amount of 1e30 overflowed into a 500; a settled bill said "reopen it"
 * with no way to; a bill the guest was owed money on could be closed.
 */
describe('Money on a bill (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;

  const stayBill = async (name: string, roomIndex: number) =>
    checkIn(client, owner, await book(client, owner, branch, name, lagosDay(0), lagosDay(1)), branch.rooms[roomIndex].id);
  const balanceOf = async (folioId: string) => Number((await client.get(`/folios/${folioId}`, owner)).body.totals.balanceDue);

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Money');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Money Branch', 4);
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it('pays an approved refund out once, however many times it is pressed (was twice)', async () => {
    const folioId = await stayBill('Refund Guest', 0);
    expect((await client.post(`/folios/${folioId}/payments`, owner, { amount: 100_000, method: 'card' })).status).toBe(201);
    const refund = await client.post(`/folios/${folioId}/refunds`, owner, { amount: 10_000, method: 'card', reason: 'Booked one night too many' });
    expect(refund.status).toBe(201);
    if (refund.body.status === 'pending') expect((await client.post(`/refunds/${refund.body.id}/approve`, owner)).status).toBe(201);

    const payOuts = await Promise.all([1, 2, 3].map(() => client.post(`/refunds/${refund.body.id}/pay-out`, owner)));
    expect(payOuts.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const paidBack = await inTenant(prisma, owner.tenantId, (tx) => tx.payment.findMany({ where: { folioId, amount: { lt: 0 } }, select: { amount: true } }));
    expect(paidBack.map((p) => Number(p.amount))).toEqual([-10_000]);
  });

  it('refuses a payment, a charge or a refund of 1e30 with a 400 (was a 500)', async () => {
    const folioId = await stayBill('Huge Numbers', 1);
    expect((await client.post(`/folios/${folioId}/payments`, owner, { amount: 1e30, method: 'card' })).status).toBe(400);
    expect((await client.post(`/folios/${folioId}/charges`, owner, { description: 'Huge', amount: 1e30, chargeType: 'minibar' })).status).toBe(400);
    expect((await client.post(`/folios/${folioId}/refunds`, owner, { amount: 1e30, method: 'card', reason: 'Huge' })).status).toBe(400);
  });

  it('reopens a settled bill with a reason, so a late charge can be posted', async () => {
    const folioId = await stayBill('Late Minibar', 2);
    const due = await balanceOf(folioId);
    if (due > 0) expect((await client.post(`/folios/${folioId}/payments`, owner, { amount: due, method: 'card' })).status).toBe(201);
    expect((await client.post(`/folios/${folioId}/close`, owner)).status).toBe(201);

    const toSettled = await client.post(`/folios/${folioId}/charges`, owner, { description: 'Minibar', amount: 1_500, chargeType: 'minibar' });
    expect(toSettled.status).toBe(409);
    expect(toSettled.body.detail).toMatch(/reopen/);
    expect((await client.post(`/folios/${folioId}/reopen`, owner, {})).status).toBe(400);
    expect((await client.post(`/folios/${folioId}/reopen`, owner, { reason: 'Minibar found after check-out' })).status).toBe(201);
    expect((await client.post(`/folios/${folioId}/charges`, owner, { description: 'Minibar', amount: 1_500, chargeType: 'minibar' })).status).toBe(201);
    const trail = await inTenant(prisma, owner.tenantId, (tx) => tx.auditLog.findFirst({ where: { entityId: folioId, action: 'folio.reopened' } }));
    expect(trail).toMatchObject({ branchId: branch.id, after: { reason: 'Minibar found after check-out' } });
    expect((await client.post(`/folios/${folioId}/reopen`, owner, { reason: 'Again' })).status).toBe(409);
  });

  it('will not close a bill the guest is owed money on, and lists it as a refund due', async () => {
    const folioId = await stayBill('Overpaid Guest', 3);
    const due = await balanceOf(folioId);
    expect((await client.post(`/folios/${folioId}/payments`, owner, { amount: due + 30_000, method: 'card' })).status).toBe(201);
    const close = await client.post(`/folios/${folioId}/close`, owner);
    expect(close.status).toBe(409);
    expect(close.body.code).toBe('FOLIO_CREDIT_BALANCE');
    const refundDue = await client.get(`/branches/${branch.id}/folios?filter=refund_due`, owner);
    expect(refundDue.status).toBe(200);
    expect((refundDue.body as Array<{ id: string; guestStatus: string }>).find((f) => f.id === folioId)).toMatchObject({ guestStatus: 'refund_due' });
  });
});
