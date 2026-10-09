import { ChargeType, Prisma } from '@prisma/client';

/**
 * Packages sold with a stay — breakfast, an airport transfer — and how they
 * price. Pure functions: what a package costs comes from its snapshot on the
 * stay (the price when it was added), the nights and who is staying.
 */
export const PACKAGE_BASES = ['per_night', 'per_stay', 'per_person_per_night'] as const;
export type PackageBasis = (typeof PACKAGE_BASES)[number];

/** A package as a stay holds it: priced when it was added, so a later price change doesn't reach it. */
export interface PackageSnapshot {
  packageId: string;
  name: string;
  /** Before tax, per `basis`. */
  price: string;
  basis: PackageBasis;
  chargeType: ChargeType;
  /**
   * The hotel date it was added to a stay already under way (YYYY-MM-DD):
   * nights before it aren't charged for it. Absent when it came with the
   * booking, or was added before the stay began.
   */
  addedOn?: string;
}

export function parsePackageSnapshots(value: Prisma.JsonValue | null | undefined): PackageSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is PackageSnapshot & Prisma.JsonObject =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).packageId === 'string' &&
      typeof (entry as Record<string, unknown>).price === 'string' &&
      PACKAGE_BASES.includes((entry as Record<string, unknown>).basis as PackageBasis),
  );
}

/** What one posting of a package comes to: once a night (per person, for a per-person package), or once for the stay. */
export function chargePerPosting(pkg: PackageSnapshot, guests: number): Prisma.Decimal {
  const price = new Prisma.Decimal(pkg.price);
  return pkg.basis === 'per_person_per_night' ? price.mul(Math.max(1, guests)) : price;
}

/** How many times a package posts over a stay: each night, or once. A day-use stay's day counts as its one night. */
export function postingsFor(pkg: PackageSnapshot, nights: number): number {
  return pkg.basis === 'per_stay' ? 1 : Math.max(0, nights);
}

/** A package's whole charge for a stay, before tax. */
export function packageTotal(pkg: PackageSnapshot, nights: number, guests: number): Prisma.Decimal {
  return chargePerPosting(pkg, guests).mul(postingsFor(pkg, nights));
}
