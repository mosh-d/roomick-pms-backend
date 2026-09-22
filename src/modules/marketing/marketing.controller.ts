import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Public } from '../../common/decorators/public.decorator';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { escapeHtml } from './campaign-render';
import {
  CampaignListQueryDto,
  ClickQueryDto,
  CreateCampaignDto,
  PreviewSegmentDto,
  PreviewTemplateDto,
  SaveSegmentDto,
  SaveTemplateDto,
  SendTestDto,
  SetMarketingConsentDto,
  UpdateCampaignDto,
} from './dto/marketing.dto';
import { CampaignSummary, CampaignView, MarketingService, SegmentPreview, SegmentView, TemplateView } from './marketing.service';

/**
 * Staff side of the Email Campaign Builder. Segments and templates are
 * tenant-wide (guests are); a campaign is sent from one branch, so it's
 * created under that branch and every record-addressed route re-checks the
 * role at the campaign's own branch.
 */
@ApiTags('marketing')
@ApiBearerAuth()
@Controller()
export class MarketingController {
  constructor(private readonly marketingService: MarketingService) {}

  // --- Segments -------------------------------------------------------------

  @Get('marketing/segments')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Saved audiences, each with its rules in plain English' })
  listSegments(@CurrentTenant() tenantId: string): Promise<SegmentView[]> {
    return this.marketingService.listSegments(tenantId);
  }

  @Post('marketing/segments')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Save an audience — rules are re-queried live every time it is used' })
  createSegment(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: SaveSegmentDto): Promise<SegmentView> {
    return this.marketingService.saveSegment(tenantId, dto, user.sub);
  }

  @Put('marketing/segments/:segmentId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Change an audience’s name or rules' })
  updateSegment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
    @Body() dto: SaveSegmentDto,
  ): Promise<SegmentView> {
    return this.marketingService.saveSegment(tenantId, dto, user.sub, segmentId);
  }

  @Delete('marketing/segments/:segmentId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Retire an audience (refused while an unsent campaign still uses it)' })
  deleteSegment(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('segmentId', ParseUUIDPipe) segmentId: string): Promise<{ deleted: true }> {
    return this.marketingService.deleteSegment(tenantId, segmentId, user.sub);
  }

  @Post('marketing/segments/preview')
  @HttpCode(HttpStatus.OK)
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'How many guests a set of rules matches, and how many of them can be emailed — works for unsaved rules' })
  previewSegment(@CurrentTenant() tenantId: string, @Body() dto: PreviewSegmentDto): Promise<SegmentPreview> {
    return this.marketingService.previewSegment(tenantId, dto.criteria);
  }

  // --- Templates ------------------------------------------------------------

  @Get('marketing/templates')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Saved email templates' })
  listTemplates(@CurrentTenant() tenantId: string): Promise<TemplateView[]> {
    return this.marketingService.listTemplates(tenantId);
  }

  @Get('marketing/merge-fields')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'The {{placeholders}} a template can use' })
  mergeFields(): ReturnType<MarketingService['mergeFields']> {
    return this.marketingService.mergeFields();
  }

  @Get('marketing/delivery')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Which mail transport campaigns go out through, and whether it reaches real inboxes' })
  deliveryStatus(): ReturnType<MarketingService['deliveryStatus']> {
    return this.marketingService.deliveryStatus();
  }

  @Post('marketing/templates')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Save a template — refused if it uses a placeholder that doesn’t exist' })
  createTemplate(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: SaveTemplateDto): Promise<TemplateView> {
    return this.marketingService.saveTemplate(tenantId, dto, user.sub);
  }

  @Put('marketing/templates/:templateId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Edit a template — changes the next send, never one that already went out' })
  updateTemplate(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: SaveTemplateDto,
  ): Promise<TemplateView> {
    return this.marketingService.saveTemplate(tenantId, dto, user.sub, templateId);
  }

  @Delete('marketing/templates/:templateId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Retire a template (refused while an unsent campaign still uses it)' })
  deleteTemplate(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('templateId', ParseUUIDPipe) templateId: string): Promise<{ deleted: true }> {
    return this.marketingService.deleteTemplate(tenantId, templateId, user.sub);
  }

  @Post('marketing/templates/preview')
  @HttpCode(HttpStatus.OK)
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'A draft rendered with example values — the text part and the HTML part' })
  previewTemplate(@Body() dto: PreviewTemplateDto): ReturnType<MarketingService['previewTemplate']> {
    return this.marketingService.previewTemplate(dto.body, dto.subject);
  }

  // --- Campaigns ------------------------------------------------------------

  @Get('branches/:branchId/marketing/campaigns')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: "This property's campaigns, newest first, with opens and clicks" })
  listCampaigns(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: CampaignListQueryDto,
  ): Promise<CampaignSummary[]> {
    return this.marketingService.listCampaigns(tenantId, branchId, query.status);
  }

  @Post('branches/:branchId/marketing/campaigns')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Create a campaign — a draft, or scheduled when scheduledAt is given' })
  createCampaign(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateCampaignDto,
  ): Promise<CampaignView> {
    return this.marketingService.createCampaign(tenantId, branchId, dto, user.sub);
  }

  @Get('marketing/campaigns/:campaignId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'A campaign with its performance: delivery, opens, clicks, unsubscribes, A/B split, bookings after the send' })
  getCampaign(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('campaignId', ParseUUIDPipe) campaignId: string): Promise<CampaignView> {
    return this.marketingService.getCampaign(tenantId, campaignId, user);
  }

  @Patch('marketing/campaigns/:campaignId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Edit a draft, scheduled or failed campaign' })
  updateCampaign(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() dto: UpdateCampaignDto,
  ): Promise<CampaignView> {
    return this.marketingService.updateCampaign(tenantId, campaignId, dto, user);
  }

  @Post('marketing/campaigns/:campaignId/send')
  @HttpCode(HttpStatus.OK)
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Send now — writes one outbox message per opted-in guest in the segment' })
  sendCampaign(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('campaignId', ParseUUIDPipe) campaignId: string): Promise<CampaignView> {
    return this.marketingService.sendCampaign(tenantId, campaignId, user);
  }

  @Post('marketing/campaigns/:campaignId/test')
  @HttpCode(HttpStatus.OK)
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Send one test copy to a staff address — never counted, never recorded against a guest' })
  sendTest(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() dto: SendTestDto,
  ): Promise<{ sentTo: string }> {
    return this.marketingService.sendTest(tenantId, campaignId, dto.email, user);
  }

  @Post('marketing/campaigns/:campaignId/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Cancel a campaign that has not gone out' })
  cancelCampaign(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('campaignId', ParseUUIDPipe) campaignId: string): Promise<CampaignView> {
    return this.marketingService.cancelCampaign(tenantId, campaignId, user);
  }

  // --- Consent --------------------------------------------------------------

  @Put('guests/:guestId/marketing-consent')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Record that a guest has agreed to (or withdrawn from) marketing email' })
  setConsent(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('guestId', ParseUUIDPipe) guestId: string,
    @Body() dto: SetMarketingConsentDto,
  ): ReturnType<MarketingService['setConsent']> {
    return this.marketingService.setConsent(tenantId, guestId, dto.optIn, user.sub);
  }
}

