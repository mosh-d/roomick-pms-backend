import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { InboxQueryDto, InboxReplyDto, SendCommunicationDto } from './dto/comms-log.dto';
import { CommsLogService } from './comms-log.service';

@ApiTags('comms-log')
@ApiBearerAuth()
@Controller()
export class CommsLogController {
  constructor(private readonly commsLogService: CommsLogService) {}

  @Post('reservations/:reservationId/communications/send')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Log a one-off manual message to a guest (email or SMS) — sending itself is stubbed for MVP; this is the record' })
  sendManual(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: SendCommunicationDto,
  ): ReturnType<CommsLogService['sendManual']> {
    return this.commsLogService.sendManual(tenantId, reservationId, dto, user.sub);
  }

  @Get('reservations/:reservationId/communications')
  @ApiOperation({ summary: 'Every communication logged against a reservation, newest first' })
  listForReservation(
    @CurrentTenant() tenantId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): ReturnType<CommsLogService['listForReservation']> {
    return this.commsLogService.listForReservation(tenantId, reservationId);
  }

  @Get('guests/:guestId/communications')
  @ApiOperation({ summary: 'Every communication logged against a guest profile across all their reservations, newest first' })
  listForGuest(
    @CurrentTenant() tenantId: string,
    @Param('guestId', ParseUUIDPipe) guestId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): ReturnType<CommsLogService['listForGuest']> {
    return this.commsLogService.listForGuest(tenantId, guestId, from, to);
  }

  // --- Unified inbox (growth plan Month 9) -----------------------------------

  @Get('branches/:branchId/inbox')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Unified guest inbox — every guest at this branch who has written in, newest activity first, with unread counts' })
  listInbox(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: InboxQueryDto,
  ): ReturnType<CommsLogService['listInbox']> {
    return this.commsLogService.listInbox(tenantId, branchId, query.filter ?? 'all');
  }

  @Get('branches/:branchId/inbox/:guestId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: "One guest's thread at this branch — their messages, staff replies and the automated notices, oldest first" })
  getThread(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('guestId', ParseUUIDPipe) guestId: string,
  ): ReturnType<CommsLogService['getThread']> {
    return this.commsLogService.getThread(tenantId, branchId, guestId);
  }

  @Post('branches/:branchId/inbox/:guestId/read')
  @HttpCode(HttpStatus.OK)
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: "Mark a guest's unread messages as read" })
  markThreadRead(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('guestId', ParseUUIDPipe) guestId: string,
  ): ReturnType<CommsLogService['markThreadRead']> {
    return this.commsLogService.markThreadRead(tenantId, branchId, guestId);
  }

  @Post('branches/:branchId/inbox/:guestId/reply')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Reply to a guest — on their portal page (readable immediately), by email, or by SMS' })
  reply(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('guestId', ParseUUIDPipe) guestId: string,
    @Body() dto: InboxReplyDto,
  ): ReturnType<CommsLogService['replyInThread']> {
    return this.commsLogService.replyInThread(tenantId, branchId, guestId, dto, user.sub);
  }
}
