import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { PropertyService, timeStringToDate } from './property.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';
const BRAND_ID = '66666666-6666-4666-8666-666666666666';
const ACTOR = '44444444-4444-4444-8444-444444444444';

function makeTx() {
  return {
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: TENANT_ID, brandMode: 'multi' }) },
    brand: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: BRAND_ID }),
      findFirst: jest.fn().mockResolvedValue({ id: BRAND_ID }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ id: BRAND_ID }),
    },
    branch: {
      findFirst: jest.fn().mockResolvedValue({ id: BRANCH_ID }),
      create: jest.fn().mockResolvedValue({ id: BRANCH_ID }),
      update: jest.fn().mockResolvedValue({ id: BRANCH_ID }),
    },
    building: { findFirst: jest.fn(), create: jest.fn().mockResolvedValue({ id: 'bldg-default' }) },
    floor: { findFirst: jest.fn(), create: jest.fn().mockResolvedValue({ id: 'floor-default' }) },
    overbookingConfig: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'ob-1' }),
      update: jest.fn().mockResolvedValue({ id: 'ob-1' }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('PropertyService', () => {
  let service: PropertyService;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(async () => {
    tx = makeTx();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PropertyService,
        {
          provide: PrismaService,
          useValue: { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) },
        },
      ],
    }).compile();
    service = moduleRef.get(PropertyService);
  });

  it('timeStringToDate maps "14:00" to a 1970-01-01 TIME value', () => {
    expect(timeStringToDate('14:00').toISOString()).toBe('1970-01-01T14:00:00.000Z');
  });

  describe('createBrand', () => {
    it('single-brand tenants cannot create a second brand', async () => {
      tx.tenant.findUniqueOrThrow.mockResolvedValue({ id: TENANT_ID, brandMode: 'single' });
      tx.brand.count.mockResolvedValue(1);
      await expect(service.createBrand(TENANT_ID, { name: 'Second' }, ACTOR)).rejects.toThrow(
        ConflictException,
      );
    });

    it('multi-brand tenants can create many brands', async () => {
      tx.brand.count.mockResolvedValue(3);
      await service.createBrand(TENANT_ID, { name: 'Fourth' }, ACTOR);
      expect(tx.brand.create).toHaveBeenCalled();
    });
  });

  describe('createBranch', () => {
    const dto = {
      name: 'Lagos',
      address: { street: '1 Rd', city: 'Lagos', country: 'NG' },
      timezone: 'Africa/Lagos',
      currency: 'NGN',
      checkInTime: '15:00',
    };

    it('rejects invalid IANA timezones before touching the DB', async () => {
      await expect(
        service.createBranch(TENANT_ID, BRAND_ID, { ...dto, timezone: 'Mars/Olympus' }, ACTOR),
      ).rejects.toThrow(BadRequestException);
      expect(tx.branch.create).not.toHaveBeenCalled();
    });

    it('stores check-in time as a TIME value', async () => {
      await service.createBranch(TENANT_ID, BRAND_ID, dto, ACTOR);
      expect(tx.branch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ checkInTime: timeStringToDate('15:00') }),
        }),
      );
    });
  });

  describe('default structure (3-mode onboarding)', () => {
    it('creates the hidden default building+floor once and reuses them', async () => {
      tx.building.findFirst.mockResolvedValue(null); // no default yet
      tx.floor.findFirst.mockResolvedValue(null);

      const floor = await service.findOrCreateDefaultFloor(
        tx as never,
        TENANT_ID,
        BRANCH_ID,
      );

      expect(tx.building.create).toHaveBeenCalledWith({
        data: { tenantId: TENANT_ID, branchId: BRANCH_ID, name: null }, // name NULL = hidden
      });
      expect(tx.floor.create).toHaveBeenCalledWith({
        data: { tenantId: TENANT_ID, buildingId: 'bldg-default', floorNumber: 0, label: null },
      });
      expect(floor.id).toBe('floor-default');

      // Second call reuses the rows
      tx.building.findFirst.mockResolvedValue({ id: 'bldg-default' });
      tx.floor.findFirst.mockResolvedValue({ id: 'floor-default' });
      await service.findOrCreateDefaultFloor(tx as never, TENANT_ID, BRANCH_ID);
      expect(tx.building.create).toHaveBeenCalledTimes(1);
      expect(tx.floor.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateOverbookingConfig', () => {
    it('creates the branch-wide row (NULL roomTypeId) when absent', async () => {
      await service.updateOverbookingConfig(TENANT_ID, BRANCH_ID, { globalEnabled: true }, ACTOR);
      expect(tx.overbookingConfig.findFirst).toHaveBeenCalledWith({
        where: { branchId: BRANCH_ID, roomTypeId: null },
      });
      expect(tx.overbookingConfig.create).toHaveBeenCalled();
    });

    it('updates in place when the row exists', async () => {
      tx.overbookingConfig.findFirst.mockResolvedValue({ id: 'ob-1' });
      await service.updateOverbookingConfig(TENANT_ID, BRANCH_ID, { maxOverbookPct: 10 }, ACTOR);
      expect(tx.overbookingConfig.update).toHaveBeenCalled();
      expect(tx.overbookingConfig.create).not.toHaveBeenCalled();
    });
  });
});
