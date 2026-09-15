import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normaliseModifierGroups, OUTLET_CHARGE_TYPES, priceOrder } from './pos-pricing';

const SUYA = {
  id: 'item-suya',
  name: 'Beef suya',
  price: new Prisma.Decimal('6500'),
  isAvailable: true,
  modifiers: [
    { name: 'Heat', selection: 'single', required: true, options: [{ label: 'Mild', price: 0 }, { label: 'Hot', price: 0 }] },
    { name: 'Extras', selection: 'multi', required: false, options: [{ label: 'Extra onions', price: 200 }, { label: 'Extra meat', price: 1500 }] },
  ],
};
const WATER = { id: 'item-water', name: 'Water', price: new Prisma.Decimal('500'), isAvailable: true, modifiers: null };

describe('priceOrder', () => {
  it('adds modifier prices to the unit price, then multiplies by quantity', () => {
    const { lines, subtotal } = priceOrder(
      [SUYA, WATER],
      [
        { menuItemId: SUYA.id, qty: 2, modifiers: [{ group: 'Heat', options: ['Hot'] }, { group: 'Extras', options: ['Extra onions', 'Extra meat'] }] },
        { menuItemId: WATER.id, qty: 3 },
      ],
    );
    expect(lines[0]).toMatchObject({ name: 'Beef suya', qty: 2, unitPrice: '8200.00', lineTotal: '16400.00' });
    expect(lines[0].modifiers).toEqual([
      { group: 'Heat', label: 'Hot', price: '0.00' },
      { group: 'Extras', label: 'Extra onions', price: '200.00' },
      { group: 'Extras', label: 'Extra meat', price: '1500.00' },
    ]);
    expect(lines[1]).toMatchObject({ unitPrice: '500.00', lineTotal: '1500.00', modifiers: [] });
    expect(subtotal.toFixed(2)).toBe('17900.00');
  });

  it('adds money exactly, without floating-point drift', () => {
    const item = { ...WATER, price: new Prisma.Decimal('0.10'), modifiers: [{ name: 'Add', selection: 'multi', required: false, options: [{ label: 'A', price: 0.2 }] }] };
    const { subtotal } = priceOrder([item], [{ menuItemId: item.id, qty: 3, modifiers: [{ group: 'Add', options: ['A'] }] }]);
    expect(subtotal.toFixed(2)).toBe('0.90');
  });

  it('counts a repeated option once', () => {
    const { lines } = priceOrder(
      [SUYA],
      [{ menuItemId: SUYA.id, qty: 1, modifiers: [{ group: 'Heat', options: ['Mild'] }, { group: 'Extras', options: ['Extra meat', 'Extra meat'] }] }],
    );
    expect(lines[0].unitPrice).toBe('8000.00');
  });

  it('refuses a basket that skips a required choice', () => {
    expect(() => priceOrder([SUYA], [{ menuItemId: SUYA.id, qty: 1 }])).toThrow(BadRequestException);
  });

  it('refuses two options where only one is allowed', () => {
    expect(() => priceOrder([SUYA], [{ menuItemId: SUYA.id, qty: 1, modifiers: [{ group: 'Heat', options: ['Mild', 'Hot'] }] }])).toThrow(
      BadRequestException,
    );
  });

  it("refuses an option or a choice the item doesn't have", () => {
    expect(() => priceOrder([SUYA], [{ menuItemId: SUYA.id, qty: 1, modifiers: [{ group: 'Heat', options: ['Volcanic'] }] }])).toThrow(
      BadRequestException,
    );
    expect(() =>
      priceOrder([SUYA], [{ menuItemId: SUYA.id, qty: 1, modifiers: [{ group: 'Heat', options: ['Mild'] }, { group: 'Sauce', options: ['Ketchup'] }] }]),
    ).toThrow(BadRequestException);
  });

  it("refuses an 86'd item, and one that isn't on this outlet's menu", () => {
    expect(() => priceOrder([{ ...WATER, isAvailable: false }], [{ menuItemId: WATER.id, qty: 1 }])).toThrow(ConflictException);
    expect(() => priceOrder([WATER], [{ menuItemId: 'item-from-another-outlet', qty: 1 }])).toThrow(NotFoundException);
  });
});

describe('normaliseModifierGroups', () => {
  it('trims names and labels', () => {
    expect(normaliseModifierGroups([{ name: ' Size ', selection: 'single', required: true, options: [{ label: ' Large ', price: 500 }] }])).toEqual([
      { name: 'Size', selection: 'single', required: true, options: [{ label: 'Large', price: 500 }] },
    ]);
  });

  it('refuses duplicate choices and duplicate options, ignoring case', () => {
    const option = { label: 'Large', price: 0 };
    expect(() =>
      normaliseModifierGroups([
        { name: 'Size', selection: 'single', required: false, options: [option] },
        { name: 'size', selection: 'single', required: false, options: [option] },
      ]),
    ).toThrow(BadRequestException);
    expect(() =>
      normaliseModifierGroups([{ name: 'Size', selection: 'single', required: false, options: [option, { label: 'large', price: 100 }] }]),
    ).toThrow(BadRequestException);
  });
});

describe('OUTLET_CHARGE_TYPES', () => {
  it("follows the architecture doc's outlet → charge type mapping", () => {
    expect(OUTLET_CHARGE_TYPES).toEqual({ restaurant: 'fnb', bar: 'fnb', room_service: 'fnb', spa: 'spa', laundry: 'laundry', retail: 'misc' });
  });
});
