import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { MAIL_TRANSPORT } from '../../common/mail/mail-transport.interface';
import { JwtPayload } from '../../common/types/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { MARKETING_CAMPAIGN_TRIGGER } from '../comms-log/comms-log.service';
import { PropertyService } from '../property/property.service';
import { signTarget } from './campaign-render';
import { MarketingService } from './marketing.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BRANCH_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_BRANCH_ID = '99999999-9999-4999-8999-999999999999';
const CAMPAIGN_ID = '33333333-3333-4333-8333-333333333333';
const SEGMENT_ID = '44444444-4444-4444-8444-444444444444';
const TEMPLATE_ID = '55555555-5555-4555-8555-555555555555';
const VARIANT_ID = '66666666-6666-4666-8666-666666666666';
const ACTOR_ID = '77777777-7777-4777-8777-777777777777';
const GUEST_ID = '88888888-8888-4888-8888-888888888888';
const TOKEN = 'ab'.repeat(24);

function actor(role = 'manager', branchId: string | null = BRANCH_ID): JwtPayload {
  return { sub: ACTOR_ID, tenantId: TENANT_ID, email: 'gm@example.com', roles: [{ branchId, role }], tokenType: 'access' };
}

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID,
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    name: 'Win-back',
    channel: 'email',
    segmentId: SEGMENT_ID,
    templateId: TEMPLATE_ID,
    subject: null,
    status: 'draft',
    scheduledAt: null,
    sentAt: null,
    variantTemplateId: null,
    splitRatio: null,
    recipientCount: 0,
    failureReason: null,
    createdBy: ACTOR_ID,
    createdAt: new Date('2026-09-01'),
    updatedAt: new Date('2026-09-01'),
    branch: { name: 'Lekki Palms Hotel' },
    segment: { id: SEGMENT_ID, name: 'Lapsed', criteria: { notStayedForDays: 180 }, deletedAt: null },
    template: { id: TEMPLATE_ID, name: 'Come back', subject: 'We miss you, {{guest_first_name}}', body: 'Hello {{guest_name}}, book at https://hotel.example/offer' },
    variantTemplate: null,
    ...overrides,
  };
}

const guest = (n: number) => ({
  id: `${n}0000000-0000-4000-8000-000000000000`.slice(0, 36),
  name: `Guest Number${n}`,
  email: `guest${n}@example.com`,
  loyaltyTier: n % 2 ? 'Silver' : null,
  loyaltyPoints: n * 10,
  vipLevel: 0,
});

