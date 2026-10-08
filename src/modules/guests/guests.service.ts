import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { DOCUMENT_STORAGE_ADAPTER, DocumentStorageAdapter } from '../../common/documents/document-storage.interface';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { AddGuestNoteDto, CreateGuestDto, RecordIdDocumentDto, UpdateGuestDto } from './dto/guest.dto';

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

/** The CRM's own "Guest Profile" (architecture map, `page-guestprofile`) — `GET /guests/:guestId`'s full response, nothing currently calls the old thin `GuestSummary` shape through this route, so this replaces it outright rather than adding a second endpoint. */
const GUEST_PROFILE_SELECT = {
  ...GUEST_SUMMARY_SELECT,
  preferences: true,
  vipLevel: true,
  tags: true,
  loyaltyTier: true,
  loyaltyPoints: true,
  marketingOptIn: true,
  marketingOptInAt: true,
  marketingOptInSource: true,
  marketingUnsubscribedAt: true,
} as const;

export interface GuestStaySummary {
  id: string;
  confirmationNumber: string;
  status: string;
  checkInDate: Date;
  checkOutDate: Date;
  confirmedRate: Prisma.Decimal;
  roomType: { name: string };
}

export interface GuestNoteSummary {
  id: string;
  body: string;
  createdAt: Date;
  author: { id: string; name: string } | null;
}

