import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CampaignStatus, GuestSegment, MessageTemplate, Prisma } from '@prisma/client';
import { randomBytes, createHmac } from 'crypto';
import { SystemRole } from '../../common/decorators/roles.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { MAIL_TRANSPORT, MailTransport } from '../../common/mail/mail-transport.interface';
import { JwtPayload } from '../../common/types/request-context';
import { assertRoleAtBranch } from '../../common/utils/branch-roles';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { MARKETING_CAMPAIGN_TRIGGER } from '../comms-log/comms-log.service';
import { PropertyService } from '../property/property.service';
import {
  MERGE_FIELDS,
  MergeContext,
  renderForRecipient,
  renderMergeFields,
  trackingUrlsFor,
  unknownMergeFields,
  variantFor,
  verifyTarget,
} from './campaign-render';
import { CreateCampaignDto, SaveSegmentDto, SaveTemplateDto, UpdateCampaignDto } from './dto/marketing.dto';
import {
  GuestAggregates,
  MARKETING_CONSENT_FLOOR,
  SegmentCriteria,
  describeCriteria,
  guestWhereFor,
  matchesAggregates,
  needsAggregates,
  parseCriteria,
} from './segment-rules';

const CAMPAIGN_ROLES = [SystemRole.Owner, SystemRole.Manager];


/**
 * Guard rails on audience size. Neither is a performance limit dressed up as
 * a rule — an audience nobody has read is the thing to prevent. A segment
 * whose pool is larger than MAX_CANDIDATES isn't evaluated at all (the
 * stays/spend pass would have to load all of them), and a send to more than
 * MAX_AUDIENCE guests is refused so an accidental "everyone" segment can't
 * go out in one click.
 */
const MAX_CANDIDATES = 20_000;
const MAX_AUDIENCE = 5_000;
/** Recipients are written in batches, each its own transaction — a 5,000-row send must not hold one open. */
const SEND_CHUNK = 100;
const PREVIEW_SAMPLE = 10;
const RECIPIENT_ROWS = 100;
/** Bookings by a recipient within this many days of the send are reported beside the campaign — as correlation, labelled as such. */
export const CONVERSION_WINDOW_DAYS = 30;

const EDITABLE: CampaignStatus[] = ['draft', 'scheduled', 'failed'];
/** `sending` is included so a send interrupted halfway can be resumed; the unique (campaign, guest) index makes that safe. */
const SENDABLE: CampaignStatus[] = ['draft', 'scheduled', 'failed', 'sending'];

export interface SegmentView {
  id: string;
  name: string;
  description: string | null;
  criteria: SegmentCriteria;
  /** The same rules in plain English, so an audience can be read back without decoding JSON. */
  rules: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SegmentPreview {
  /** Guests who match the rules, consent aside. */
  matching: number;
  /** Of those, the ones a campaign can actually go to: opted in, with an email address. */
  reachable: number;
  rules: string[];
  sample: Array<{ id: string; name: string; email: string | null; loyaltyTier: string | null; vipLevel: number | null }>;
  /** True when the pool was too large to evaluate — the counts are then not returned. */
  tooLarge: boolean;
}

export interface TemplateView {
  id: string;
  name: string;
  subject: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignPerformance {
  recipients: number;
  /** Messages the dispatcher has handed to the transport. */
  sent: number;
  failed: number;
  queued: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  openRate: number | null;
  clickRate: number | null;
  byVariant: Array<{ variant: string; recipients: number; opened: number; clicked: number }>;
  /** Reservations these recipients made at this branch within CONVERSION_WINDOW_DAYS of the send. Correlation, not proof. */
  bookingsAfterSend: number | null;
}

export interface CampaignView {
  id: string;
  branchId: string;
  name: string;
  channel: string;
  status: CampaignStatus;
  subject: string | null;
  segment: { id: string; name: string; rules: string[] };
  template: { id: string; name: string };
  variantTemplate: { id: string; name: string } | null;
  splitRatio: string | null;
  scheduledAt: Date | null;
  sentAt: Date | null;
  recipientCount: number;
  failureReason: string | null;
  createdAt: Date;
  performance: CampaignPerformance;
  recipients: Array<{
    id: string;
    guestId: string;
    guestName: string;
    email: string | null;
    variant: string;
    deliveryStatus: string | null;
    openedAt: Date | null;
    clickedAt: Date | null;
    unsubscribedAt: Date | null;
  }>;
}

export interface CampaignSummary {
  id: string;
  name: string;
  channel: string;
  status: CampaignStatus;
  segmentName: string;
  scheduledAt: Date | null;
  sentAt: Date | null;
  recipientCount: number;
  opened: number;
  clicked: number;
  failureReason: string | null;
}

export interface UnsubscribeResult {
  guestName: string;
  hotelName: string;
  /** True when this token had already been used to unsubscribe — the page says so rather than claiming a fresh opt-out. */
  alreadyUnsubscribed: boolean;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

function conflict(message: string): ConflictException {
  return new ConflictException({ code: ErrorCode.CONFLICT, message });
}

function notFound(message: string): NotFoundException {
  return new NotFoundException({ code: ErrorCode.NOT_FOUND, message });
}

/**
 * Segments, templates and campaigns — the Email Campaign Builder (ref p21).
 *
 * **A campaign is not its own delivery system.** Sending one writes an
 * ordinary `CommunicationLog` row per recipient and lets
 * `CommsDispatcherService` deliver it, exactly as a booking confirmation is
 * delivered: same outbox, same transport, same honest `deliveryStatus`. The
 * growth plan says as much in its own words — "a marketing campaign and a
 * guest-service reply are the same delivery mechanism at different volumes,
 * not two systems" — and the practical payoff is that with no email provider
 * configured, a campaign doesn't pretend to have been delivered. It reaches
 * `sent` through the (log) transport and nothing more.
 *
 * **Consent is a floor, not a filter.** `MARKETING_CONSENT_FLOOR` is applied
 * to every audience, at send time, from this service — never from the saved
 * criteria, where someone could leave it out. A guest with no `marketingOptIn`
 * cannot be reached by any segment, however it's written.
 */
@Injectable()
export class MarketingService {
  private readonly logger = new Logger(MarketingService.name);

