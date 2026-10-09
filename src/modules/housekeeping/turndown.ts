import { Prisma } from '@prisma/client';

/** Who gets the evening turndown: every occupied room, or only VIP guests' rooms. */
export const TURNDOWN_SCOPES = ['all', 'vip'] as const;
export type TurndownScope = (typeof TURNDOWN_SCOPES)[number];

/** The housekeeping task kind a turndown is — the room is tidied for the night, not cleaned. */
export const TURNDOWN = 'turndown';

/** `Branch.turndownPolicy`, read defensively — `null` when the branch offers no turndown. */
export function turndownScopeFor(stored: Prisma.JsonValue | null | undefined): TurndownScope | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const scope = (stored as Record<string, unknown>).scope;
  return TURNDOWN_SCOPES.includes(scope as TurndownScope) ? (scope as TurndownScope) : null;
}

/** Whether a guest's room is turned down under the branch's scope — a VIP is any level from 1 up. */
export function wantsTurndown(scope: TurndownScope | null, vipLevel: number | null | undefined): boolean {
  if (scope === 'all') return true;
  return scope === 'vip' && (vipLevel ?? 0) >= 1;
}
