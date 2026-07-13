/**
 * Dev/staging seed — NEVER run in production (spec §2).
 *
 * Creates one demo tenant with the seeded system roles, an owner account,
 * a single brand + branch, a building/floor, room types, rooms, tax rules,
 * outlets and an overbooking config row — enough to exercise every P1/P2
 * endpoint manually.
 *
 * RLS note: every tenant-scoped write happens inside a transaction that sets
 * `app.tenant_id` first — the policies are FORCEd, so even the migration role
 * cannot write without tenant context. This seed doubles as a smoke test that
 * RLS is wired correctly.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const SYSTEM_ROLES = ['owner', 'manager', 'front_desk', 'housekeeper', 'accountant', 'pos_staff'];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database');
  }

  const existing = await prisma.tenant.findUnique({ where: { subdomain: 'demo' } });
  if (existing) {
    console.log('Demo tenant already seeded — nothing to do.');
    return;
  }

  // tenants has no RLS (root table) — created outside tenant context.
  const tenant = await prisma.tenant.create({
    data: {
      subdomain: 'demo',
      groupName: 'Demo Hotels Group',
      brandMode: 'single',
      status: 'active',
    },
  });

  const passwordHash = await bcrypt.hash('Demo!Password1', 12);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

    const roles = await Promise.all(
      SYSTEM_ROLES.map((name) =>
        tx.role.create({ data: { tenantId: tenant.id, name, isSystem: true } }),
      ),
    );
    const ownerRole = roles.find((r) => r.name === 'owner');
    if (!ownerRole) throw new Error('owner role missing');

    const owner = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: 'owner@demo.local',
        passwordHash,
        name: 'Demo Owner',
        emailVerified: true,
      },
    });

    // Single-brand mode: the brand row exists, the UI hides it (spec §1.1).
    const brand = await tx.brand.create({
      data: { tenantId: tenant.id, name: 'Demo Hotels' },
    });

    const branch = await tx.branch.create({
      data: {
        tenantId: tenant.id,
        brandId: brand.id,
        name: 'Demo Hotel Lagos',
        address: { street: '1 Marina Road', city: 'Lagos', state: 'Lagos', country: 'NG', zip: '101001' },
        timezone: 'Africa/Lagos',
        currency: 'NGN',
        category: 'hotel',
      },
    });

    // branchId NULL = owner role applies at every branch.
    await tx.userBranchRole.create({
      data: { tenantId: tenant.id, userId: owner.id, roleId: ownerRole.id, branchId: null },
    });

    // "Rooms Only" onboarding: hidden default building + floor (name/label NULL)
    // so room FKs always resolve (spec §1.1).
    const building = await tx.building.create({
      data: { tenantId: tenant.id, branchId: branch.id, name: null },
    });
    const floor = await tx.floor.create({
      data: { tenantId: tenant.id, buildingId: building.id, floorNumber: 0, label: null },
    });

    const standard = await tx.roomType.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        name: 'Standard Queen',
        baseRate: new Prisma.Decimal('45000.00'),
        capacity: { adults: 2, children: 1 },
        bedType: 'queen',
        amenities: ['wifi', 'ac', 'tv'],
        sortOrder: 1,
      },
    });
    const deluxe = await tx.roomType.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        name: 'Deluxe King',
        baseRate: new Prisma.Decimal('72000.00'),
        capacity: { adults: 2, children: 2 },
        bedType: 'king',
        amenities: ['wifi', 'ac', 'tv', 'minibar', 'bathtub'],
        sortOrder: 2,
      },
    });

    // Rooms 101–110 standard, 201–205 deluxe.
    const roomRows = [
      ...Array.from({ length: 10 }, (_, i) => ({ number: String(101 + i), roomTypeId: standard.id })),
      ...Array.from({ length: 5 }, (_, i) => ({ number: String(201 + i), roomTypeId: deluxe.id })),
    ];
    await tx.room.createMany({
      data: roomRows.map((r) => ({
        tenantId: tenant.id,
        branchId: branch.id,
        roomTypeId: r.roomTypeId,
        floorId: floor.id,
        number: r.number,
      })),
    });

    await tx.taxRule.createMany({
      data: [
        {
          tenantId: tenant.id,
          branchId: branch.id,
          name: 'VAT',
          rate: new Prisma.Decimal('0.0750'),
          type: 'percentage',
          appliesToChargeTypes: [],
        },
        {
          tenantId: tenant.id,
          branchId: branch.id,
          name: 'Service Charge',
          rate: new Prisma.Decimal('0.0500'),
          type: 'percentage',
          appliesToChargeTypes: ['room', 'fnb', 'spa'],
        },
      ],
    });

    await tx.outlet.createMany({
      data: [
        {
          tenantId: tenant.id,
          branchId: branch.id,
          name: 'Main Restaurant',
          category: 'restaurant',
          chargeType: 'fnb',
          sortOrder: 1,
        },
        {
          tenantId: tenant.id,
          branchId: branch.id,
          name: 'Poolside Bar',
          category: 'bar',
          chargeType: 'fnb',
          sortOrder: 2,
        },
        {
          tenantId: tenant.id,
          branchId: branch.id,
          name: 'Laundry',
          category: 'laundry',
          chargeType: 'laundry',
          sortOrder: 3,
        },
      ],
    });

    await tx.overbookingConfig.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        roomTypeId: null, // applies to all types
        globalEnabled: false,
      },
    });
  });

  console.log('Seeded demo tenant:');
  console.log(`  tenantId:  ${tenant.id}`);
  console.log('  subdomain: demo');
  console.log('  owner:     owner@demo.local / Demo!Password1');
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