  /**
   * A purpose-separated key derived from the app's own encryption key rather
   * than a new secret to configure: the click redirect signs a destination,
   * which is a different job from encrypting a guest's ID document, and the
   * two must not share the same raw key material.
   */
  private readonly clickSecret = createHmac('sha256', process.env.ENCRYPTION_KEY ?? '').update('marketing-click-redirect').digest('hex');

  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyService: PropertyService,
    @Inject(MAIL_TRANSPORT) private readonly mailTransport: MailTransport,
  ) {}

  /** Where a guest's mail client reaches this API. Absolute, because the links outlive the request that wrote them. */
  private get baseUrl(): string {
    return process.env.PUBLIC_API_BASE_URL || `http://localhost:${process.env.PORT ?? 3000}`;
  }

  // -------------------------------------------------------------------------
  // Segments
  // -------------------------------------------------------------------------

  async listSegments(tenantId: string): Promise<SegmentView[]> {
    const segments = await this.prisma.withTenant(tenantId, (tx) =>
      tx.guestSegment.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } }),
    );
    return segments.map((segment) => this.toSegmentView(segment));
  }

  async saveSegment(tenantId: string, dto: SaveSegmentDto, actorId: string, segmentId?: string): Promise<SegmentView> {
    const criteria = parseCriteria(dto.criteria);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const clash = await tx.guestSegment.findFirst({ where: { name: dto.name, deletedAt: null, ...(segmentId ? { id: { not: segmentId } } : {}) } });
      if (clash) throw conflict(`A segment called “${dto.name}” already exists`);

      const data = {
        name: dto.name,
        description: dto.description ?? null,
        criteria: criteria as Prisma.InputJsonValue,
      };

      let segment: GuestSegment;
      if (segmentId) {
        const existing = await tx.guestSegment.findFirst({ where: { id: segmentId, deletedAt: null } });
        if (!existing) throw notFound('Segment not found');
        segment = await tx.guestSegment.update({ where: { id: segmentId }, data });
      } else {
        segment = await tx.guestSegment.create({ data: { ...data, tenantId, createdBy: actorId } });
      }

      await this.audit(tx, tenantId, null, actorId, segmentId ? 'marketing.segment_updated' : 'marketing.segment_created', 'guest_segment', segment.id, {
        name: segment.name,
        criteria: criteria as Prisma.InputJsonValue,
      });
      return this.toSegmentView(segment);
    });
  }

  /** Soft delete: a campaign that already went out keeps the audience it was aimed at. */
  async deleteSegment(tenantId: string, segmentId: string, actorId: string): Promise<{ deleted: true }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const segment = await tx.guestSegment.findFirst({ where: { id: segmentId, deletedAt: null } });
      if (!segment) throw notFound('Segment not found');
      const pending = await tx.marketingCampaign.count({ where: { segmentId, status: { in: ['draft', 'scheduled', 'sending'] } } });
      if (pending > 0) {
        throw conflict(`${pending} campaign${pending === 1 ? '' : 's'} still ${pending === 1 ? 'points' : 'point'} at this segment`);
      }
      await tx.guestSegment.update({ where: { id: segmentId }, data: { deletedAt: new Date() } });
      await this.audit(tx, tenantId, null, actorId, 'marketing.segment_deleted', 'guest_segment', segmentId, { name: segment.name });
      return { deleted: true as const };
    });
  }

  /**
   * How many guests a set of rules reaches — answered for unsaved criteria
   * too, because the moment to discover an audience of nobody is while
   * writing it, not after pressing send.
   */
  async previewSegment(tenantId: string, rawCriteria: unknown): Promise<SegmentPreview> {
    const criteria = parseCriteria(rawCriteria);
    const rules = describeCriteria(criteria);
    const now = new Date();
    const where = guestWhereFor(criteria, now);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const matchingRaw = await tx.guestProfile.count({ where });
      if (matchingRaw > MAX_CANDIDATES) {
        return { matching: matchingRaw, reachable: 0, rules, sample: [], tooLarge: true };
      }

      // Two numbers, because the gap between them is the useful one: "480
      // guests match, 45 of them can be emailed" says the audience is fine
      // and consent is the bottleneck, which "45" alone doesn't.
      let matching = matchingRaw;
      if (needsAggregates(criteria)) {
        matching = (await this.applyAggregates(tx, await this.candidates(tx, where), criteria, now)).length;
      }
      const audience = await this.resolveAudience(tx, criteria, now);

      return {
        matching,
        reachable: audience.length,
        rules,
        sample: audience.slice(0, PREVIEW_SAMPLE).map((guest) => ({
          id: guest.id,
          name: guest.name,
          email: guest.email,
          loyaltyTier: guest.loyaltyTier,
          vipLevel: guest.vipLevel,
        })),
        tooLarge: false,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  async listTemplates(tenantId: string): Promise<TemplateView[]> {
    const templates = await this.prisma.withTenant(tenantId, (tx) =>
      tx.messageTemplate.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } }),
    );
    return templates.map((template) => this.toTemplateView(template));
  }

  async saveTemplate(tenantId: string, dto: SaveTemplateDto, actorId: string, templateId?: string): Promise<TemplateView> {
    this.assertMergeFields(dto.body, dto.subject);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const clash = await tx.messageTemplate.findFirst({ where: { name: dto.name, deletedAt: null, ...(templateId ? { id: { not: templateId } } : {}) } });
      if (clash) throw conflict(`A template called “${dto.name}” already exists`);

      const data = { name: dto.name, subject: dto.subject ?? null, body: dto.body };
      let template: MessageTemplate;
      if (templateId) {
        const existing = await tx.messageTemplate.findFirst({ where: { id: templateId, deletedAt: null } });
        if (!existing) throw notFound('Template not found');
        // A template a campaign has already sent is deliberately still editable:
        // the messages that went out carry their own rendered copy, so editing
        // it changes the next send and can never rewrite history.
        template = await tx.messageTemplate.update({ where: { id: templateId }, data });
      } else {
        template = await tx.messageTemplate.create({ data: { ...data, tenantId, channel: 'email', createdBy: actorId } });
      }

      await this.audit(tx, tenantId, null, actorId, templateId ? 'marketing.template_updated' : 'marketing.template_created', 'message_template', template.id, {
        name: template.name,
      });
      return this.toTemplateView(template);
    });
  }

  async deleteTemplate(tenantId: string, templateId: string, actorId: string): Promise<{ deleted: true }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const template = await tx.messageTemplate.findFirst({ where: { id: templateId, deletedAt: null } });
      if (!template) throw notFound('Template not found');
      const pending = await tx.marketingCampaign.count({
        where: { status: { in: ['draft', 'scheduled', 'sending'] }, OR: [{ templateId }, { variantTemplateId: templateId }] },
      });
      if (pending > 0) {
        throw conflict(`${pending} campaign${pending === 1 ? '' : 's'} still ${pending === 1 ? 'uses' : 'use'} this template`);
      }
      await tx.messageTemplate.update({ where: { id: templateId }, data: { deletedAt: new Date() } });
      await this.audit(tx, tenantId, null, actorId, 'marketing.template_deleted', 'message_template', templateId, { name: template.name });
      return { deleted: true as const };
    });
  }

  /** The draft as a guest would read it, with the example values from MERGE_FIELDS — no guest data, so it works before any audience exists. */
  previewTemplate(body: string, subject?: string): { subject: string; text: string; html: string } {
    this.assertMergeFields(body, subject);
    const tracking = trackingUrlsFor(this.baseUrl, 'preview', this.clickSecret);
    const context: MergeContext = { ...exampleContext(), unsubscribe_url: tracking.unsubscribeUrl };
    const rendered = renderForRecipient(body, context, tracking);
    return {
      subject: renderMergeFields(subject ?? '', context),
      text: rendered.text,
      html: rendered.html,
    };
  }

  mergeFields(): readonly { token: string; label: string; example: string }[] {
    return MERGE_FIELDS;
  }

  /**
   * Which transport campaigns will actually go out through. The builder shows
   * this above the Send button: with the development `log` transport a
   * campaign reaches `sent` and nothing leaves the server, and a hotelier
   * deserves to know that before sending, not after wondering why nobody
   * opened it.
   */
  deliveryStatus(): { transport: string; deliversExternally: boolean } {
    return { transport: this.mailTransport.name, deliversExternally: this.mailTransport.name !== 'log' };
  }

  // -------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------

  async listCampaigns(tenantId: string, branchId: string, status?: CampaignStatus): Promise<CampaignSummary[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      const campaigns = await tx.marketingCampaign.findMany({
        where: { branchId, ...(status ? { status } : {}) },
        orderBy: [{ createdAt: 'desc' }],
        include: { segment: { select: { name: true } } },
      });

      const ids = campaigns.map((campaign) => campaign.id);
      const [openRows, clickRows] = await Promise.all([
        tx.campaignRecipient.groupBy({ by: ['campaignId'], where: { campaignId: { in: ids }, openedAt: { not: null } }, _count: { _all: true } }),
        tx.campaignRecipient.groupBy({ by: ['campaignId'], where: { campaignId: { in: ids }, clickedAt: { not: null } }, _count: { _all: true } }),
      ]);
      const openedBy = new Map(openRows.map((row) => [row.campaignId, row._count._all]));
      const clickedBy = new Map(clickRows.map((row) => [row.campaignId, row._count._all]));

      const summaries: CampaignSummary[] = [];
      for (const campaign of campaigns) {
        summaries.push({
          id: campaign.id,
          name: campaign.name,
          channel: campaign.channel,
          status: campaign.status,
          segmentName: campaign.segment.name,
          scheduledAt: campaign.scheduledAt,
          sentAt: campaign.sentAt,
          recipientCount: campaign.recipientCount,
          opened: openedBy.get(campaign.id) ?? 0,
          clicked: clickedBy.get(campaign.id) ?? 0,
          failureReason: campaign.failureReason,
        });
      }
      return summaries;
    });
  }

  async createCampaign(tenantId: string, branchId: string, dto: CreateCampaignDto, actorId: string): Promise<CampaignView> {
    this.assertSendableChannel(dto.channel);
    const id = await this.prisma.withTenant(tenantId, async (tx) => {
      await this.propertyService.assertBranch(tx, branchId);
      await this.loadSegment(tx, dto.segmentId);
      await this.loadTemplate(tx, dto.templateId);
      if (dto.abTest) await this.assertVariant(tx, dto.templateId, dto.abTest.variantTemplateId);
      const scheduledAt = dto.scheduledAt ? this.parseSchedule(dto.scheduledAt) : null;

      const campaign = await tx.marketingCampaign.create({
        data: {
          tenantId,
          branchId,
          name: dto.name,
          channel: dto.channel,
          segmentId: dto.segmentId,
          templateId: dto.templateId,
          subject: dto.subject ?? null,
          scheduledAt,
          status: scheduledAt ? 'scheduled' : 'draft',
          variantTemplateId: dto.abTest?.variantTemplateId ?? null,
          splitRatio: dto.abTest ? new Prisma.Decimal(dto.abTest.splitRatio) : null,
          createdBy: actorId,
        },
      });
      await this.audit(tx, tenantId, branchId, actorId, 'marketing.campaign_created', 'marketing_campaign', campaign.id, {
        name: campaign.name,
        segmentId: campaign.segmentId,
        scheduledAt: scheduledAt?.toISOString() ?? null,
      });
      return campaign.id;
    });
    return this.getCampaign(tenantId, id);
  }

  async updateCampaign(tenantId: string, campaignId: string, dto: UpdateCampaignDto, actor: JwtPayload): Promise<CampaignView> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const campaign = await tx.marketingCampaign.findFirst({ where: { id: campaignId } });
      if (!campaign) throw notFound('Campaign not found');
      assertRoleAtBranch(actor, campaign.branchId, CAMPAIGN_ROLES);
      if (!EDITABLE.includes(campaign.status)) {
        throw conflict(`A ${campaign.status} campaign can't be edited`);
      }

      if (dto.segmentId) await this.loadSegment(tx, dto.segmentId);
      if (dto.templateId) await this.loadTemplate(tx, dto.templateId);
      const templateId = dto.templateId ?? campaign.templateId;
      if (dto.abTest) await this.assertVariant(tx, templateId, dto.abTest.variantTemplateId);

      const scheduledAt = dto.scheduledAt === undefined ? campaign.scheduledAt : dto.scheduledAt === null ? null : this.parseSchedule(dto.scheduledAt);

      await tx.marketingCampaign.update({
        where: { id: campaignId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.segmentId !== undefined ? { segmentId: dto.segmentId } : {}),
          ...(dto.templateId !== undefined ? { templateId: dto.templateId } : {}),
          ...(dto.subject !== undefined ? { subject: dto.subject } : {}),
          ...(dto.abTest !== undefined
            ? dto.abTest === null
              ? { variantTemplateId: null, splitRatio: null }
              : { variantTemplateId: dto.abTest.variantTemplateId, splitRatio: new Prisma.Decimal(dto.abTest.splitRatio) }
            : {}),
          scheduledAt,
          // Editing a failed campaign returns it to the queue rather than leaving
          // the failure showing against a draft that has since been fixed.
          status: scheduledAt ? 'scheduled' : 'draft',
          failureReason: null,
        },
      });
      await this.audit(tx, tenantId, campaign.branchId, actor.sub, 'marketing.campaign_updated', 'marketing_campaign', campaignId, {
        scheduledAt: scheduledAt?.toISOString() ?? null,
      });
    });
    return this.getCampaign(tenantId, campaignId);
  }

  async cancelCampaign(tenantId: string, campaignId: string, actor: JwtPayload): Promise<CampaignView> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      const campaign = await tx.marketingCampaign.findFirst({ where: { id: campaignId } });
      if (!campaign) throw notFound('Campaign not found');
      assertRoleAtBranch(actor, campaign.branchId, CAMPAIGN_ROLES);
      if (campaign.status === 'sent') {
        // Messages already written to the outbox can be on their way out; there
        // is no un-sending them, and saying "cancelled" would be a lie.
        throw conflict('This campaign has already gone out');
      }
      if (campaign.status === 'cancelled') return;
      await tx.marketingCampaign.update({ where: { id: campaignId }, data: { status: 'cancelled', scheduledAt: null } });
      await this.audit(tx, tenantId, campaign.branchId, actor.sub, 'marketing.campaign_cancelled', 'marketing_campaign', campaignId, null);
    });
    return this.getCampaign(tenantId, campaignId);
  }

  /**
   * A real send to one staff address, straight through the transport. It
   * writes no `CommunicationLog` row and no recipient, and its tracking
   * token is never indexed — so a test can't inflate a campaign's open rate
   * and can't leave a marketing message in a guest's history.
   */
  async sendTest(tenantId: string, campaignId: string, email: string, actor: JwtPayload): Promise<{ sentTo: string }> {
    const prepared = await this.prisma.withTenant(tenantId, async (tx) => {
      const campaign = await tx.marketingCampaign.findFirst({ where: { id: campaignId }, include: { branch: { select: { name: true } }, template: true } });
      if (!campaign) throw notFound('Campaign not found');
      assertRoleAtBranch(actor, campaign.branchId, CAMPAIGN_ROLES);
      this.assertSendableChannel(campaign.channel);
      return { campaign, hotelName: campaign.branch.name };
    });

    const tracking = trackingUrlsFor(this.baseUrl, `test-${randomBytes(8).toString('hex')}`, this.clickSecret);
    const examples = exampleContext();
    const context = { ...examples, hotel_name: prepared.hotelName };
    const rendered = renderForRecipient(prepared.campaign.template.body, context, tracking);
    const subject = renderMergeFields(prepared.campaign.subject ?? prepared.campaign.template.subject ?? prepared.campaign.name, {
      ...context,
      unsubscribe_url: tracking.unsubscribeUrl,
    });

    await this.mailTransport.send({ to: email, subject: `[TEST] ${subject}`, body: rendered.text, html: rendered.html });
    await this.prisma.withTenant(tenantId, (tx) =>
      this.audit(tx, tenantId, prepared.campaign.branchId, actor.sub, 'marketing.campaign_test_sent', 'marketing_campaign', campaignId, { to: email }),
    );
    return { sentTo: email };
  }

  /**
   * Materialises the audience into one outbox message per guest.
   *
   * Written to be resumable rather than transactional: a 5,000-recipient send
   * in a single transaction would hold locks for its whole duration, and a
   * crash halfway would roll back messages that were already correct. So the
   * campaign is claimed as `sending` first, recipients are written in batches,
   * and the unique `(campaignId, guestId)` index means a re-run skips everyone
   * who already has a row. `actor` is null when the scheduler is the caller.
   */
  async sendCampaign(tenantId: string, campaignId: string, actor: JwtPayload | null): Promise<CampaignView> {
    const prepared = await this.prisma.withTenant(tenantId, async (tx) => {
      const campaign = await tx.marketingCampaign.findFirst({
        where: { id: campaignId },
        include: { branch: { select: { name: true } }, segment: true, template: true, variantTemplate: true },
      });
      if (!campaign) throw notFound('Campaign not found');
      if (actor) assertRoleAtBranch(actor, campaign.branchId, CAMPAIGN_ROLES);
      this.assertSendableChannel(campaign.channel);
      if (!SENDABLE.includes(campaign.status)) {
        throw conflict(campaign.status === 'sent' ? 'This campaign has already gone out' : `A ${campaign.status} campaign can't be sent`);
      }
      if (campaign.segment.deletedAt) throw invalid('The segment this campaign points at has been deleted');

      // Claim it. Two clicks, or a click racing the scheduler, must not both send.
      const claimed = await tx.marketingCampaign.updateMany({
        where: { id: campaignId, status: { in: SENDABLE } },
        data: { status: 'sending', failureReason: null },
      });
      if (claimed.count === 0) throw conflict('This campaign is already being sent');
      return campaign;
    });

    try {
      const now = new Date();
      const criteria = parseCriteria(prepared.segment.criteria);
      const { audience, alreadySent } = await this.prisma.withTenant(tenantId, async (tx) => ({
        audience: await this.resolveAudience(tx, criteria, now),
        alreadySent: new Set(
          (await tx.campaignRecipient.findMany({ where: { campaignId }, select: { guestId: true } })).map((row) => row.guestId),
        ),
      }));

      if (audience.length === 0) {
        throw invalid(
          `Nobody to send to. ${describeCriteria(criteria).join('; ')} — and every recipient also has to have opted in to marketing with an email address on file.`,
        );
      }
      if (audience.length > MAX_AUDIENCE) {
        throw invalid(`This segment reaches ${audience.length} guests, more than the ${MAX_AUDIENCE} a single campaign can send to. Narrow it first.`);
      }

      const splitRatio = prepared.splitRatio ? Number(prepared.splitRatio) : null;
      const subjectTemplate = prepared.subject ?? prepared.template.subject ?? prepared.name;

      let written = alreadySent.size;
      for (let offset = 0; offset < audience.length; offset += SEND_CHUNK) {
        const chunk = audience.slice(offset, offset + SEND_CHUNK);
        await this.prisma.withTenant(tenantId, async (tx) => {
          for (const [indexInChunk, guest] of chunk.entries()) {
            if (alreadySent.has(guest.id)) continue;
            const index = offset + indexInChunk;
            const variant = variantFor(index, audience.length, splitRatio);
            const body = variant === 'B' && prepared.variantTemplate ? prepared.variantTemplate.body : prepared.template.body;

            const token = randomBytes(24).toString('hex');
            const tracking = trackingUrlsFor(this.baseUrl, token, this.clickSecret);
            const context = {
              guest_name: guest.name,
              guest_first_name: guest.name.trim().split(/\s+/)[0] ?? guest.name,
              hotel_name: prepared.branch.name,
              loyalty_tier: guest.loyaltyTier ?? 'Member',
              loyalty_points: String(guest.loyaltyPoints ?? 0),
            };
            const rendered = renderForRecipient(body, context, tracking);

            const message = await tx.communicationLog.create({
              data: {
                tenantId,
                branchId: prepared.branchId,
                guestId: guest.id,
                channel: 'email',
                subject: renderMergeFields(subjectTemplate, { ...context, unsubscribe_url: tracking.unsubscribeUrl }),
                body: rendered.text,
                bodyHtml: rendered.html,
                trigger: MARKETING_CAMPAIGN_TRIGGER,
                deliveryStatus: 'queued',
                sentBy: actor?.sub ?? null,
              },
            });
            const recipient = await tx.campaignRecipient.create({
              data: { tenantId, campaignId, guestId: guest.id, variant, communicationLogId: message.id },
            });
            // The token index has no RLS, but writing it through the same
            // transaction keeps it atomic with the recipient it points at —
            // there is never a live tracking link without a row behind it.
            await tx.marketingTokenIndex.create({ data: { token, tenantId, recipientId: recipient.id } });
            written += 1;
          }
        });
      }

      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.marketingCampaign.update({
          where: { id: campaignId },
          data: { status: 'sent', sentAt: new Date(), recipientCount: written, failureReason: null },
        });
        await this.audit(tx, tenantId, prepared.branchId, actor?.sub ?? null, 'marketing.campaign_sent', 'marketing_campaign', campaignId, {
          recipients: written,
          variantB: splitRatio !== null,
        });
      });
      this.logger.log(`Campaign ${campaignId} queued ${written} message(s) for delivery`);
      return this.getCampaign(tenantId, campaignId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const messageOf = (value: unknown): string => {
        if (typeof value === 'object' && value !== null && 'message' in value) {
          const inner = (value as { message?: unknown }).message;
          if (typeof inner === 'string') return inner;
        }
        return reason;
      };
      const response = err instanceof BadRequestException || err instanceof ConflictException ? messageOf(err.getResponse()) : reason;
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.marketingCampaign.update({
          where: { id: campaignId },
          // Always `failed`, never back to `scheduled`: a scheduled campaign
          // restored to the queue would be retried every minute for the same
          // reason forever. `failed` is editable and re-sendable, so the fix
          // is one edit away and nothing loops in the meantime.
          data: { status: 'failed', failureReason: response.slice(0, 500) },
        }),
      );
      throw err;
    }
  }

  /**
   * `actor` is checked against the campaign's own branch: the view lists
   * recipients by name and address, and `RolesGuard` alone would accept a
   * manager of any branch. Internal callers that have already checked pass none.
   */
  async getCampaign(tenantId: string, campaignId: string, actor?: JwtPayload): Promise<CampaignView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const campaign = await tx.marketingCampaign.findFirst({
        where: { id: campaignId },
        include: { segment: true, template: { select: { id: true, name: true } }, variantTemplate: { select: { id: true, name: true } } },
      });
      if (!campaign) throw notFound('Campaign not found');
      if (actor) assertRoleAtBranch(actor, campaign.branchId, CAMPAIGN_ROLES);

      const recipients = await tx.campaignRecipient.findMany({
        where: { campaignId },
        orderBy: { sentAt: 'asc' },
        take: RECIPIENT_ROWS,
        include: { guest: { select: { id: true, name: true, email: true } }, communicationLog: { select: { deliveryStatus: true } } },
      });

      const [total, opened, clicked, unsubscribed, deliveryCounts] = await Promise.all([
        tx.campaignRecipient.count({ where: { campaignId } }),
        tx.campaignRecipient.count({ where: { campaignId, openedAt: { not: null } } }),
        tx.campaignRecipient.count({ where: { campaignId, clickedAt: { not: null } } }),
        tx.campaignRecipient.count({ where: { campaignId, unsubscribedAt: { not: null } } }),
        tx.communicationLog.groupBy({
          by: ['deliveryStatus'],
          where: { campaignRecipient: { campaignId } },
          _count: { _all: true },
        }),
      ]);

      const countFor = (status: string): number => deliveryCounts.find((row) => row.deliveryStatus === status)?._count._all ?? 0;
      const variants = await tx.campaignRecipient.groupBy({ by: ['variant'], where: { campaignId }, _count: { _all: true } });
      const byVariant: CampaignPerformance['byVariant'] = [];
      for (const row of variants) {
        const [variantOpened, variantClicked] = await Promise.all([
          tx.campaignRecipient.count({ where: { campaignId, variant: row.variant, openedAt: { not: null } } }),
          tx.campaignRecipient.count({ where: { campaignId, variant: row.variant, clickedAt: { not: null } } }),
        ]);
        byVariant.push({ variant: row.variant, recipients: row._count._all, opened: variantOpened, clicked: variantClicked });
      }

      let bookingsAfterSend: number | null = null;
      if (campaign.sentAt && total > 0) {
        const guestIds = (await tx.campaignRecipient.findMany({ where: { campaignId }, select: { guestId: true } })).map((row) => row.guestId);
        bookingsAfterSend = await tx.reservation.count({
          where: {
            branchId: campaign.branchId,
            guestId: { in: guestIds },
            deletedAt: null,
            createdAt: { gte: campaign.sentAt, lte: new Date(campaign.sentAt.getTime() + CONVERSION_WINDOW_DAYS * 86_400_000) },
          },
        });
      }

      const criteria = parseCriteria(campaign.segment.criteria);
      return {
        id: campaign.id,
        branchId: campaign.branchId,
        name: campaign.name,
        channel: campaign.channel,
        status: campaign.status,
        subject: campaign.subject,
        segment: { id: campaign.segment.id, name: campaign.segment.name, rules: describeCriteria(criteria) },
        template: campaign.template,
        variantTemplate: campaign.variantTemplate,
        splitRatio: campaign.splitRatio ? campaign.splitRatio.toFixed(2) : null,
        scheduledAt: campaign.scheduledAt,
        sentAt: campaign.sentAt,
        recipientCount: campaign.recipientCount,
        failureReason: campaign.failureReason,
        createdAt: campaign.createdAt,
        performance: {
          recipients: total,
          // 'opened' is its own delivery status, so a message that was opened
          // is no longer counted as merely sent — the two add up to delivered.
          sent: countFor('sent') + countFor('delivered') + countFor('opened'),
          failed: countFor('failed') + countFor('bounced'),
          queued: countFor('queued'),
          opened,
          clicked,
          unsubscribed,
          openRate: total > 0 ? Number((opened / total).toFixed(4)) : null,
          clickRate: total > 0 ? Number((clicked / total).toFixed(4)) : null,
          byVariant,
          bookingsAfterSend,
        },
        recipients: recipients.map((row) => ({
          id: row.id,
          guestId: row.guest.id,
          guestName: row.guest.name,
          email: row.guest.email,
          variant: row.variant,
          deliveryStatus: row.communicationLog?.deliveryStatus ?? null,
          openedAt: row.openedAt,
          clickedAt: row.clickedAt,
          unsubscribedAt: row.unsubscribedAt,
        })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Tracking — reached from a guest's mail client, with no session
  // -------------------------------------------------------------------------

  /** First open only: a pixel is fetched every time the message is re-displayed, and "opened twice" is not a thing this reports. */
  async recordOpen(token: string): Promise<void> {
    const pointer = await this.resolveToken(token);
    if (!pointer) return;
    await this.prisma.withTenant(pointer.tenantId, async (tx) => {
      const updated = await tx.campaignRecipient.updateMany({ where: { id: pointer.recipientId, openedAt: null }, data: { openedAt: new Date() } });
      if (updated.count === 0) return;
      await tx.communicationLog.updateMany({
        where: { campaignRecipient: { id: pointer.recipientId }, deliveryStatus: { in: ['queued', 'sent', 'delivered'] } },
        data: { deliveryStatus: 'opened' },
      });
    });
  }

  /**
   * Records the click and returns where to send the guest. The destination is
   * only trusted once its signature verifies — an unsigned or edited `u` is
   * refused rather than redirected, so this route is not an open redirect.
   */
  async recordClick(token: string, target: string, signature: string): Promise<string> {
    if (!verifyTarget(token, target, signature, this.clickSecret)) {
      throw invalid('This link has been altered');
    }
    const pointer = await this.resolveToken(token);
    if (pointer) {
      await this.prisma.withTenant(pointer.tenantId, async (tx) => {
        const now = new Date();
        // A click implies an open even when the pixel never loaded — most
        // mail clients block remote images, so this is the commoner case.
        await tx.campaignRecipient.updateMany({ where: { id: pointer.recipientId, clickedAt: null }, data: { clickedAt: now } });
        await tx.campaignRecipient.updateMany({ where: { id: pointer.recipientId, openedAt: null }, data: { openedAt: now } });
      });
    }
    return target;
  }

  /** What the unsubscribe page shows before asking for confirmation. Never reveals more than the guest's own name. */
  async describeUnsubscribe(token: string): Promise<UnsubscribeResult> {
    const pointer = await this.resolveToken(token);
    if (!pointer) throw notFound('This link is no longer valid');
    return this.prisma.withTenant(pointer.tenantId, async (tx) => {
      const recipient = await tx.campaignRecipient.findFirst({
        where: { id: pointer.recipientId },
        include: { guest: { select: { name: true, marketingOptIn: true } }, campaign: { select: { branch: { select: { name: true } } } } },
      });
      if (!recipient) throw notFound('This link is no longer valid');
      return {
        guestName: recipient.guest.name,
        hotelName: recipient.campaign.branch.name,
        alreadyUnsubscribed: !recipient.guest.marketingOptIn,
      };
    });
  }

  /**
   * The opt-out itself, on POST only. A GET that unsubscribed would fire
   * every time a mail client, security scanner or link preview fetched the
   * link — opting people out who never clicked anything.
   */
  async unsubscribe(token: string): Promise<UnsubscribeResult> {
    const pointer = await this.resolveToken(token);
    if (!pointer) throw notFound('This link is no longer valid');
    return this.prisma.withTenant(pointer.tenantId, async (tx) => {
      const recipient = await tx.campaignRecipient.findFirst({
        where: { id: pointer.recipientId },
        include: { guest: { select: { id: true, name: true, marketingOptIn: true } }, campaign: { select: { branchId: true, branch: { select: { name: true } } } } },
      });
      if (!recipient) throw notFound('This link is no longer valid');
      const alreadyUnsubscribed = !recipient.guest.marketingOptIn;

      if (!alreadyUnsubscribed) {
        await tx.guestProfile.update({
          where: { id: recipient.guest.id },
          // `marketingOptInAt` is left as it was: the record of when consent was
          // given is what makes the opt-out auditable, so it isn't erased.
          data: { marketingOptIn: false, marketingUnsubscribedAt: new Date() },
        });
      }
      await tx.campaignRecipient.updateMany({ where: { id: recipient.id, unsubscribedAt: null }, data: { unsubscribedAt: new Date() } });
      await this.audit(tx, pointer.tenantId, recipient.campaign.branchId, null, 'marketing.unsubscribed', 'guest_profile', recipient.guest.id, {
        campaignId: recipient.campaignId,
      });

      return { guestName: recipient.guest.name, hotelName: recipient.campaign.branch.name, alreadyUnsubscribed };
    });
  }

  /** The front desk recording consent (or its withdrawal) on the guest's behalf — at the desk, on the phone, on a form. */
  async setConsent(tenantId: string, guestId: string, optIn: boolean, actorId: string): Promise<{ marketingOptIn: boolean; marketingOptInAt: Date | null }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const guest = await tx.guestProfile.findFirst({ where: { id: guestId, deletedAt: null } });
      if (!guest) throw notFound('Guest not found');
      const now = new Date();
      const updated = await tx.guestProfile.update({
        where: { id: guestId },
        data: optIn
          ? {
              marketingOptIn: true,
              // Consent given again after an opt-out is NEW consent: it carries
              // today's date, not the date of the consent they withdrew.
              marketingOptInAt: guest.marketingOptIn ? (guest.marketingOptInAt ?? now) : now,
              marketingOptInSource: guest.marketingOptIn ? guest.marketingOptInSource : 'front_desk',
            }
          : { marketingOptIn: false, marketingUnsubscribedAt: now },
      });
      await this.audit(tx, tenantId, null, actorId, optIn ? 'marketing.consent_given' : 'marketing.consent_withdrawn', 'guest_profile', guestId, null);
      return { marketingOptIn: updated.marketingOptIn, marketingOptInAt: updated.marketingOptInAt };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Everyone a campaign with these criteria would go to, in a stable order so
   * the A/B split is reproducible for a resumed send.
   */
  private async resolveAudience(tx: TenantTx, criteria: SegmentCriteria, now: Date): Promise<AudienceMember[]> {
    const where = { ...guestWhereFor(criteria, now), ...MARKETING_CONSENT_FLOOR };
    const candidates = await this.candidates(tx, where, MAX_CANDIDATES + 1);
    if (candidates.length > MAX_CANDIDATES) {
      throw invalid(`This segment matches more than ${MAX_CANDIDATES} guests, too many to evaluate. Narrow it first.`);
    }
    return needsAggregates(criteria) ? this.applyAggregates(tx, candidates, criteria, now) : candidates;
  }

  private async candidates(tx: TenantTx, where: Prisma.GuestProfileWhereInput, take?: number): Promise<AudienceMember[]> {
    return tx.guestProfile.findMany({
      where,
      select: { id: true, name: true, email: true, loyaltyTier: true, loyaltyPoints: true, vipLevel: true },
      orderBy: { createdAt: 'asc' },
      ...(take ? { take } : {}),
    });
  }

  /**
   * Stay count and lifetime spend per guest, then the pure predicate.
   * `totalSpend` is the same figure the guest profile shows — every non-void
   * payment across their folios — so a segment and a profile can never
   * disagree about what someone has spent.
   */
  private async applyAggregates(tx: TenantTx, candidates: AudienceMember[], criteria: SegmentCriteria, now: Date): Promise<AudienceMember[]> {
    if (candidates.length === 0) return candidates;
    const guestIds = candidates.map((guest) => guest.id);

    const [stayRows, folios] = await Promise.all([
      tx.reservation.groupBy({
        by: ['guestId'],
        where: { guestId: { in: guestIds }, status: 'checked_out', deletedAt: null },
        _count: { _all: true },
        _max: { checkOutDate: true },
      }),
      tx.folio.findMany({ where: { guestId: { in: guestIds } }, select: { id: true, guestId: true } }),
    ]);

    const spendByGuest = new Map<string, Prisma.Decimal>();
    if (folios.length > 0) {
      const guestOfFolio = new Map(folios.map((folio) => [folio.id, folio.guestId]));
      const paymentRows = await tx.payment.groupBy({
        by: ['folioId'],
        where: { folioId: { in: folios.map((folio) => folio.id) }, isVoid: false, deletedAt: null },
        _sum: { amount: true },
      });
      for (const row of paymentRows) {
        const guestId = guestOfFolio.get(row.folioId);
        if (!guestId) continue;
        const running = spendByGuest.get(guestId) ?? new Prisma.Decimal(0);
        spendByGuest.set(guestId, running.plus(row._sum.amount ?? 0));
      }
    }

    const staysByGuest = new Map(stayRows.map((row) => [row.guestId, row]));
    return candidates.filter((guest) => {
      const stays = staysByGuest.get(guest.id);
      const aggregates: GuestAggregates = {
        stays: stays?._count._all ?? 0,
        totalSpend: spendByGuest.get(guest.id) ?? new Prisma.Decimal(0),
        lastStayAt: stays?._max.checkOutDate ?? null,
      };
      return matchesAggregates(aggregates, criteria, now);
    });
  }

  private async resolveToken(token: string): Promise<{ tenantId: string; recipientId: string } | null> {
    if (!/^[0-9a-f]{8,64}$/.test(token)) return null;
    // Outside withTenant deliberately: this table has no RLS precisely because
    // the request that needs it has no tenant yet. See MarketingTokenIndex.
    const pointer = await this.prisma.marketingTokenIndex.findUnique({ where: { token } });
    return pointer ? { tenantId: pointer.tenantId, recipientId: pointer.recipientId } : null;
  }

  /**
   * Only email has a transport. An SMS or push campaign would sit in the
   * outbox forever while its status said `sent`, so it's refused at the door
   * with the reason — the same honesty the comms dispatcher applies when it
   * leaves those channels queued instead of claiming a delivery.
   */
  private assertSendableChannel(channel: string): void {
    if (channel !== 'email') {
      throw invalid(`There's no ${channel} provider connected, so a ${channel} campaign can't be sent. Email works today.`);
    }
  }

  private assertMergeFields(body: string, subject?: string): void {
    const unknown = [...unknownMergeFields(body), ...unknownMergeFields(subject ?? '')];
    if (unknown.length > 0) {
      const known = MERGE_FIELDS.map((field) => `{{${field.token}}}`).join(', ');
      throw invalid(`Unknown merge ${unknown.length === 1 ? 'field' : 'fields'} ${unknown.map((name) => `{{${name}}}`).join(', ')}. Available: ${known}`);
    }
  }

  private parseSchedule(value: string): Date {
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) throw invalid('The send time is not a valid date');
    // One minute of slack: a form submitted at 09:00:00 for 09:00 is a send-now,
    // not an error, and the scheduler picks it up on its next tick either way.
    if (when.getTime() < Date.now() - 60_000) throw invalid('That send time has already passed');
    return when;
  }

  private async loadSegment(tx: TenantTx, segmentId: string): Promise<GuestSegment> {
    const segment = await tx.guestSegment.findFirst({ where: { id: segmentId, deletedAt: null } });
    if (!segment) throw notFound('Segment not found');
    return segment;
  }

  private async loadTemplate(tx: TenantTx, templateId: string): Promise<MessageTemplate> {
    const template = await tx.messageTemplate.findFirst({ where: { id: templateId, deletedAt: null } });
    if (!template) throw notFound('Template not found');
    return template;
  }

  private async assertVariant(tx: TenantTx, templateId: string, variantTemplateId: string): Promise<void> {
    if (templateId === variantTemplateId) {
      throw invalid('An A/B test needs two different templates — variant B is the same one as variant A');
    }
    await this.loadTemplate(tx, variantTemplateId);
  }

  private toSegmentView(segment: GuestSegment): SegmentView {
    const criteria = parseCriteria(segment.criteria);
    return {
      id: segment.id,
      name: segment.name,
      description: segment.description,
      criteria,
      rules: describeCriteria(criteria),
      createdAt: segment.createdAt,
      updatedAt: segment.updatedAt,
    };
  }

  private toTemplateView(template: MessageTemplate): TemplateView {
    return { id: template.id, name: template.name, subject: template.subject, body: template.body, createdAt: template.createdAt, updatedAt: template.updatedAt };
  }

  private async audit(
    tx: TenantTx,
    tenantId: string,
    branchId: string | null,
    userId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    after: Prisma.InputJsonValue | null,
  ): Promise<void> {
    await tx.auditLog.create({ data: { tenantId, branchId, userId, action, entityType, entityId, ...(after ? { after } : {}) } });
  }
}

/** The MERGE_FIELDS examples as a context, for a preview or a test send — no guest involved. */
function exampleContext(): Omit<MergeContext, 'unsubscribe_url'> {
  const byToken = new Map(MERGE_FIELDS.map((field) => [field.token, field.example]));
  const example = (token: string): string => byToken.get(token) ?? '';
  return {
    guest_name: example('guest_name'),
    guest_first_name: example('guest_first_name'),
    hotel_name: example('hotel_name'),
    loyalty_tier: example('loyalty_tier'),
    loyalty_points: example('loyalty_points'),
  };
}

interface AudienceMember {
  id: string;
  name: string;
  email: string | null;
  loyaltyTier: string | null;
  loyaltyPoints: number | null;
  vipLevel: number | null;
}
