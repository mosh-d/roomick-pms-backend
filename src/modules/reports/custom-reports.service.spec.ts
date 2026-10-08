import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService } from '../property/property.service';
import { CustomReportsService } from './custom-reports.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const d = (v: string) => new Prisma.Decimal(v);

function stay(overrides: Record<string, unknown> = {}) {
  return {
    confirmationNumber: 'RES-1',
    status: 'checked_out',
    channel: 'direct',
    checkInDate: new Date('2026-10-01T00:00:00.000Z'),
    checkOutDate: new Date('2026-10-03T00:00:00.000Z'),
    adults: 1,
    children: 0,
    confirmedRate: d('200000'),
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    guest: { name: 'Ada Obi', email: 'ada@dangote.com', phone: null },
    roomType: { name: 'Deluxe' },
    room: { number: '101' },
    corporateAccount: { name: 'Dangote Group' },
    groupBlock: null,
    ...overrides,
  };
}

function makeTx() {
  return {
    reservation: {
      findMany: jest.fn().mockResolvedValue([
        stay(),
        stay({ confirmationNumber: 'RES-2', guest: { name: 'Bayo Ade', email: null, phone: null }, roomType: { name: 'Suite' }, confirmedRate: d('360000'), corporateAccount: null }),
        stay({ confirmationNumber: 'RES-3', status: 'cancelled', guest: { name: 'Chi Eze', email: null, phone: null }, confirmedRate: d('100000'), corporateAccount: null }),
      ]),
    },
    guestProfile: { findMany: jest.fn().mockResolvedValue([]) },
    reportTemplate: {
      upsert: jest.fn().mockImplementation(({ create }: { create: Record<string, unknown> }) => Promise.resolve({ id: 'tpl-1', ...create })),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('CustomReportsService', () => {
  let service: CustomReportsService;
  let tx: ReturnType<typeof makeTx>;
  const base = { dataset: 'reservations', from: '2026-10-01', to: '2026-11-01' };

  beforeEach(async () => {
    tx = makeTx();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CustomReportsService,
        { provide: PrismaService, useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID, timezone: 'Africa/Lagos', currency: 'NGN' }) } },
      ],
    }).compile();
    service = moduleRef.get(CustomReportsService);
  });

  it('only names in the catalogue can be used — dataset, column, operator, grouping', async () => {
    await expect(service.run(TENANT_ID, BRANCH_ID, { ...base, dataset: 'users', fields: ['email'] })).rejects.toThrow(BadRequestException);
    await expect(service.run(TENANT_ID, BRANCH_ID, { ...base, fields: ['passwordHash'] })).rejects.toThrow(/no column passwordHash/);
    await expect(service.run(TENANT_ID, BRANCH_ID, { ...base, fields: ['guestName'], filters: [{ field: 'roomTotal', operator: 'contains', value: '1' }] })).rejects.toThrow(
      /can't be used on Room total/,
    );
    await expect(service.run(TENANT_ID, BRANCH_ID, { ...base, fields: ['guestName'], groupBy: 'roomTotal' })).rejects.toThrow(/Group by a text, list or date column/);
    expect(tx.reservation.findMany).not.toHaveBeenCalled();
  });

  it('the picked columns, filtered and sorted', async () => {
    const result = await service.run(TENANT_ID, BRANCH_ID, {
      ...base,
      fields: ['confirmationNumber', 'guestName', 'roomTotal', 'nights'],
      filters: [{ field: 'status', operator: 'not_equals', value: 'cancelled' }],
      sortBy: 'roomTotal',
      sortDir: 'desc',
    });
    expect(result.columns.map((c) => c.key)).toEqual(['confirmationNumber', 'guestName', 'roomTotal', 'nights']);
    expect(result.rows).toEqual([
      { confirmationNumber: 'RES-2', guestName: 'Bayo Ade', roomTotal: '360000.00', nights: 2 },
      { confirmationNumber: 'RES-1', guestName: 'Ada Obi', roomTotal: '200000.00', nights: 2 },
    ]);
    expect(result.total).toBe(2);
  });

  it('grouped: one row per value, a count, and the sum of each money and number column', async () => {
    const result = await service.run(TENANT_ID, BRANCH_ID, { ...base, fields: ['roomType', 'roomTotal', 'nights'], groupBy: 'roomType', sortBy: 'roomType' });
    expect(result.columns.map((c) => c.label)).toEqual(['Room type', 'Count', 'Room total (total)', 'Nights (total)']);
    expect(result.rows).toEqual([
      { roomType: 'Deluxe', count: 2, roomTotal: '300000.00', nights: 4 },
      { roomType: 'Suite', count: 1, roomTotal: '360000.00', nights: 2 },
    ]);
  });

  it('text filters ignore case, and an empty cell never matches a comparison', async () => {
    const result = await service.run(TENANT_ID, BRANCH_ID, { ...base, fields: ['guestName', 'company'], filters: [{ field: 'company', operator: 'contains', value: 'DANGOTE' }] });
    expect(result.rows).toEqual([{ guestName: 'Ada Obi', company: 'Dangote Group' }]);
  });

  it('the CSV has every row, quoted only where a cell needs it', async () => {
    const csv = await service.runCsv(TENANT_ID, BRANCH_ID, { ...base, fields: ['guestName', 'company'] });
    expect(csv.split('\n')).toEqual(['Guest,Company', 'Ada Obi,Dangote Group', 'Bayo Ade,', 'Chi Eze,']);
  });

  it('the guests list is this property’s guests only — not every guest of the group', async () => {
    await service.run(TENANT_ID, BRANCH_ID, { ...base, dataset: 'guests', fields: ['name', 'email'] });
    expect(tx.guestProfile.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ reservations: { some: { branchId: BRANCH_ID } } }) }));
  });

  it('refuses a range that ends before it starts', async () => {
    await expect(service.run(TENANT_ID, BRANCH_ID, { ...base, from: '2026-10-05', to: '2026-10-01', fields: ['guestName'] })).rejects.toThrow(/end date must be after/);
  });

  it('saves a report under its name — the same name replaces it', async () => {
    await service.saveTemplate(TENANT_ID, BRANCH_ID, ' Corporate stays ', { dataset: 'reservations', fields: ['company', 'roomTotal'], groupBy: 'company' }, 'user-1');
    expect(tx.reportTemplate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { branchId_name: { branchId: BRANCH_ID, name: 'Corporate stays' } },
        update: { definition: expect.objectContaining({ dataset: 'reservations', groupBy: 'company', filters: [] }) },
      }),
    );
  });
});
