import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DOCUMENT_STORAGE_ADAPTER, DocumentStorageAdapter } from '../../common/documents/document-storage.interface';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GuestsService } from '../guests/guests.service';
import { CreateGdprRequestDto, UpdateGdprRequestStatusDto } from './dto/gdpr.dto';

const GDPR_REQUEST_INCLUDE = { guest: { select: { id: true, name: true, email: true } } };

/** What an erased guest is called everywhere their stays and bills still appear. */
export const ERASED_GUEST_NAME = 'Erased guest';
const ERASED_TEXT = '[erased]';

@Injectable()
export class GdprService {
  private readonly logger = new Logger(GdprService.name);

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
   * Carries out an erasure request (the owner's call, 2026-10-03): the
   * guest's identity goes, the business's records stay.
   *
   * - **Gone:** name (to "Erased guest"), email, phone, nationality, every
   *   ID-document field and the ID photo itself, preferences, tags, notes,
   *   VIP level, marketing consent; the guest's name, contact details,
   *   signature and PDF on each registration card; staff notes about them;
   *   the text of every message to or from them; special requests on their
   *   stays; and the payer name/email on a bill where those were theirs.
   * - **Kept:** reservations, bills, payments, loyalty ledger and the audit
   *   trail — the financial and tax record a hotel must hold on to, now
   *   attached to no one identifiable.
   *
   * Refused while it would break something live: a stay booked or in
   * progress, or money still owed (needed to collect it — the GDPR's own
   * legal-claims exception). Settle those, then erase.
   *
   * Stored files are deleted only after the transaction commits, so a
   * failure can't leave a guest erased in the database but not on disk —
   * or worse, the other way round.
   */
  async eraseGuestData(tenantId: string, requestId: string, actorId: string) {
    const filesToDelete: string[] = [];
    const completed = await this.prisma.withTenant(tenantId, async (tx) => {
      const request = await tx.gdprRequest.findFirst({ where: { id: requestId } });
      if (!request) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'GDPR request not found' });
      if (request.type !== 'erasure') {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'Only an erasure request erases a guest — this one asks for their data instead' });
      }
      if (request.status === 'completed' || request.status === 'rejected') {
        throw new ConflictException({ code: ErrorCode.INVALID_STATUS_TRANSITION, message: `This request is already "${request.status}"` });
      }
      const guest = await tx.guestProfile.findFirst({ where: { id: request.guestId } });
      if (!guest) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      if (guest.deletedAt) throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This guest has already been erased' });

