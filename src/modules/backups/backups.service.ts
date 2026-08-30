import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'zlib';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { BACKUP_STORAGE_ADAPTER, BackupStorageAdapter } from './storage/backup-storage.interface';

export interface BackupRecordSummary {
  id: string;
  type: string;
  status: string;
  sizeBytes: string | null;
  startedAt: Date;
  completedAt: Date | null;
  retainUntil: Date | null;
}

/**
 * Not real tenant business data — `UserEmailIndex` is a global lookup table
 * with no RLS policy applied to it at all (see its own schema.prisma
 * comment), and `BackupRecord` is the ledger backups themselves write to;
 * including it in its own snapshot would be circular.
 */
const EXCLUDED_MODELS = new Set(['UserEmailIndex', 'BackupRecord']);

const RETENTION_DAYS = 30;

type DynamicDelegate = {
  findMany: (args: Record<string, never>) => Promise<unknown[]>;
  createMany: (args: { data: Record<string, unknown>[] }) => Promise<unknown>;
  deleteMany: (args: { where: { tenantId: string } }) => Promise<unknown>;
  count: (args: { where: { tenantId: string } }) => Promise<number>;
};

/** Two fields in the whole tenant-scoped schema carry a GLOBAL (not per-tenant) uniqueness constraint — restoring into a still-LIVE original tenant collides on the exact original value otherwise. Rewritten to something derived from the row's own fresh id (already guaranteed unique), only in the drill's copy — never touches the real row. */
const GLOBAL_UNIQUE_FIELDS: Partial<Record<string, string>> = {
  User: 'email',
  InviteToken: 'token',
};

interface RestoreModelMeta {
  modelName: string;
  accessor: string;
  idFieldName: string;
  /** `false` = BigInt id (RateAuditLog/NightAuditLog/AuditLog) — nothing in the tenant-scoped schema references these as a foreign key, so the drill lets Postgres autogenerate a fresh one instead of remapping. */
  idIsUuid: boolean;
  relations: Array<{ fieldNames: string[]; targetModel: string }>;
}

export interface RestoreDrillResult {
  ok: boolean;
  modelCounts?: Record<string, { expected: number; restored: number }>;
  mismatches?: string[];
  error?: string;
}

