import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiKeyPrincipal, AuthenticatedRequest } from '../types/request-context';

/** `rk_` and 48 hex characters — the shape `IntegrationsService.createApiKey` hands out. */
const API_KEY_FORMAT = /^rk_[0-9a-f]{48}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How often `lastUsedAt` is written at most — a busy integration shouldn't turn every read into a write. */
const LAST_USED_GRANULARITY_MS = 60_000;

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/** The API key a request presents — `Authorization: Bearer rk_…` or `X-API-Key: rk_…` — or null when it presents none. */
export function presentedApiKey(request: AuthenticatedRequest): string | null {
  const bearer = /^Bearer\s+(rk_\S*)$/i.exec(request.header('authorization') ?? '');
  if (bearer) return bearer[1];
  const header = request.header('x-api-key')?.trim();
  return header ? header : null;
}

/**
 * Checks an API key. Keys belong to a tenant and live under its row-level
 * security, so the request names its tenant (`X-Tenant-ID`, as every signed-in
 * request already must) and the key is looked up there, by its hash.
 */
@Injectable()
export class ApiKeyAuthService {
  constructor(private readonly prisma: PrismaService) {}

  /** The key behind `rawKey` at this tenant, or null — unknown, revoked, malformed, or the account isn't open. */
  async authenticate(tenantId: string, rawKey: string): Promise<ApiKeyPrincipal | null> {
    if (!UUID.test(tenantId) || !API_KEY_FORMAT.test(rawKey)) return null;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
    if (!tenant || (tenant.status !== 'trial' && tenant.status !== 'active')) return null;

    const keyHash = hashApiKey(rawKey);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const key = await tx.apiKey.findFirst({ where: { keyHash, revokedAt: null }, select: { id: true, name: true, scopes: true, branchId: true } });
      if (!key) return null;
      const now = new Date();
      await tx.apiKey.updateMany({
        where: { id: key.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_GRANULARITY_MS) } }] },
        data: { lastUsedAt: now },
      });
      return key;
    });
  }
}