      const liveStays = await tx.reservation.count({ where: { guestId: guest.id, deletedAt: null, status: { in: ['confirmed', 'checked_in'] } } });
      if (liveStays > 0) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This guest has a stay booked or in progress — check them out or cancel it first' });
      }
      const folios = await tx.folio.findMany({ where: { guestId: guest.id, deletedAt: null }, select: { id: true } });
      const folioIds = folios.map((f) => f.id);
      if (folioIds.length > 0) {
        const [charged, paid] = await Promise.all([
          tx.lineItem.aggregate({ _sum: { amount: true }, where: { folioId: { in: folioIds }, isVoid: false, deletedAt: null } }),
          tx.payment.aggregate({ _sum: { amount: true }, where: { folioId: { in: folioIds }, isVoid: false, deletedAt: null } }),
        ]);
        const owed = (charged._sum.amount ?? new Prisma.Decimal(0)).minus(paid._sum.amount ?? new Prisma.Decimal(0));
        if (owed.greaterThan(0)) {
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: `This guest still owes ${owed.toFixed(2)} — their details are needed to collect it. Settle the bill first, then erase.`,
          });
        }
      }

      const now = new Date();
      await tx.guestProfile.update({
        where: { id: guest.id },
        data: {
          name: ERASED_GUEST_NAME,
          email: null,
          phone: null,
          nationality: null,
          idDocType: null,
          idDocNumber: null,
          idDocUrl: null,
          idDocExpiryDate: null,
          preferences: Prisma.DbNull,
          vipLevel: 0,
          tags: [],
          notes: null,
          marketingOptIn: false,
          marketingOptInAt: null,
          marketingOptInSource: null,
          marketingUnsubscribedAt: guest.marketingUnsubscribedAt ?? now,
          deletedAt: now,
        },
      });
      if (guest.idDocUrl) filesToDelete.push(guest.idDocUrl);

      const cards = await tx.registrationCard.findMany({ where: { guestId: guest.id } });
      for (const card of cards) {
        const fields = card.fields && typeof card.fields === 'object' && !Array.isArray(card.fields) ? card.fields : {};
        await tx.registrationCard.update({
          where: { id: card.id },
          data: { fields: { ...fields, guestName: ERASED_GUEST_NAME, guestEmail: null, guestPhone: null }, signatureData: null, documentUrl: null },
        });
        if (card.documentUrl) filesToDelete.push(card.documentUrl);
      }

      const [notes, messages, stays, webhookDeliveries] = await Promise.all([
        tx.guestNote.updateMany({ where: { guestId: guest.id }, data: { body: ERASED_TEXT } }),
        tx.communicationLog.updateMany({ where: { guestId: guest.id }, data: { body: ERASED_TEXT, bodyHtml: null } }),
        tx.reservation.updateMany({ where: { guestId: guest.id }, data: { specialRequests: null, estimatedArrivalTime: null } }),
        // A webhook delivery carries the guest as they stood when it was
        // queued; the log of them goes too, sent or not.
        tx.webhookDelivery.deleteMany({
          where: {
            OR: [
              { payload: { path: ['data', 'reservation', 'guest', 'id'], equals: guest.id } },
              { payload: { path: ['data', 'guest', 'id'], equals: guest.id } },
            ],
          },
        }),
      ]);
      // A bill's payer is the guest unless someone else (a company) was named.
      if (folioIds.length > 0) {
        await tx.folio.updateMany({ where: { id: { in: folioIds }, payerName: { equals: guest.name, mode: 'insensitive' } }, data: { payerName: ERASED_GUEST_NAME } });
        if (guest.email) {
          await tx.folio.updateMany({ where: { id: { in: folioIds }, payerEmail: { equals: guest.email, mode: 'insensitive' } }, data: { payerEmail: null } });
        }
      }

      const note = `Erased in Roomick on ${now.toISOString().slice(0, 10)}: identity and contact details, ID document, registration cards, notes, messages and webhook deliveries. Bills, payments and stays kept as the financial record.`;
      const updated = await tx.gdprRequest.update({
        where: { id: request.id },
        data: { status: 'completed', completedAt: now, notes: request.notes ? `${request.notes}\n${note}` : note },
        include: GDPR_REQUEST_INCLUDE,
      });
      // Counts only — the audit trail must not become the copy of what was erased.
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorId,
          action: 'gdpr.guest_erased',
          entityType: 'gdpr_request',
          entityId: request.id,
          after: {
            guestId: guest.id,
            registrationCards: cards.length,
            notes: notes.count,
            messages: messages.count,
            stays: stays.count,
            webhookDeliveries: webhookDeliveries.count,
            documentsDeleted: filesToDelete.length,
          },
        },
      });
      return updated;
    });

    for (const url of filesToDelete) {
      // Nothing points at the file any more and it's encrypted at rest; one
      // that can't be removed is logged for someone to clear by hand.
      await this.documentStorage.remove(url).catch((error: unknown) => this.logger.warn(`Erasure ${requestId}: could not delete ${url}`, error));
    }
    return completed;
  }

  /**
   * Generates the export on first call, then serves the same stored file on
   * every later call — lazy, matching the reference's single
   * `GET .../export` endpoint rather than a separate generate step.
   *
   * `erasure` requests have nothing to export — they're carried out by
   * `eraseGuestData` instead.
   */
  async downloadExport(tenantId: string, requestId: string, actorId: string): Promise<Buffer> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const request = await tx.gdprRequest.findFirst({ where: { id: requestId } });
      if (!request) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'GDPR request not found' });
      }
      if (request.type === 'erasure') {
        throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'An erasure request has nothing to export — erase the guest from it instead' });
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