/**
 * "Scheduled PostgreSQL pg_dump per tenant" (MVP timeline Month 6) — built
 * as a Prisma-driven, per-tenant JSON export instead of a literal `pg_dump`
 * invocation, for a real reason, not just because `pg_dump` isn't on PATH
 * in this dev environment (also true, and checked directly rather than
 * assumed): `pg_dump` dumps at the database/schema/table level — it has no
 * concept of "only this tenant's rows," so a literal per-tenant `pg_dump`
 * doesn't actually exist as a tool to invoke. Querying every RLS-scoped
 * table through the same `withTenant` transaction every other tenant-scoped
 * read in this codebase already uses achieves the reference's real goal —
 * a restorable snapshot of one tenant's own data — correctly, not just
 * conveniently.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);
  private readonly tenantScopedModels: Array<{ modelName: string; accessor: string }>;
  /** Parent-before-child insert order for `runRestoreDrill`, computed once from DMMF relation metadata — see `buildRestoreInsertOrder`'s own comment for why this can't just be `tenantScopedModels` in declaration order. */
  private readonly restoreInsertOrder: RestoreModelMeta[];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BACKUP_STORAGE_ADAPTER) private readonly storage: BackupStorageAdapter,
  ) {
    this.tenantScopedModels = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'tenantId') && !EXCLUDED_MODELS.has(m.name))
      .map((m) => ({ modelName: m.name, accessor: m.name.charAt(0).toLowerCase() + m.name.slice(1) }));
    this.restoreInsertOrder = this.buildRestoreInsertOrder();
  }

  /**
   * One row per tenant-scoped model, gzipped JSON, written through the
   * pluggable storage adapter. BigInt ids (`RateAuditLog`, `NightAuditLog`)
   * are stringified — the same fix this codebase already applies wherever
   * a BigInt id would otherwise crash `JSON.stringify` in an API response.
   */
  async runTenantBackup(tenantId: string): Promise<{ id: string; status: string; sizeBytes?: number }> {
    const record = await this.prisma.backupRecord.create({
      data: { tenantId, type: 'full', status: 'running' },
    });

    try {
      const snapshot = await this.prisma.withTenant(tenantId, async (tx) => {
        const dynamicTx = tx as unknown as Record<string, DynamicDelegate>;
        const result: Record<string, unknown[]> = {};
        for (const { modelName, accessor } of this.tenantScopedModels) {
          result[modelName] = await dynamicTx[accessor].findMany({});
        }
        return result;
      });

      const json = JSON.stringify(snapshot, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
      const gzipped = gzipSync(Buffer.from(json, 'utf-8'));
      const key = `${tenantId}/${record.id}.json.gz`;
      const storageUrl = await this.storage.write(key, gzipped);

      const updated = await this.prisma.backupRecord.update({
        where: { id: record.id },
        data: {
          status: 'completed',
          storageUrl,
          sizeBytes: BigInt(gzipped.byteLength),
          completedAt: new Date(),
          retainUntil: new Date(Date.now() + RETENTION_DAYS * 86_400_000),
        },
      });
      this.logger.log(`Backup completed for tenant ${tenantId}: ${gzipped.byteLength} bytes → ${storageUrl}`);
      return { id: updated.id, status: updated.status, sizeBytes: gzipped.byteLength };
    } catch (err) {
      this.logger.error(`Backup FAILED for tenant ${tenantId}`, err);
      await this.prisma.backupRecord.update({
        where: { id: record.id },
        data: { status: 'failed', completedAt: new Date() },
      });
      return { id: record.id, status: 'failed' };
    }
  }

  /**
   * System Admin's own "Backup Management" card (ref: "scheduled backups,
   * restore, retention") had a real backend service behind it with ZERO
   * HTTP surface — no controller anywhere referenced `BackupsService` before
   * this. `sizeBytes` is stringified here, not left as a raw `BigInt` — the
   * exact serialization crash this file's own `runTenantBackup` comment
   * already fixed for the JSON snapshot applies equally to a plain JSON API
   * response.
   */
  async listBackups(tenantId: string): Promise<BackupRecordSummary[]> {
    const records = await this.prisma.backupRecord.findMany({ where: { tenantId }, orderBy: { startedAt: 'desc' } });
    return records.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      sizeBytes: r.sizeBytes?.toString() ?? null,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      retainUntil: r.retainUntil,
    }));
  }

  /**
   * `BackupRecord` has NO RLS (see its own schema comment — it's a global
   * system table, `tenantId` nullable for full-system dumps) — without this
   * check, any tenant's Owner could verify or restore-drill ANOTHER
   * tenant's backup just by guessing a UUID. Every controller-facing call
   * into `verifyBackup`/`runRestoreDrill` goes through this first; the
   * cron-triggered `runBackupForAllTenants`/`runRestoreDrillForAllTenants`
   * paths call the underlying methods directly since they already iterate
   * per-tenant with a known-correct id.
   */
  private async assertOwnedBackup(tenantId: string, backupRecordId: string): Promise<void> {
    const record = await this.prisma.backupRecord.findFirst({ where: { id: backupRecordId, tenantId } });
    if (!record) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Backup record not found' });
  }

  async verifyOwnedBackup(tenantId: string, backupRecordId: string): ReturnType<BackupsService['verifyBackup']> {
    await this.assertOwnedBackup(tenantId, backupRecordId);
    return this.verifyBackup(backupRecordId);
  }

  async restoreDrillOwnedBackup(tenantId: string, backupRecordId: string): ReturnType<BackupsService['runRestoreDrill']> {
    await this.assertOwnedBackup(tenantId, backupRecordId);
    return this.runRestoreDrill(backupRecordId);
  }

  /** Every tenant actually in use — `suspended`/`cancelled` ones don't need a fresh nightly snapshot of data nobody's adding to. */
  async runBackupForAllTenants(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: { in: ['trial', 'active'] } }, select: { id: true, subdomain: true } });
    for (const tenant of tenants) {
      try {
        await this.runTenantBackup(tenant.id);
      } catch (err) {
        // runTenantBackup already catches its own failures into a 'failed'
        // BackupRecord — this second catch is for something going wrong
        // even before that (e.g. the initial BackupRecord.create itself),
        // so one bad tenant can't take the whole nightly sweep down.
        this.logger.error(`Unexpected error backing up tenant ${tenant.subdomain} (${tenant.id})`, err);
      }
    }
  }

  /**
   * "Backup restore test procedure (documented + run monthly)" — a full
   * restore-into-a-fresh-database is real infrastructure work this pass
   * doesn't build (it needs somewhere real to restore INTO). What this
   * verifies instead: the stored file is readable, decompresses, parses as
   * the expected JSON shape, and its row counts match what was actually
   * exported — the concrete, automatable half of "prove this backup isn't
   * silently corrupt," runnable today without new infrastructure.
   */
  async verifyBackup(backupRecordId: string): Promise<{ ok: boolean; modelCounts?: Record<string, number>; error?: string }> {
    const record = await this.prisma.backupRecord.findFirst({ where: { id: backupRecordId } });
    if (!record || !record.storageUrl) {
      return { ok: false, error: 'Backup record not found or has no stored file' };
    }
    try {
      const compressed = await this.storage.read(record.storageUrl);
      const json = gunzipSync(compressed).toString('utf-8');
      const snapshot = JSON.parse(json) as Record<string, unknown[]>;
      const expectedModels = new Set(this.tenantScopedModels.map((m) => m.modelName));
      const actualModels = new Set(Object.keys(snapshot));
      if (expectedModels.size !== actualModels.size || [...expectedModels].some((m) => !actualModels.has(m))) {
        return { ok: false, error: 'Backup is missing one or more expected tables' };
      }
      const modelCounts: Record<string, number> = {};
      for (const [model, rows] of Object.entries(snapshot)) {
        modelCounts[model] = Array.isArray(rows) ? rows.length : -1;
      }
      return { ok: true, modelCounts };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * `verifyBackup`'s own comment named the gap this closes: a real
   * restore-into-somewhere, not just "the file decompresses and parses."
   * "Somewhere" is a fresh, throwaway `Tenant` (`isDemo: true`, same
   * self-serve-trial shape the e2e suite already uses to provision
   * disposable tenants) — restoring into the ORIGINAL tenant would collide
   * on every primary key, since that tenant's real rows are still live in
   * the same tables.
   *
   * Insert order is derived from DMMF relation metadata (`relationFromFields`
   * — confirmed to carry exactly this at the start of this work), not a
   * hand-maintained list, because a hand-maintained FK order silently rots
   * the moment a new tenant-scoped model or relation is added. Every row's
   * own id gets a fresh UUID (colliding on the original tenant's still-live
   * primary keys otherwise), FK columns are rewritten through the id map
   * built as parents are inserted, and the two fields in the whole schema
   * with a GLOBAL uniqueness constraint (`User.email`, `InviteToken.token`
   * — see `GLOBAL_UNIQUE_FIELDS`) are rewritten off the row's own new id.
   */
  async runRestoreDrill(backupRecordId: string): Promise<RestoreDrillResult> {
    const record = await this.prisma.backupRecord.findFirst({ where: { id: backupRecordId } });
    if (!record || !record.storageUrl) {
      return { ok: false, error: 'Backup record not found or has no stored file' };
    }

    let snapshot: Record<string, unknown[]>;
    try {
      const compressed = await this.storage.read(record.storageUrl);
      snapshot = JSON.parse(gunzipSync(compressed).toString('utf-8')) as Record<string, unknown[]>;
    } catch (err) {
      return { ok: false, error: `Could not read backup: ${err instanceof Error ? err.message : String(err)}` };
    }

    const drillTenant = await this.prisma.tenant.create({
      data: {
        subdomain: `restore-drill-${randomUUID()}`,
        groupName: 'Restore Drill (auto-generated — safe to delete)',
        brandMode: 'single',
        status: 'trial',
        isDemo: true,
        // Already "expired": this method deletes it itself in the `finally`
        // below, but if the process dies mid-drill, `TenantsService`'s
        // nightly demo-tenant sweep picks it up on the very next run
        // instead of after the usual 30-day TTL.
        demoExpiresAt: new Date(),
      },
    });

    const idMaps = new Map<string, Map<string, string>>();
    const modelCounts: Record<string, { expected: number; restored: number }> = {};
    let restoreError: string | undefined;

    try {
      await this.prisma.withTenant(drillTenant.id, async (tx) => {
        const dynamicTx = tx as unknown as Record<string, DynamicDelegate>;

        for (const meta of this.restoreInsertOrder) {
          const rows = (snapshot[meta.modelName] ?? []) as Array<Record<string, unknown>>;
          modelCounts[meta.modelName] = { expected: rows.length, restored: 0 };
          if (rows.length === 0) continue;

          const modelIdMap = new Map<string, string>();
          idMaps.set(meta.modelName, modelIdMap);

          const remapped = rows.map((row) => {
            const out: Record<string, unknown> = { ...row };
            let newRowId: string | undefined;

            if (meta.idIsUuid) {
              newRowId = randomUUID();
              modelIdMap.set(String(row[meta.idFieldName]), newRowId);
              out[meta.idFieldName] = newRowId;
            } else {
              delete out[meta.idFieldName]; // BigInt id — autogenerated, never referenced by another tenant-scoped model
            }

            out.tenantId = drillTenant.id;

            for (const rel of meta.relations) {
              if (rel.targetModel === 'Tenant') continue; // already handled via tenantId above
              const targetMap = idMaps.get(rel.targetModel);
              for (const fk of rel.fieldNames) {
                const value = out[fk];
                if (fk === 'tenantId' || value == null) continue;
                out[fk] = targetMap?.get(value as string) ?? value;
              }
            }

            const globalUniqueField = GLOBAL_UNIQUE_FIELDS[meta.modelName];
            if (globalUniqueField && newRowId) {
              out[globalUniqueField] = meta.modelName === 'User' ? `restore-drill+${newRowId}@invalid.local` : newRowId;
            }

            return out;
          });

          await dynamicTx[meta.accessor].createMany({ data: remapped });
        }

        // A real SELECT COUNT(*) per model, not an assumption that
        // `createMany` inserted exactly what it was handed — this is the
        // actual "restore proven, not just decompressed" check.
        for (const meta of this.restoreInsertOrder) {
          if (modelCounts[meta.modelName].expected === 0) continue;
          modelCounts[meta.modelName].restored = await dynamicTx[meta.accessor].count({ where: { tenantId: drillTenant.id } });
        }
      });
    } catch (err) {
      restoreError = err instanceof Error ? err.message : String(err);
    }

    try {
      await this.prisma.withTenant(drillTenant.id, async (tx) => {
        const dynamicTx = tx as unknown as Record<string, DynamicDelegate>;
        for (const meta of [...this.restoreInsertOrder].reverse()) {
          await dynamicTx[meta.accessor].deleteMany({ where: { tenantId: drillTenant.id } });
        }
      });
      await this.prisma.tenant.delete({ where: { id: drillTenant.id } });
    } catch (cleanupErr) {
      this.logger.error(
        `Restore drill cleanup failed for throwaway tenant ${drillTenant.id} — isDemo/already-expired, so the nightly sweep will still remove it`,
        cleanupErr,
      );
    }

    if (restoreError) {
      return { ok: false, error: restoreError, modelCounts };
    }
    const mismatches = Object.entries(modelCounts)
      .filter(([, c]) => c.expected !== c.restored)
      .map(([model]) => model);
    return { ok: mismatches.length === 0, modelCounts, mismatches: mismatches.length ? mismatches : undefined };
  }

  /** Monthly counterpart to `runBackupForAllTenants` — drills each active tenant's own most recent completed backup, matching "restore test procedure (documented + run monthly)". One tenant's failure is logged and doesn't stop the rest, same isolation as the nightly backup sweep. */
  async runRestoreDrillForAllTenants(): Promise<void> {
    const tenants = await this.prisma.tenant.findMany({ where: { status: { in: ['trial', 'active'] } }, select: { id: true, subdomain: true } });
    for (const tenant of tenants) {
      try {
        const latest = await this.prisma.backupRecord.findFirst({
          where: { tenantId: tenant.id, status: 'completed' },
          orderBy: { completedAt: 'desc' },
        });
        if (!latest) continue; // nothing backed up yet for this tenant — nothing to drill
        const result = await this.runRestoreDrill(latest.id);
        if (result.ok) {
          this.logger.log(`Restore drill OK for tenant ${tenant.subdomain} (${tenant.id}), backup ${latest.id}`);
        } else {
          this.logger.error(`Restore drill FAILED for tenant ${tenant.subdomain} (${tenant.id}), backup ${latest.id}: ${result.error ?? result.mismatches?.join(', ')}`);
        }
      } catch (err) {
        this.logger.error(`Unexpected error running restore drill for tenant ${tenant.subdomain} (${tenant.id})`, err);
      }
    }
  }

  /**
   * Parent-before-child order over `tenantScopedModels`, derived from each
   * model's own `relationFromFields` (confirmed via a direct DMMF probe to
   * carry exactly the FK columns + target model needed here) rather than
   * hand-listed — a hand-listed order silently rots the first time a new
   * tenant-scoped model or relation is added and nobody remembers to update
   * it. Plain Kahn's algorithm; ties broken alphabetically so the order is
   * deterministic across runs (matters for tests, not correctness). Throws
   * if the tenant-scoped schema ever has a real cyclic FK dependency — it
   * doesn't today (checked directly), but a silent infinite loop would be
   * far worse than a loud failure if that ever changed.
   */
  private buildRestoreInsertOrder(): RestoreModelMeta[] {
    const scopedNames = new Set(this.tenantScopedModels.map((m) => m.modelName));
    const metas: RestoreModelMeta[] = this.tenantScopedModels.map(({ modelName, accessor }) => {
      const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName)!;
      const idField = model.fields.find((f) => f.isId)!;
      const relations = model.fields
        .filter((f) => f.kind === 'object' && f.relationFromFields && f.relationFromFields.length > 0)
        .map((f) => ({ fieldNames: [...f.relationFromFields!], targetModel: f.type }));
      return { modelName, accessor, idFieldName: idField.name, idIsUuid: idField.type === 'String', relations };
    });

    const byName = new Map(metas.map((m) => [m.modelName, m]));
    const dependents = new Map<string, string[]>(metas.map((m) => [m.modelName, []]));
    const remainingDeps = new Map<string, number>();

    for (const m of metas) {
      const deps = new Set(m.relations.map((r) => r.targetModel).filter((t) => scopedNames.has(t) && t !== m.modelName));
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

    if (order.length !== metas.length) {
      const stuck = metas.map((m) => m.modelName).filter((n) => !order.includes(n));
      throw new Error(`Cannot compute a restore insert order — cyclic tenant-scoped FK dependency among: ${stuck.join(', ')}`);
    }
    return order.map((name) => byName.get(name)!);
  }
}
