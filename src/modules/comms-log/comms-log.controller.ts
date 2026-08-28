import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { SendCommunicationDto } from './dto/comms-log.dto';
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
}
