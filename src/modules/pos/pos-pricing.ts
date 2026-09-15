import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ChargeType, OutletCategory, Prisma } from '@prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * The DB architecture doc's own mapping, applied once at outlet creation: an
 * outlet's category decides the charge type stamped on everything it sells,
 * so no bartender or waiter ever picks one.
 */
export const OUTLET_CHARGE_TYPES: Record<OutletCategory, ChargeType> = {
  restaurant: 'fnb',
  bar: 'fnb',
  room_service: 'fnb',
  spa: 'spa',
  laundry: 'laundry',
  retail: 'misc',
};

// Type aliases rather than interfaces: they're written straight into JSON
// columns, and only an alias is assignable to Prisma's JSON input type.

/** A menu item's modifier groups, as stored in `MenuItem.modifiers`. */
export type ModifierGroup = {
  name: string;
  selection: 'single' | 'multi';
  required: boolean;
  options: Array<{ label: string; price: number }>;
};

export type PricedModifier = {
  group: string;
  label: string;
  price: string;
};

/** One line of an order, priced — also exactly what's snapshotted into `PosOrder.items`. */
export type PricedLine = {
  menuItemId: string;
  name: string;
  qty: number;
  unitPrice: string;
  modifiers: PricedModifier[];
  lineTotal: string;
};

export type PricedOrder = {
  lines: PricedLine[];
  subtotal: Prisma.Decimal;
};

type PriceableItem = { id: string; name: string; price: Prisma.Decimal; isAvailable: boolean; modifiers: Prisma.JsonValue | null };
type RequestedLine = { menuItemId: string; qty: number; modifiers?: Array<{ group: string; options: string[] }> };

export function parseModifierGroups(value: Prisma.JsonValue | null): ModifierGroup[] {
  return Array.isArray(value) ? (value as unknown as ModifierGroup[]) : [];
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

/**
 * Checks a menu item's modifier groups before they're saved. The terminal and
 * `priceOrder` both find groups and options by name, so a duplicate would
 * leave one of them unreachable. Returns plain JSON for the column.
 */
export function normaliseModifierGroups(groups: ModifierGroup[]): ModifierGroup[] {
  const groupNames = new Set<string>();
  return groups.map((group) => {
    const name = group.name.trim();
    if (!name) throw invalid('Every choice needs a name');
    if (groupNames.has(name.toLowerCase())) throw invalid(`There are two choices called "${name}"`);
    groupNames.add(name.toLowerCase());

    const labels = new Set<string>();
    const options = group.options.map((option) => {
      const label = option.label.trim();
      if (!label) throw invalid(`Every "${name}" option needs a label`);
      if (labels.has(label.toLowerCase())) throw invalid(`"${name}" lists "${label}" twice`);
      labels.add(label.toLowerCase());
      return { label, price: option.price };
    });
    return { name, selection: group.selection, required: group.required, options };
  });
}

/**
 * Prices a basket from the outlet's own menu. The server's figure, never the
 * terminal's — the rule the Rate Resolver set for room rates ("the frontend
 * never calculates a price"). Every choice is checked against the item's own
 * modifier groups, so a request can't invent an option, pick two where one is
 * allowed, or skip a required one. Money in `Prisma.Decimal` throughout.
 */
export function priceOrder(menuItems: PriceableItem[], requested: RequestedLine[]): PricedOrder {
  const byId = new Map(menuItems.map((item) => [item.id, item]));
  const lines: PricedLine[] = [];
  let subtotal = new Prisma.Decimal(0);

  for (const line of requested) {
    const item = byId.get(line.menuItemId);
    if (!item) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: "An item in this order isn't on this outlet's menu" });
    }
    if (!item.isAvailable) {
      throw new ConflictException({ code: ErrorCode.CONFLICT, message: `${item.name} isn't available right now` });
    }

    const groups = parseModifierGroups(item.modifiers);
    const chosen = line.modifiers ?? [];
    for (const choice of chosen) {
      if (!groups.some((g) => g.name === choice.group)) throw invalid(`${item.name} has no "${choice.group}" choice`);
    }

    let unitPrice = new Prisma.Decimal(item.price);
    const modifiers: PricedModifier[] = [];
    for (const group of groups) {
      const picked = [...new Set(chosen.find((c) => c.group === group.name)?.options ?? [])];
      const groupName = group.name.toLowerCase();
      if (group.required && picked.length === 0) throw invalid(`Choose a ${groupName} for ${item.name}`);
      if (group.selection === 'single' && picked.length > 1) throw invalid(`Choose only one ${groupName} for ${item.name}`);
      for (const label of picked) {
        const option = group.options.find((o) => o.label === label);
        if (!option) throw invalid(`"${label}" isn't a ${groupName} option for ${item.name}`);
        const price = new Prisma.Decimal(option.price);
        unitPrice = unitPrice.plus(price);
        modifiers.push({ group: group.name, label: option.label, price: price.toFixed(2) });
      }
    }

    const lineTotal = unitPrice.mul(line.qty);
    subtotal = subtotal.plus(lineTotal);
    lines.push({ menuItemId: item.id, name: item.name, qty: line.qty, unitPrice: unitPrice.toFixed(2), modifiers, lineTotal: lineTotal.toFixed(2) });
  }

  return { lines, subtotal };
}
