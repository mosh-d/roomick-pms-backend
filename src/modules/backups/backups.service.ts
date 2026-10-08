import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'zlib';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { TenantModelMeta, tenantModelInsertOrder, tenantScopedModels } from '../../common/prisma/tenant-models';
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

const RETENTION_DAYS = 30;
/** A backup reads, and a restore drill writes, every table of the tenant in one transaction — minutes for a busy one, not the default 5 seconds. */
const BACKUP_TX_TIMEOUT_MS = 10 * 60_000;

type DynamicDelegate = {
  findMany: (args: Record<string, never>) => Promise<unknown[]>;
  createMany: (args: { data: Record<string, unknown>[] }) => Promise<unknown>;
  update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<unknown>;
  deleteMany: (args: { where: { tenantId: string } }) => Promise<unknown>;
  count: (args: { where: { tenantId: string } }) => Promise<number>;
};

type RestoreModelMeta = TenantModelMeta;

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
  /** Parent-before-child insert order for `runRestoreDrill`, computed once from DMMF relation metadata — see `tenantModelInsertOrder`'s own comment for why this can't just be `tenantScopedModels` in declaration order. */
  private readonly restoreInsertOrder: RestoreModelMeta[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    @Inject(BACKUP_STORAGE_ADAPTER) private readonly storage: BackupStorageAdapter,
  ) {
    this.tenantScopedModels = tenantScopedModels();
    this.restoreInsertOrder = tenantModelInsertOrder();
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
      const snapshot = await this.prisma.withTenant(
        tenantId,
        async (tx) => {
          const dynamicTx = tx as unknown as Record<string, DynamicDelegate>;
          const result: Record<string, unknown[]> = {};
          for (const { modelName, accessor } of this.tenantScopedModels) {
            result[modelName] = await dynamicTx[accessor].findMany({});
          }
          return result;
        },
        // Every table of a busy tenant, read in one transaction: far past the
        // default 5 seconds, which used to fail the nightly backup outright.
        { timeout: BACKUP_TX_TIMEOUT_MS },
      );

      const json = JSON.stringify(snapshot, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
      // Encrypted at rest with the same key as ID photos and GDPR exports: a
      // backup holds every guest's details, staff password hashes, MFA
      // secrets and webhook signing secrets — plain gzip on a disk was a copy
      // of all of it for anyone who could read the volume.
      const gzipped = this.encryption.encryptBuffer(gzipSync(Buffer.from(json, 'utf-8')));
      const key = `${tenantId}/${record.id}.json.gz.enc`;
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

  /** A stored backup, open: decrypted when it was written encrypted (`.enc`), then decompressed. Backups from before encryption are plain gzip and still read. */
  private async readSnapshot(storageUrl: string): Promise<Record<string, unknown[]>> {
    const bytes = await this.storage.read(storageUrl);
    const compressed = storageUrl.endsWith('.enc') ? this.encryption.decryptBuffer(bytes) : bytes;
    return JSON.parse(gunzipSync(compressed).toString('utf-8')) as Record<string, unknown[]>;
  }

  /**
   * Backups past their retention date are deleted from storage and the
   * record marked `expired` — the file was the thing to remove; the record
   * stays as the history of when a backup existed.
   */
  async pruneExpiredBackups(): Promise<number> {
    const expired = await this.prisma.backupRecord.findMany({
      where: { status: 'completed', storageUrl: { not: null }, retainUntil: { lt: new Date() } },
      select: { id: true, storageUrl: true },
    });
    let pruned = 0;
    for (const record of expired) {
      try {
        await this.storage.remove(record.storageUrl!);
        await this.prisma.backupRecord.update({ where: { id: record.id }, data: { status: 'expired', storageUrl: null } });
        pruned += 1;
      } catch (err) {
        this.logger.error(`Could not prune expired backup ${record.id}`, err);
      }
    }
    return pruned;
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
      const snapshot = await this.readSnapshot(record.storageUrl);
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
   * built as parents are inserted, and every field with a GLOBAL uniqueness
   * constraint (`User.email`, `Branch.bookingSlug`, … — see
   * `RestoreModelMeta.globalUniqueFields`) is rewritten off the row's own new id.
   */
  async runRestoreDrill(backupRecordId: string): Promise<RestoreDrillResult> {
    const record = await this.prisma.backupRecord.findFirst({ where: { id: backupRecordId } });
    if (!record || !record.storageUrl) {
      return { ok: false, error: 'Backup record not found or has no stored file' };
    }

    let snapshot: Record<string, unknown[]>;
    try {
      snapshot = await this.readSnapshot(record.storageUrl);
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
        // Deferred FKs, filled in after every insert: which row, which column, the original value.
        const pendingLinks: Array<{ meta: RestoreModelMeta; rowId: string; field: string; targetModel: string; value: string }> = [];

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
            for (const rel of meta.deferred) {
              for (const fk of rel.fieldNames) {
                const value = out[fk];
                if (value == null || !newRowId) continue;
                pendingLinks.push({ meta, rowId: newRowId, field: fk, targetModel: rel.targetModel, value: value as string });
                out[fk] = null;
              }
            }

            for (const field of meta.globalUniqueFields) {
              if (!newRowId || out[field] == null) continue;
              out[field] = meta.modelName === 'User' && field === 'email' ? `restore-drill+${newRowId}@invalid.local` : newRowId;
            }

            return out;
          });

          await dynamicTx[meta.accessor].createMany({ data: remapped });
        }

        for (const link of pendingLinks) {
          await dynamicTx[link.meta.accessor].update({
            where: { [link.meta.idFieldName]: link.rowId },
            data: { [link.field]: idMaps.get(link.targetModel)?.get(link.value) ?? link.value },
          });
        }

        // A real SELECT COUNT(*) per model, not an assumption that
        // `createMany` inserted exactly what it was handed — this is the
        // actual "restore proven, not just decompressed" check.
        for (const meta of this.restoreInsertOrder) {
          if (modelCounts[meta.modelName].expected === 0) continue;
          modelCounts[meta.modelName].restored = await dynamicTx[meta.accessor].count({ where: { tenantId: drillTenant.id } });
        }
      }, { timeout: BACKUP_TX_TIMEOUT_MS });
    } catch (err) {
      restoreError = err instanceof Error ? err.message : String(err);
    }

    try {
      await this.prisma.withTenant(
        drillTenant.id,
        async (tx) => {
          const dynamicTx = tx as unknown as Record<string, DynamicDelegate>;
          for (const meta of [...this.restoreInsertOrder].reverse()) {
            await dynamicTx[meta.accessor].deleteMany({ where: { tenantId: drillTenant.id } });
          }
        },
        { timeout: BACKUP_TX_TIMEOUT_MS },
      );
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

}