describe('MarketingService', () => {
  let service: MarketingService;
  let tx: ReturnType<typeof makeTx>;
  let prisma: { withTenant: jest.Mock; marketingTokenIndex: { findUnique: jest.Mock } };
  let mail: { send: jest.Mock; name: string };

  function makeTx() {
    return {
      marketingCampaign: {
        findFirst: jest.fn().mockResolvedValue(campaign()),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue(campaign()),
        count: jest.fn().mockResolvedValue(0),
      },
      guestSegment: {
        findFirst: jest.fn().mockResolvedValue({ id: SEGMENT_ID, name: 'Lapsed', criteria: {}, deletedAt: null }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      messageTemplate: {
        findFirst: jest.fn().mockResolvedValue({ id: TEMPLATE_ID, name: 'Come back', subject: null, body: 'x', deletedAt: null }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
      },
      guestProfile: {
        findMany: jest.fn().mockResolvedValue([guest(1), guest(2), guest(3), guest(4)]),
        count: jest.fn().mockResolvedValue(4),
        findFirst: jest.fn(),
        update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ marketingOptIn: false, marketingOptInAt: null, ...data })),
      },
      campaignRecipient: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: `recipient-${String(data.guestId)}`, ...data })),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      communicationLog: {
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: `message-${String(data.guestId)}`, ...data })),
        groupBy: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      marketingTokenIndex: { create: jest.fn().mockResolvedValue({}) },
      reservation: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      folio: { findMany: jest.fn().mockResolvedValue([]) },
      payment: { groupBy: jest.fn().mockResolvedValue([]) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  beforeEach(async () => {
    tx = makeTx();
    prisma = {
      withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)),
      marketingTokenIndex: { findUnique: jest.fn().mockResolvedValue({ token: TOKEN, tenantId: TENANT_ID, recipientId: 'recipient-1' }) },
    };
    mail = { send: jest.fn().mockResolvedValue({ externalMessageId: 'log:1' }), name: 'log' };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MarketingService,
        { provide: PrismaService, useValue: prisma },
        { provide: PropertyService, useValue: { assertBranch: jest.fn().mockResolvedValue({ id: BRANCH_ID }) } },
        { provide: MAIL_TRANSPORT, useValue: mail },
      ],
    }).compile();
    service = moduleRef.get(MarketingService);
  });

  describe('sendCampaign', () => {
    it('only ever reaches guests who opted in and have an email address, whatever the segment says', async () => {
      await service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor());
      const where = (tx.guestProfile.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
      expect(where).toMatchObject({ marketingOptIn: true, email: { not: null }, deletedAt: null });
    });

    it('writes one queued outbox message per guest, with an HTML twin, through the ordinary comms log', async () => {
      await service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor());
      expect(tx.communicationLog.create).toHaveBeenCalledTimes(4);
      const data = (tx.communicationLog.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({
        channel: 'email',
        trigger: MARKETING_CAMPAIGN_TRIGGER,
        deliveryStatus: 'queued',
        branchId: BRANCH_ID,
        subject: 'We miss you, Guest',
        sentBy: ACTOR_ID,
      });
      expect(data.reservationId).toBeUndefined();
      expect(String(data.body)).toContain('Hello Guest Number1');
      expect(String(data.body)).toContain('/public/marketing/click/');
      expect(String(data.bodyHtml)).toContain('/public/marketing/open/');
    });

    it('indexes a tracking token for every recipient inside the same transaction as the recipient', async () => {
      await service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor());
      expect(tx.marketingTokenIndex.create).toHaveBeenCalledTimes(4);
      const tokenRow = (tx.marketingTokenIndex.create.mock.calls[0][0] as { data: { token: string; tenantId: string; recipientId: string } }).data;
      expect(tokenRow.tenantId).toBe(TENANT_ID);
      expect(tokenRow.token).toMatch(/^[0-9a-f]{48}$/);
      expect(tokenRow.recipientId).toBe(`recipient-${guest(1).id}`);
    });

    it('marks the campaign sent with the number of messages written', async () => {
      await service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor());
      const sent = tx.marketingCampaign.update.mock.calls.find((call) => (call[0] as { data: { status?: string } }).data.status === 'sent');
      expect(sent).toBeDefined();
      expect((sent![0] as { data: Record<string, unknown> }).data).toMatchObject({ status: 'sent', recipientCount: 4, failureReason: null });
    });

    it('splits an A/B test exactly and sends variant B its own template', async () => {
      tx.marketingCampaign.findFirst.mockResolvedValue(
        campaign({
          variantTemplateId: VARIANT_ID,
          splitRatio: new Prisma.Decimal('0.5'),
          variantTemplate: { id: VARIANT_ID, name: 'Variant', subject: null, body: 'Variant B for {{guest_first_name}}' },
        }),
      );
      await service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor());
      const variants = tx.campaignRecipient.create.mock.calls.map((call) => (call[0] as { data: { variant: string } }).data.variant);
      expect(variants).toEqual(['A', 'A', 'B', 'B']);
      const bodies = tx.communicationLog.create.mock.calls.map((call) => String((call[0] as { data: { body: string } }).data.body));
      expect(bodies[0]).toContain('Hello Guest Number1');
      expect(bodies[3]).toContain('Variant B for Guest');
    });

    it('resumes an interrupted send without messaging anyone twice', async () => {
      tx.marketingCampaign.findFirst.mockResolvedValue(campaign({ status: 'sending' }));
      tx.campaignRecipient.findMany.mockResolvedValueOnce([{ guestId: guest(1).id }, { guestId: guest(2).id }]);
      await service.sendCampaign(TENANT_ID, CAMPAIGN_ID, null);
      const reached = tx.communicationLog.create.mock.calls.map((call) => (call[0] as { data: { guestId: string } }).data.guestId);
      expect(reached).toEqual([guest(3).id, guest(4).id]);
      const sent = tx.marketingCampaign.update.mock.calls.find((call) => (call[0] as { data: { status?: string } }).data.status === 'sent');
      expect((sent![0] as { data: { recipientCount: number } }).data.recipientCount).toBe(4);
    });

    it('refuses to send twice when another click or the scheduler got there first', async () => {
      tx.marketingCampaign.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor())).rejects.toBeInstanceOf(ConflictException);
      expect(tx.communicationLog.create).not.toHaveBeenCalled();
    });

    it('refuses a campaign that already went out', async () => {
      tx.marketingCampaign.findFirst.mockResolvedValue(campaign({ status: 'sent' }));
      await expect(service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor())).rejects.toThrow('already gone out');
    });

    it('refuses an SMS campaign rather than leaving it queued forever while it claims to be sent', async () => {
      tx.marketingCampaign.findFirst.mockResolvedValue(campaign({ channel: 'sms' }));
      await expect(service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor())).rejects.toThrow(/no sms provider/);
      expect(tx.marketingCampaign.updateMany).not.toHaveBeenCalled();
    });

    it('fails an empty audience with the reason recorded on the campaign, and sends nothing', async () => {
      tx.guestProfile.findMany.mockResolvedValue([]);
      await expect(service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor())).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.communicationLog.create).not.toHaveBeenCalled();
      const failed = tx.marketingCampaign.update.mock.calls.at(-1)![0] as { data: { status: string; failureReason: string } };
      expect(failed.data.status).toBe('failed');
      expect(failed.data.failureReason).toMatch(/^Nobody to send to/);
    });

    it('only lets a manager of the campaign’s own branch send it', async () => {
      await expect(service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor('manager', OTHER_BRANCH_ID))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor('front_desk'))).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.marketingCampaign.updateMany).not.toHaveBeenCalled();
    });

    it('counts stays and spend for the rules that need them — spend being non-void payments, as on the guest profile', async () => {
      tx.marketingCampaign.findFirst.mockResolvedValue(campaign({ segment: { id: SEGMENT_ID, name: 'Big spenders', criteria: { minTotalSpend: 100000 }, deletedAt: null } }));
      tx.folio.findMany.mockResolvedValue([
        { id: 'folio-1', guestId: guest(1).id },
        { id: 'folio-2', guestId: guest(2).id },
      ]);
      tx.payment.groupBy.mockResolvedValue([
        { folioId: 'folio-1', _sum: { amount: new Prisma.Decimal('120000') } },
        { folioId: 'folio-2', _sum: { amount: new Prisma.Decimal('99999.99') } },
      ]);
      await service.sendCampaign(TENANT_ID, CAMPAIGN_ID, actor());
      expect((tx.payment.groupBy.mock.calls[0][0] as { where: Record<string, unknown> }).where).toMatchObject({ isVoid: false, deletedAt: null });
      const reached = tx.communicationLog.create.mock.calls.map((call) => (call[0] as { data: { guestId: string } }).data.guestId);
      expect(reached).toEqual([guest(1).id]);
    });
  });

  it('says when campaigns only reach the server log', () => {
    expect(service.deliveryStatus()).toEqual({ transport: 'log', deliversExternally: false });
  });

  describe('sendTest', () => {
    it('goes straight to the transport, marked as a test, and records nothing against any guest', async () => {
      await service.sendTest(TENANT_ID, CAMPAIGN_ID, 'gm@example.com', actor());
      expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'gm@example.com', subject: '[TEST] We miss you, Kemi' }));
      expect((mail.send.mock.calls[0][0] as { html: string }).html).toContain('Lekki Palms Hotel');
      expect(tx.communicationLog.create).not.toHaveBeenCalled();
      expect(tx.campaignRecipient.create).not.toHaveBeenCalled();
      expect(tx.marketingTokenIndex.create).not.toHaveBeenCalled();
    });
  });

  describe('campaign editing', () => {
    it('refuses to edit a campaign that has gone out', async () => {
      tx.marketingCampaign.findFirst.mockResolvedValue(campaign({ status: 'sent' }));
      await expect(service.updateCampaign(TENANT_ID, CAMPAIGN_ID, { name: 'New' }, actor())).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses an A/B test whose variant is the same template', async () => {
      await expect(
        service.createCampaign(TENANT_ID, BRANCH_ID, { name: 'X', channel: 'email', segmentId: SEGMENT_ID, templateId: TEMPLATE_ID, abTest: { variantTemplateId: TEMPLATE_ID, splitRatio: 0.5 } }, ACTOR_ID),
      ).rejects.toThrow(/two different templates/);
    });

    it('refuses a send time already in the past', async () => {
      await expect(
        service.createCampaign(TENANT_ID, BRANCH_ID, { name: 'X', channel: 'email', segmentId: SEGMENT_ID, templateId: TEMPLATE_ID, scheduledAt: '2020-01-01T09:00:00Z' }, ACTOR_ID),
      ).rejects.toThrow(/already passed/);
    });

    it('won’t cancel a campaign that has already gone out', async () => {
      tx.marketingCampaign.findFirst.mockResolvedValue(campaign({ status: 'sent' }));
      await expect(service.cancelCampaign(TENANT_ID, CAMPAIGN_ID, actor())).rejects.toBeInstanceOf(ConflictException);
    });

    it('re-checks the role at the campaign’s branch when reading it — the view lists guests by name and address', async () => {
      await expect(service.getCampaign(TENANT_ID, CAMPAIGN_ID, actor('manager', OTHER_BRANCH_ID))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('templates and segments', () => {
    it('refuses a template that uses a placeholder that doesn’t exist', async () => {
      await expect(service.saveTemplate(TENANT_ID, { name: 'Bad', body: 'Hi {{first_name}}, welcome back' }, ACTOR_ID)).rejects.toThrow(/\{\{first_name\}\}/);
    });

    it('won’t retire a segment an unsent campaign still points at', async () => {
      tx.marketingCampaign.count.mockResolvedValue(1);
      await expect(service.deleteSegment(TENANT_ID, SEGMENT_ID, ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(tx.guestSegment.update).not.toHaveBeenCalled();
    });

    it('previews both how many guests match and how many can actually be emailed', async () => {
      tx.guestProfile.count.mockResolvedValue(10);
      const preview = await service.previewSegment(TENANT_ID, { vipLevelMin: 2 });
      expect(preview).toMatchObject({ matching: 10, reachable: 4, tooLarge: false });
      expect(preview.sample).toHaveLength(4);
    });
  });

  describe('tracking', () => {
    it('records the first open only, and marks the message opened', async () => {
      await service.recordOpen(TOKEN);
      expect(tx.campaignRecipient.updateMany).toHaveBeenCalledWith({ where: { id: 'recipient-1', openedAt: null }, data: { openedAt: expect.any(Date) } });
      expect(tx.communicationLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { deliveryStatus: 'opened' } }));
    });

    it('ignores a token nobody issued', async () => {
      prisma.marketingTokenIndex.findUnique.mockResolvedValue(null);
      await service.recordOpen(TOKEN);
      expect(prisma.withTenant).not.toHaveBeenCalled();
    });

    it('refuses to redirect to a destination whose signature does not match — no open redirect', async () => {
      await expect(service.recordClick(TOKEN, 'https://evil.example/', '0'.repeat(32))).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.marketingTokenIndex.findUnique).not.toHaveBeenCalled();
    });

    it('counts a click, and the open it implies, then returns the signed destination', async () => {
      const secret = (service as unknown as { clickSecret: string }).clickSecret;
      const target = 'https://hotel.example/offer';
      await expect(service.recordClick(TOKEN, target, signTarget(TOKEN, target, secret))).resolves.toBe(target);
      expect(tx.campaignRecipient.updateMany).toHaveBeenCalledWith({ where: { id: 'recipient-1', clickedAt: null }, data: { clickedAt: expect.any(Date) } });
      expect(tx.campaignRecipient.updateMany).toHaveBeenCalledWith({ where: { id: 'recipient-1', openedAt: null }, data: { openedAt: expect.any(Date) } });
    });
  });

  describe('consent', () => {
    const recipient = (optedIn: boolean) => ({
      id: 'recipient-1',
      campaignId: CAMPAIGN_ID,
      guest: { id: GUEST_ID, name: 'Kemi Adeyemi', marketingOptIn: optedIn },
      campaign: { branchId: BRANCH_ID, branch: { name: 'Lekki Palms Hotel' } },
    });

    it('unsubscribing withdraws consent but keeps the date it was given', async () => {
      tx.campaignRecipient.findFirst.mockResolvedValue(recipient(true));
      const result = await service.unsubscribe(TOKEN);
      expect(result).toEqual({ guestName: 'Kemi Adeyemi', hotelName: 'Lekki Palms Hotel', alreadyUnsubscribed: false });
      const data = (tx.guestProfile.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
      expect(data).toEqual({ marketingOptIn: false, marketingUnsubscribedAt: expect.any(Date) });
    });

    it('a second unsubscribe says so and doesn’t overwrite when they left', async () => {
      tx.campaignRecipient.findFirst.mockResolvedValue(recipient(false));
      const result = await service.unsubscribe(TOKEN);
      expect(result.alreadyUnsubscribed).toBe(true);
      expect(tx.guestProfile.update).not.toHaveBeenCalled();
    });

    it('consent given again after an opt-out carries today’s date, not the old one', async () => {
      tx.guestProfile.findFirst.mockResolvedValue({
        id: GUEST_ID,
        marketingOptIn: false,
        marketingOptInAt: new Date('2025-01-01'),
        marketingOptInSource: 'booking_engine',
        deletedAt: null,
      });
      await service.setConsent(TENANT_ID, GUEST_ID, true, ACTOR_ID);
      const data = (tx.guestProfile.update.mock.calls[0][0] as { data: { marketingOptInAt: Date; marketingOptInSource: string } }).data;
      expect(data.marketingOptInAt.getFullYear()).toBeGreaterThan(2025);
      expect(data.marketingOptInSource).toBe('front_desk');
    });
  });
});