/** A 1×1 transparent GIF — the smallest valid image there is. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * The three links inside a marketing email, fetched by a guest's mail client
 * with no session and no tenant. Its own class so `@Public()` can't reach the
 * staff routes above — the same separation PublicBookingController keeps.
 *
 * None of these reveal anything to a caller who guesses a token: the pixel
 * returns the same image whether the token exists or not, and the click
 * redirect only goes where a valid signature says. Throttled per IP anyway,
 * generously, because one guest's mail client can legitimately fetch the
 * pixel many times.
 */
@ApiTags('public-marketing')
@Controller('public/marketing')
@Public()
export class PublicMarketingController {
  constructor(private readonly marketingService: MarketingService) {}

  @Get('open/:file')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Header('Content-Type', 'image/gif')
  // Never cached anywhere: a cached pixel is an open nobody records.
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  // Helmet's default is same-origin, which would stop a browser-based mail
  // client on another origin from loading the image at all.
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @ApiExcludeEndpoint()
  async open(@Param('file') file: string, @Res() res: Response): Promise<void> {
    const token = file.replace(/\.gif$/, '');
    try {
      await this.marketingService.recordOpen(token);
    } catch {
      // The image is served regardless. A tracking failure must never show a
      // guest a broken image, and a bad token must not be distinguishable.
    }
    res.end(PIXEL);
  }

  @Get('click/:token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async click(@Param('token') token: string, @Query() query: ClickQueryDto, @Res() res: Response): Promise<void> {
    const target = await this.marketingService.recordClick(token, query.u, query.s);
    res.redirect(302, target);
  }

  @Get('unsubscribe/:token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiExcludeEndpoint()
  async unsubscribePage(@Param('token') token: string, @Res() res: Response): Promise<void> {
    try {
      const info = await this.marketingService.describeUnsubscribe(token);
      if (info.alreadyUnsubscribed) {
        res.send(page('You’re unsubscribed', `<p>${escapeHtml(info.hotelName)} won’t send you any more offers by email.</p>`));
        return;
      }
      // A confirmation step on purpose: mail scanners and link previews
      // fetch every link in a message, and a GET that unsubscribed would opt
      // guests out who never clicked anything.
      res.send(
        page(
          'Unsubscribe',
          `<p>Stop ${escapeHtml(info.hotelName)} emailing offers to ${escapeHtml(info.guestName)}?</p>
           <p>You’ll still get messages about bookings you make, like confirmations and receipts.</p>
           <form method="post"><button type="submit">Unsubscribe</button></form>`,
        ),
      );
    } catch {
      res.status(404).send(page('Link not found', '<p>This unsubscribe link is no longer valid.</p>'));
    }
  }

  @Post('unsubscribe/:token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiExcludeEndpoint()
  async unsubscribe(@Param('token') token: string, @Res() res: Response): Promise<void> {
    try {
      const result = await this.marketingService.unsubscribe(token);
      res.send(
        page(
          'You’re unsubscribed',
          `<p>${escapeHtml(result.hotelName)} won’t send you any more offers by email.</p>
           <p>Messages about your bookings will still reach you.</p>`,
        ),
      );
    } catch {
      res.status(404).send(page('Link not found', '<p>This unsubscribe link is no longer valid.</p>'));
    }
  }
}

/** A plain self-contained page: no scripts, no external assets, nothing for a mail client's sandbox to block. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; padding: 48px 16px; background: #f5f5f4; font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: #1c1917; line-height: 1.6; }
  main { max-width: 440px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  button { font: inherit; padding: 10px 18px; border: 0; border-radius: 6px; background: #1c1917; color: #fff; cursor: pointer; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #f5f5f4; } main { background: #292524; } button { background: #f5f5f4; color: #1c1917; } }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`;
}