export type GuestProfile = GuestSummary & {
  preferences: Prisma.JsonValue | null;
  vipLevel: number | null;
  tags: string[];
  loyaltyTier: string | null;
  loyaltyPoints: number | null;
  /** Marketing consent. Changed only through `PUT /guests/:id/marketing-consent`, the booking engine, online check-in, or an unsubscribe link. */
  marketingOptIn: boolean;
  marketingOptInAt: Date | null;
  marketingOptInSource: string | null;
  marketingUnsubscribedAt: Date | null;
  /** Every reservation ever made by this guest, newest check-in first. */
  stayHistory: GuestStaySummary[];
  /** Sum of every non-void payment across every folio this guest has ever had — a plain string, already rounded to 2dp. */
  totalSpend: string;
  /** The append-only feed (`GuestNote`) — distinct from the legacy single `notes` column above, which stays read-only/historical. */
  notesFeed: GuestNoteSummary[];
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

/** The digits of a phone number as typed — "+234 803-123 4567" → "2348031234567" — or null for none. What search and matching compare. */
export function phoneDigitsOf(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : null;
}

/** Two phones are one number when their last nine digits agree — "0803 123 4567" and "+234 803 123 4567" — so a shorter number never matches. */
const PHONE_MATCH_DIGITS = 9;

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

  async getGuestById(tenantId: string, guestId: string): Promise<GuestProfile> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const guest = await tx.guestProfile.findFirst({
        where: { id: guestId, deletedAt: null },
        select: GUEST_PROFILE_SELECT,
      });
      if (!guest) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      }

      const [stayHistory, payments, notesFeed] = await Promise.all([
        tx.reservation.findMany({
          where: { guestId },
          select: { id: true, confirmationNumber: true, status: true, checkInDate: true, checkOutDate: true, confirmedRate: true, roomType: { select: { name: true } } },
          orderBy: { checkInDate: 'desc' },
        }),
        // Payment has no direct guestId — only reachable via its folio.
        tx.payment.findMany({ where: { folio: { guestId }, isVoid: false, deletedAt: null }, select: { amount: true } }),
        tx.guestNote.findMany({
          where: { guestId },
          select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      const totalSpend = payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));

      return { ...guest, stayHistory, totalSpend: totalSpend.toFixed(2), notesFeed };
    });
  }

  /** Every field optional — a caller changes just the one thing (VIP level, a tag, a preference) they're editing. */
  async updateGuest(tenantId: string, guestId: string, dto: UpdateGuestDto, actorId: string): Promise<GuestProfile> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.guestProfile.findFirst({ where: { id: guestId, deletedAt: null } });
      if (!existing) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      }
      await tx.guestProfile.update({
        where: { id: guestId },
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          phoneDigits: dto.phone === undefined ? undefined : phoneDigitsOf(dto.phone),
          preferences: dto.preferences as unknown as Prisma.InputJsonValue | undefined,
          vipLevel: dto.vipLevel,
          tags: dto.tags,
        },
      });
      // Which fields changed, not what they changed to: the audit trail
      // outlives a guest's erasure, so it mustn't keep their details.
      const fields = Object.entries(dto)
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field);
      await tx.auditLog.create({ data: { tenantId, userId: actorId, action: 'guest.updated', entityType: 'guest_profile', entityId: guestId, after: { fields } } });
    });
    return this.getGuestById(tenantId, guestId);
  }

  async addGuestNote(tenantId: string, guestId: string, dto: AddGuestNoteDto, actorId: string): Promise<GuestNoteSummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const guest = await tx.guestProfile.findFirst({ where: { id: guestId, deletedAt: null } });
      if (!guest) {
        throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Guest not found' });
      }
      const note = await tx.guestNote.create({
        data: { tenantId, guestId, authorId: actorId, body: dto.body },
        select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true } } },
      });
      await tx.auditLog.create({ data: { tenantId, userId: actorId, action: 'guest.note_added', entityType: 'guest_profile', entityId: guestId } });
      return note;
    });
  }

  /**
   * The CRM's own browsable list — separate from `searchGuests` (used
   * elsewhere for a quick "find one guest" picker, always requires a `q`,
   * capped at 20) so that existing caller stays untouched. `q` here is
   * optional — omit it to page through everyone.
   */
  async listGuests(tenantId: string, q: string | undefined, page: number, limit: number): Promise<{ rows: GuestSummary[]; total: number; page: number; limit: number }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.GuestProfileWhereInput = {
        deletedAt: null,
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.guestProfile.findMany({ where, select: GUEST_SUMMARY_SELECT, orderBy: { name: 'asc' }, skip: (page - 1) * limit, take: limit }),
        tx.guestProfile.count({ where }),
      ]);
      return { rows, total, page, limit };
    });
  }

  /** Full profile including the ID-document fields — masked unless `reveal` (the `?reveal=true` convention `AuditInterceptor` records as `pii.reveal`). */
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

  /**
   * Name, email or phone. Phones are stored as typed ("+234 803 …",
   * "0803-…") beside their digits (`phoneDigits`), so they're compared
   * digits to digits with a leading local 0 dropped — "0803 123" finds
   * "+2348031234567" — from the trigram index, not by reshaping every
   * guest's phone on every keystroke. Four digits at least, so a house
   * number in a name search doesn't drag in every phone that contains it.
   */
  async searchGuests(tenantId: string, q: string): Promise<Array<GuestSummary & { vipLevel: number | null }>> {
    const digits = q.replace(/[^0-9]/g, '').replace(/^0+/, '');
    return this.prisma.withTenant(tenantId, async (tx) => {
      return tx.guestProfile.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            ...(digits.length >= 4 ? [{ phoneDigits: { contains: digits } }] : []),
          ],
        },
        select: { ...GUEST_SUMMARY_SELECT, vipLevel: true },
        orderBy: { name: 'asc' },
        take: 20,
      });
    });
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
    return (await this.knownGuest(tx, input.guest)) ?? this.createGuestInTx(tx, tenantId, input.guest);
  }

  /**
   * The guest a booking names, if they're already on file: the same email,
   * or the same phone (its last nine digits — "0803 123 4567" and
   * "+234 803 123 4567" are one number). Every booking used to make a new
   * profile, so a repeat guest had one per stay, with their history, points,
   * VIP tag and marketing consent split across them. Whatever the booking
   * gives that the profile lacks — an email, a phone — is filled in.
   */
  private async knownGuest(tx: TenantTx, dto: CreateGuestDto): Promise<GuestSummary | null> {
    const email = dto.email?.trim().toLowerCase();
    const digits = phoneDigitsOf(dto.phone);
    const phoneEnd = digits && digits.length >= PHONE_MATCH_DIGITS ? digits.slice(-PHONE_MATCH_DIGITS) : null;
    if (!email && !phoneEnd) return null;

    const found = await tx.guestProfile.findFirst({
      where: {
        deletedAt: null,
        OR: [...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []), ...(phoneEnd ? [{ phoneDigits: { endsWith: phoneEnd } }] : [])],
      },
      orderBy: { updatedAt: 'desc' },
      select: GUEST_SUMMARY_SELECT,
    });
    if (!found) return null;

    const fill: Prisma.GuestProfileUncheckedUpdateInput = {};
    if (!found.email && email) fill.email = email;
    if (!found.phone && dto.phone) {
      fill.phone = dto.phone;
      fill.phoneDigits = digits;
    }
    if (Object.keys(fill).length === 0) return found;
    return tx.guestProfile.update({ where: { id: found.id }, data: fill, select: GUEST_SUMMARY_SELECT });
  }

  private async createGuestInTx(tx: TenantTx, tenantId: string, dto: CreateGuestDto): Promise<GuestSummary> {
    return tx.guestProfile.create({
      data: { tenantId, name: dto.name, email: dto.email, phone: dto.phone, phoneDigits: phoneDigitsOf(dto.phone), notes: dto.notes },
      select: GUEST_SUMMARY_SELECT,
    });
  }
}
