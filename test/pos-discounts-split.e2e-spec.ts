import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, BranchLayout, Client, deleteOrganisation, headBrand, hire, Session, signUp, startApp } from './support/e2e';

/**
 * Point of Sale discounts — a manager's to give, the till staff's up to the
 * outlet's own limit — and a sale split between cash and card, whose cash
 * part the drawer expects at close.
 */
describe('POS discounts and split payments (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let desk: Session;
  let branch: BranchLayout;
  let outletId: string;
  let dishId: string;

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Pos Discounts');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Pos Branch', 2);
    desk = await hire(client, owner, branch.id, 'front_desk', 'pos-desk');
    const outlet = await client.post(`/branches/${branch.id}/pos/outlets`, owner, { name: 'Bar', category: 'bar' });
    outletId = outlet.body.id;
    dishId = (await client.post(`/pos/outlets/${outletId}/menu-items`, owner, { name: 'Chapman', category: 'Drinks', price: 2_000 })).body.id;
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  const items = [{ menuItemId: '', qty: 2 }];
  const basket = () => items.map((line) => ({ ...line, menuItemId: dishId }));

  it('lets a manager give any discount, with a reason, and staff only up to the outlet’s limit', async () => {
    const tenOff = { type: 'percentage', value: 10, reason: 'Regular guest' };
    const quote = await client.post(`/pos/outlets/${outletId}/quote`, owner, { items: basket(), discount: { type: 'percentage', value: 10 } });
    expect(quote.status).toBe(200);
    expect(Number(quote.body.discount)).toBe(400);
    expect(Number(quote.body.subtotal)).toBe(3600);

    expect((await client.post('/pos/orders', owner, { outletId, settlement: 'card', items: basket(), discount: { type: 'percentage', value: 10 } })).status).toBe(400);
    const sold = await client.post('/pos/orders', owner, { outletId, settlement: 'card', items: basket(), discount: tenOff });
    expect(sold.status).toBe(201);
    expect(sold.body).toMatchObject({ discountReason: 'Regular guest' });
    expect(Number(sold.body.discountTotal)).toBe(400);
    expect(Number(sold.body.cardAmount)).toBe(Number(sold.body.total));

    // The desk can't discount here until the outlet allows it — then only so far.
    expect((await client.post(`/pos/outlets/${outletId}/quote`, desk, { items: basket(), discount: tenOff })).status).toBe(403);
    expect((await client.patch(`/pos/outlets/${outletId}`, owner, { staffDiscountLimitPct: 5 })).status).toBe(200);
    expect((await client.post(`/pos/outlets/${outletId}/quote`, desk, { items: basket(), discount: tenOff })).status).toBe(403);
    expect((await client.post('/pos/orders', desk, { outletId, settlement: 'card', items: basket(), discount: { type: 'fixed', value: 200, reason: 'Spilt' } })).status).toBe(201);
  });

  it('splits a sale between cash into the drawer and card, and the drawer expects only the cash', async () => {
    expect((await client.post(`/branches/${branch.id}/shifts/open`, desk, { shiftType: 'morning', openingFloat: 10_000 })).status).toBe(201);
    const split = await client.post('/pos/orders', desk, { outletId, settlement: 'split', cashAmount: 1_000, items: basket() });
    expect(split.status).toBe(201);
    expect(Number(split.body.cashAmount)).toBe(1_000);
    expect(Number(split.body.cardAmount)).toBe(Number(split.body.total) - 1_000);
    expect((await client.post('/pos/orders', desk, { outletId, settlement: 'split', cashAmount: Number(split.body.total), items: basket() })).status).toBe(400);

    const day = await client.get(`/pos/outlets/${outletId}/orders`, owner);
    expect(Number(day.body.summary.cash)).toBe(1_000);
    expect(Number(day.body.summary.discounts)).toBe(600);

    const shift = (await client.get(`/branches/${branch.id}/shifts/current`, desk)).body as { id: string };
    const closed = await client.post(`/shifts/${shift.id}/close`, desk, { closingCashCounted: 11_000 });
    expect(closed.status).toBe(201);
    expect(Number(closed.body.systemCashTotal)).toBe(11_000);
  });
});
