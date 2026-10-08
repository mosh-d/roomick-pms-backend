import { Prisma } from '@prisma/client';

/**
 * Every table that belongs to a tenant, read off the Prisma schema itself so
 * the list can't go stale when a model is added. Two tables carry a
 * `tenantId` but aren't a tenant's own data: the sign-in email index (a
 * lookup that exists so a sign-in can find its tenant) and the backup
 * records (a system table). Used by backups (what to dump, in what order to
 * restore) and by deleting an organisation (the same order, reversed).
 */
export const NOT_TENANT_DATA: ReadonlySet<string> = new Set(['UserEmailIndex', 'BackupRecord']);

export interface TenantModel {
  modelName: string;
  /** The Prisma client property: `GuestProfile` → `guestProfile`. */
  accessor: string;
}

export interface TenantModelMeta extends TenantModel {
  idFieldName: string;
  idIsUuid: boolean;
  /** Scalar string fields with a global unique constraint — rewritten on restore so a copy can sit beside the original. */
  globalUniqueFields: string[];
  /** Foreign keys to other tenant tables, by column, with the model they point at. */
  relations: Array<{ fieldNames: string[]; targetModel: string }>;
  /** Optional foreign keys taken off `relations` to break a cycle — written after every row exists, and cut before anything is deleted. */
  deferred: Array<{ fieldNames: string[]; targetModel: string }>;
}

export function tenantScopedModels(): TenantModel[] {
  return Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'tenantId') && !NOT_TENANT_DATA.has(m.name))
    .map((m) => ({ modelName: m.name, accessor: m.name.charAt(0).toLowerCase() + m.name.slice(1) }));
}

/**
 * Parent-before-child order over the tenant tables, derived from each
 * model's own `relationFromFields` rather than hand-listed — a hand-listed
 * order silently rots the first time a new tenant-scoped model or relation is
 * added and nobody remembers to update it. Plain Kahn's algorithm; ties
 * broken alphabetically so the order is deterministic across runs.
 *
 * **A cycle is broken on an optional FK** — `Reservation.billToFolioId` (a
 * group's master bill) points at a Folio whose own `reservationId` points
 * back. When the order sticks, an optional FK that lies on the cycle is
 * deferred: its rows go in with it empty and it's filled in once every row
 * exists. A cycle with no optional FK to break it still throws — a silent
 * infinite loop would be far worse than a loud failure.
 */
export function tenantModelInsertOrder(): TenantModelMeta[] {
  const scoped = tenantScopedModels();
  const scopedNames = new Set(scoped.map((m) => m.modelName));
  const optionalField = new Map<string, boolean>();
  const metas: TenantModelMeta[] = scoped.map(({ modelName, accessor }) => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName)!;
    const idField = model.fields.find((f) => f.isId)!;
    for (const f of model.fields) optionalField.set(`${modelName}.${f.name}`, !f.isRequired);
    const relations = model.fields
      .filter((f) => f.kind === 'object' && f.relationFromFields && f.relationFromFields.length > 0)
      .map((f) => ({ fieldNames: [...f.relationFromFields!], targetModel: f.type }));
    // A unique foreign key needs no rewrite — it's remapped to a fresh row's id like any other.
    const foreignKeys = new Set(relations.flatMap((r) => r.fieldNames));
    const globalUniqueFields = model.fields
      .filter((f) => f.kind === 'scalar' && f.isUnique && !f.isId && f.type === 'String' && !foreignKeys.has(f.name))
      .map((f) => f.name);
    return { modelName, accessor, idFieldName: idField.name, idIsUuid: idField.type === 'String', globalUniqueFields, relations, deferred: [] };
  });
  const byName = new Map(metas.map((m) => [m.modelName, m]));
  const dependsOn = (m: TenantModelMeta) => new Set(m.relations.map((r) => r.targetModel).filter((t) => scopedNames.has(t) && t !== m.modelName));

  for (;;) {
    const dependents = new Map<string, string[]>(metas.map((m) => [m.modelName, []]));
    const remainingDeps = new Map<string, number>();
    for (const m of metas) {
      const deps = dependsOn(m);
      remainingDeps.set(m.modelName, deps.size);
      for (const dep of deps) dependents.get(dep)!.push(m.modelName);
    }

    const ready = metas.filter((m) => remainingDeps.get(m.modelName) === 0).map((m) => m.modelName);
    const order: string[] = [];
    while (ready.length > 0) {
      ready.sort();
      const name = ready.shift()!;
      order.push(name);
      for (const dependent of dependents.get(name)!) {
        const remaining = remainingDeps.get(dependent)! - 1;
        remainingDeps.set(dependent, remaining);
        if (remaining === 0) ready.push(dependent);
      }
    }
    if (order.length === metas.length) return order.map((name) => byName.get(name)!);

    // Stuck: defer one optional FK that lies on a cycle — from A to B where B depends (in turn) on A.
    const stuck = new Set(metas.map((m) => m.modelName).filter((n) => !order.includes(n)));
    const reaches = (from: string, to: string): boolean => {
      const seen = new Set<string>();
      const queue = [from];
      while (queue.length > 0) {
        const name = queue.shift()!;
        if (name === to) return true;
        if (seen.has(name) || !stuck.has(name)) continue;
        seen.add(name);
        queue.push(...dependsOn(byName.get(name)!));
      }
      return false;
    };
    const candidates = metas
      .filter((m) => stuck.has(m.modelName))
      .flatMap((m) =>
        m.relations
          .filter((r) => stuck.has(r.targetModel) && r.targetModel !== m.modelName)
          .filter((r) => r.fieldNames.every((f) => optionalField.get(`${m.modelName}.${f}`)))
          .filter((r) => reaches(r.targetModel, m.modelName))
          .map((r) => ({ meta: m, relation: r, key: `${m.modelName}.${r.fieldNames.join(',')}` })),
      )
      .sort((a, b) => a.key.localeCompare(b.key));
    const breaker = candidates[0];
    if (!breaker) {
      throw new Error(`Cannot compute an order over the tenant tables — cyclic FK dependency among: ${[...stuck].join(', ')}`);
    }
    breaker.meta.relations = breaker.meta.relations.filter((r) => r !== breaker.relation);
    breaker.meta.deferred.push(breaker.relation);
  }
}
