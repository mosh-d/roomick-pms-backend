import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DOCUMENT_STORAGE_ADAPTER, DocumentStorageAdapter } from '../../common/documents/document-storage.interface';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { GuestsService } from '../guests/guests.service';
import { CreateGdprRequestDto, UpdateGdprRequestStatusDto } from './dto/gdpr.dto';

const GDPR_REQUEST_INCLUDE = { guest: { select: { id: true, name: true, email: true } } };

@Injectable()
export class GdprService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guestsService: GuestsService,
    private readonly encryption: EncryptionService,
    @Inject(DOCUMENT_STORAGE_ADAPTER) private readonly documentStorage: DocumentStorageAdapter,
  ) {}

  /** `deadline` is `requestedAt + 30 days` — the GDPR statutory response window (Article 12(3)), the same figure the schema's own comment names. */
  async createDataRequest(tenantId: string, dto: CreateGdprRequestDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const guest = await tx.guestProfile.findFirst({ where: { id: dto.guestId, deletedAt: null } });
      if (!guest) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      }

      const deadline = new Date();
      deadline.setUTCDate(deadline.getUTCDate() + 30);

      const request = await tx.gdprRequest.create({
        data: {
          tenantId,
          guestId: dto.guestId,
          type: dto.type,
          requestedBy: dto.requestedBy,
          deadline,
          notes: dto.verificationMethod ? `Verification: ${dto.verificationMethod}` : null,
        },
        include: GDPR_REQUEST_INCLUDE,
      });

      await tx.auditLog.create({
        data: { tenantId, userId: actorId, action: 'gdpr.request_created', entityType: 'gdpr_request', entityId: request.id, after: { type: dto.type, guestId: dto.guestId } },
      });
      return request;
    });
  }

  async listDataRequests(tenantId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.gdprRequest.findMany({ include: GDPR_REQUEST_INCLUDE, orderBy: { requestedAt: 'desc' } }),
    );
  }

  /**
   * `completed`/`rejected` are terminal (see the DTO's own comment on why
   * "completed" never means this system did anything automated) — once a
   * request lands there, it stops accepting further status changes.
   */
  async updateStatus(tenantId: string, requestId: string, dto: UpdateGdprRequestStatusDto, actorId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const request = await tx.gdprRequest.findFirst({ where: { id: requestId } });
      if (!request) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'GDPR request not found' });
      }
      if (request.status === 'completed' || request.status === 'rejected') {
        throw new ConflictException({
          code: ErrorCode.INVALID_STATUS_TRANSITION,
          message: `This request is already "${request.status}" — that status is terminal`,
        });
      }

      const updated = await tx.gdprRequest.update({
        where: { id: requestId },
        data: {
          status: dto.status,
          notes: dto.notes ?? request.notes,
          ...(dto.status === 'completed' ? { completedAt: new Date() } : {}),
        },
        include: GDPR_REQUEST_INCLUDE,
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorId,
          action: 'gdpr.status_changed',
          entityType: 'gdpr_request',
          entityId: requestId,
          before: { status: request.status },
          after: { status: dto.status, notes: dto.notes ?? null },
        },
      });
      return updated;
    });
  }

  /**
   * Generates the export on first call, then serves the same stored file on
   * every later call — lazy, matching the reference's single
   * `GET .../export` endpoint rather than a separate generate step.
   *
   * `erasure` requests have nothing to export — there's no automated
   * cross-table PII deletion anywhere in this module. Safely erasing a
   * guest's data would mean touching reservations, folios/line items,
   * comms history, and audit rows, several of which carry independent
   * financial/legal retention requirements this pass has not worked out —
   * that's real, separate scope, not something to bolt on casually. An
   * erasure request is tracked (created, status-progressed via
   * `updateStatus`) on the honest assumption that the actual erasure work
   * happens through a real ops process outside this system; only `access`/
   * `portability` requests produce a real file here.
   */
  async downloadExport(tenantId: string, requestId: string, actorId: string): Promise<Buffer> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const request = await tx.gdprRequest.findFirst({ where: { id: requestId } });
      if (!request) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'GDPR request not found' });
      }
      if (request.type === 'erasure') {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'An erasure request has nothing to export — track its fulfillment via status updates instead' });
      }

      let exportUrl = request.exportUrl;
      if (!exportUrl) {
        const [guest, reservations, folios, communications] = await Promise.all([
          this.guestsService.getGuestDetail(tenantId, request.guestId, true),
          tx.reservation.findMany({
            where: { guestId: request.guestId },
            select: { id: true, confirmationNumber: true, status: true, checkInDate: true, checkOutDate: true, adults: true, children: true, confirmedRate: true, createdAt: true },
          }),
          tx.folio.findMany({ where: { guestId: request.guestId }, include: { lineItems: true, payments: true } }),
          tx.communicationLog.findMany({
            where: { guestId: request.guestId },
            select: { id: true, channel: true, subject: true, body: true, trigger: true, sentAt: true },
          }),
        ]);

        const payload = JSON.stringify({ exportedAt: new Date().toISOString(), guest, reservations, folios, communications }, null, 2);
        const encrypted = this.encryption.encryptBuffer(Buffer.from(payload, 'utf-8'));
        exportUrl = await this.documentStorage.write(`${tenantId}/gdpr-exports/${requestId}.enc`, encrypted);

        await tx.gdprRequest.update({ where: { id: requestId }, data: { status: 'completed', completedAt: new Date(), exportUrl } });
        await tx.auditLog.create({
          data: { tenantId, userId: actorId, action: 'gdpr.data_exported', entityType: 'gdpr_request', entityId: requestId, after: { guestId: request.guestId } },
        });
      }

      const encrypted = await this.documentStorage.read(exportUrl);
      return this.encryption.decryptBuffer(encrypted);
    });
  }
}
