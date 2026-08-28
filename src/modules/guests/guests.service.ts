import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { DOCUMENT_STORAGE_ADAPTER, DocumentStorageAdapter } from '../../common/documents/document-storage.interface';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateGuestDto, RecordIdDocumentDto } from './dto/guest.dto';

/** Deliberately excludes ID-document/loyalty/preference fields — see `CreateGuestDto`'s own header comment. */
const GUEST_SUMMARY_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type GuestSummary = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const GUEST_DETAIL_SELECT = {
  ...GUEST_SUMMARY_SELECT,
  nationality: true,
  idDocType: true,
  idDocNumber: true,
  idDocExpiryDate: true,
} as const;

/** `guest_profiles (id) — compare idDocExpiryDate to NOW()` (DB reference's own "Check-in ID state" access pattern) — drives the check-in UI without any manual front-desk logic. */
export type IdCheckState = 'first_visit' | 'valid' | 'expired';

export type GuestDetail = GuestSummary & {
  nationality: string | null;
  idDocType: string | null;
  /** Masked (`••••1234`) unless fetched with `reveal: true`; `null` when no ID is on file. */
  idDocNumber: string | null;
  idDocExpiryDate: Date | null;
  idCheckState: IdCheckState;
};

@Injectable()
export class GuestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    @Inject(DOCUMENT_STORAGE_ADAPTER) private readonly documentStorage: DocumentStorageAdapter,
  ) {}

  async createGuest(tenantId: string, dto: CreateGuestDto): Promise<GuestSummary> {
    return this.prisma.withTenant(tenantId, (tx) => this.createGuestInTx(tx, tenantId, dto));
  }

  async getGuestById(tenantId: string, guestId: string): Promise<GuestSummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const guest = await tx.guestProfile.findFirst({
        where: { id: guestId, deletedAt: null },
        select: GUEST_SUMMARY_SELECT,
      });
      if (!guest) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      }
      return guest;
    });
  }

  /** Full profile including the ID-document fields — masked unless `reveal` (the `?reveal=true` convention `AuditInterceptor` already audits as `pii.reveal`). */
  async getGuestDetail(tenantId: string, guestId: string, reveal: boolean): Promise<GuestDetail> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const guest = await tx.guestProfile.findFirst({
        where: { id: guestId, deletedAt: null },
        select: GUEST_DETAIL_SELECT,
      });
      if (!guest) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      }
      const plainIdDocNumber = guest.idDocNumber ? this.encryption.decrypt(guest.idDocNumber) : null;
      return {
        ...guest,
        idDocNumber: plainIdDocNumber ? (reveal ? plainIdDocNumber : this.encryption.mask(plainIdDocNumber)) : null,
        idCheckState: this.deriveIdCheckState(guest.idDocExpiryDate),
      };
    });
  }

  /**
   * Captured at check-in, not guest creation — see `RecordIdDocumentDto`'s
   * own header comment. `idDocNumber` is encrypted before it ever reaches
   * this transaction's INSERT; `photoBase64`, if present, is encrypted
   * separately and pushed through `DocumentStorageAdapter`, with only the
   * resulting URL landing in `idDocUrl` (schema: "encrypted S3 bucket URL").
   * Overwrites any previous ID on file — a guest re-presenting ID (renewed
   * passport, different document) replaces the record; there's no history
   * requirement here, unlike a signed registration card.
   */
  async recordIdDocumentInTx(
    tx: TenantTx,
    tenantId: string,
    branchId: string,
    guestId: string,
    dto: RecordIdDocumentDto,
    actorId: string,
  ): Promise<void> {
    const encryptedIdDocNumber = this.encryption.encrypt(dto.idDocNumber);

    let idDocUrl: string | undefined;
    if (dto.photoBase64) {
      const photoBuffer = Buffer.from(dto.photoBase64, 'base64');
      const encryptedPhoto = this.encryption.encryptBuffer(photoBuffer);
      idDocUrl = await this.documentStorage.write(`${tenantId}/id-documents/${guestId}-${Date.now()}.enc`, encryptedPhoto);
    }

    await tx.guestProfile.update({
      where: { id: guestId },
      data: {
        idDocType: dto.idDocType,
        idDocNumber: encryptedIdDocNumber,
        idDocExpiryDate: dto.idDocExpiryDate ? new Date(dto.idDocExpiryDate) : null,
        nationality: dto.nationality,
        ...(idDocUrl ? { idDocUrl } : {}),
      },
    });

    // Never the document number itself — even encrypted, an audit row isn't the place for it.
    await tx.auditLog.create({
      data: {
        tenantId,
        branchId,
        userId: actorId,
        action: 'guest.id_document_recorded',
        entityType: 'guest_profile',
        entityId: guestId,
        after: { idDocType: dto.idDocType, hasPhoto: !!dto.photoBase64 },
      },
    });
  }

  private deriveIdCheckState(idDocExpiryDate: Date | null): IdCheckState {
    if (!idDocExpiryDate) return 'first_visit';
    return idDocExpiryDate.getTime() >= Date.now() ? 'valid' : 'expired';
  }

  async searchGuests(tenantId: string, q: string): Promise<GuestSummary[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.guestProfile.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: GUEST_SUMMARY_SELECT,
        orderBy: { name: 'asc' },
        take: 20,
      }),
    );
  }

  /**
   * Resolves a guest inside an ALREADY-OPEN transaction — the shape
   * `PropertyService.assertBranch`/`findOrCreateDefaultFloor` already
   * establish for cross-service calls within one `withTenant` block, so
   * `ReservationsService` can resolve a guest without a second round trip.
   */
  async findOrCreateGuestInTx(
    tx: TenantTx,
    tenantId: string,
    input: { guestId: string } | { guest: CreateGuestDto },
  ): Promise<GuestSummary> {
    if ('guestId' in input) {
      const guest = await tx.guestProfile.findFirst({
        where: { id: input.guestId, deletedAt: null },
        select: GUEST_SUMMARY_SELECT,
      });
      if (!guest) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      }
      return guest;
    }
    return this.createGuestInTx(tx, tenantId, input.guest);
  }

  private async createGuestInTx(tx: TenantTx, tenantId: string, dto: CreateGuestDto): Promise<GuestSummary> {
    return tx.guestProfile.create({
      data: { tenantId, name: dto.name, email: dto.email, phone: dto.phone, notes: dto.notes },
      select: GUEST_SUMMARY_SELECT,
    });
  }
}
