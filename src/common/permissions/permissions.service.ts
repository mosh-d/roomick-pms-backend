import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionMap, parsePermissions } from './permission-catalogue';

export interface RoleGrant {
  id: string;
  name: string;
  isSystem: boolean;
  permissions: PermissionMap;
}

/**
 * A role's permissions can't be read from the token: it carries role names,
 * and changing what a role may do must not wait for everyone's token to
 * expire. So they're read from the database — behind a short cache, because
 * otherwise every authorised request would pay a query.
 *
 * The cache is cleared outright whenever a role is created, renamed, deleted
 * or re-scoped, so a change takes effect immediately in this process. The TTL
 * is the backstop for a second process that didn't see the write: a
 * permission taken away is gone within a minute, everywhere.
 */
const TTL_MS = 60_000;

@Injectable()
export class PermissionsService {
  private readonly cache = new Map<string, { loadedAt: number; byName: Map<string, RoleGrant> }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Every role in the tenant, by name — names are unique per tenant, and the token names them. */
  async rolesFor(tenantId: string): Promise<Map<string, RoleGrant>> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.byName;

    const roles = await this.prisma.withTenant(tenantId, (tx) => tx.role.findMany({ select: { id: true, name: true, isSystem: true, permissions: true } }));
    const byName = new Map<string, RoleGrant>();
    for (const role of roles) {
      byName.set(role.name, {
        id: role.id,
        name: role.name,
        isSystem: role.isSystem,
        // A row edited outside the app could hold anything; a map that won't
        // parse grants nothing rather than throwing on an unrelated request.
        permissions: safeParse(role.permissions),
      });
    }
    this.cache.set(tenantId, { loadedAt: Date.now(), byName });
    return byName;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}

function safeParse(value: unknown): PermissionMap {
  try {
    return parsePermissions(value);
  } catch {
    return {};
  }
}
