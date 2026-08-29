import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import {
  AvailabilityCalendarQueryDto,
  AvailabilityQueryDto,
  CancelReservationDto,
  CheckInDto,
  CreateReservationDto,
  ExtendStayDto,
  ListReservationsQueryDto,
  ModifyReservationDto,
  ReinstateNoShowDto,
  SetRateOverrideDto,
  WalkInReservationDto,
  WalkReservationDto,
} from './dto/reservation.dto';
import { ReservationsService } from './reservations.service';

@ApiTags('reservations')
@ApiBearerAuth()
@Controller()
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post('branches/:branchId/reservations')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Book a reservation — rate resolved through the Rate Resolver cascade' })
  createReservation(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateReservationDto,
  ): ReturnType<ReservationsService['createReservation']> {
    return this.reservationsService.createReservation(tenantId, branchId, dto, user.sub);
  }

  @Post('branches/:branchId/reservations/walk-in')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Create a reservation and check it in immediately, in one call' })
  walkIn(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: WalkInReservationDto,
  ): ReturnType<ReservationsService['walkIn']> {
    return this.reservationsService.walkIn(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/availability')
  @ApiOperation({ summary: 'Per-night available-room count for a room type over a date range' })
  getAvailability(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: AvailabilityQueryDto,
  ): ReturnType<ReservationsService['getAvailability']> {
    return this.reservationsService.getAvailability(tenantId, branchId, query);
  }

  @Get('branches/:branchId/availability-calendar')
  @ApiOperation({ summary: 'Every room type at this branch, per-night available counts across a full month' })
  getAvailabilityCalendar(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: AvailabilityCalendarQueryDto,
  ): ReturnType<ReservationsService['getAvailabilityCalendar']> {
    return this.reservationsService.getAvailabilityCalendar(tenantId, branchId, query);
  }

  @Get('branches/:branchId/overbooking/exposure')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Overbooking heatmap: confirmed vs capacity vs threshold, every room type, every night in the given month' })
  getOverbookingExposure(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: AvailabilityCalendarQueryDto,
  ): ReturnType<ReservationsService['getOverbookingExposure']> {
    return this.reservationsService.getOverbookingExposure(tenantId, branchId, query);
  }

  @Get('branches/:branchId/reservations')
  @ApiOperation({ summary: 'Search/filter reservations at this branch (by status, and/or confirmation number or guest name)' })
  listReservations(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: ListReservationsQueryDto,
  ): ReturnType<ReservationsService['listReservations']> {
    return this.reservationsService.listReservations(tenantId, branchId, query);
  }

  @Get('branches/:branchId/arrivals')
  @ApiOperation({ summary: 'Confirmed reservations checking in on the given date (default: today, branch timezone)' })
  listArrivals(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query('date') date?: string,
  ): ReturnType<ReservationsService['listArrivals']> {
    return this.reservationsService.listArrivals(tenantId, branchId, date);
  }

  @Get('branches/:branchId/departures')
  @ApiOperation({ summary: 'Checked-in reservations checking out on the given date (default: today, branch timezone)' })
  listDepartures(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query('date') date?: string,
  ): ReturnType<ReservationsService['listDepartures']> {
    return this.reservationsService.listDepartures(tenantId, branchId, date);
  }

  @Get('branches/:branchId/in-house')
  @ApiOperation({ summary: 'Every currently checked-in reservation at this branch' })
  listInHouse(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<ReservationsService['listInHouse']> {
    return this.reservationsService.listInHouse(tenantId, branchId);
  }

  @Get('reservations/:reservationId')
  @ApiOperation({ summary: 'Get a reservation' })
  getById(
    @CurrentTenant() tenantId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): ReturnType<ReservationsService['getById']> {
    return this.reservationsService.getById(tenantId, reservationId);
  }

  @Post('reservations/:reservationId/check-in')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Check in a confirmed reservation, assigning a room if none is set yet' })
  checkIn(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: CheckInDto,
  ): ReturnType<ReservationsService['checkIn']> {
    return this.reservationsService.checkIn(tenantId, reservationId, dto, user.sub);
  }

  @Post('reservations/:reservationId/check-out')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Check out a checked-in reservation and release the room (marked dirty)' })
  checkOut(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): ReturnType<ReservationsService['checkOut']> {
    return this.reservationsService.checkOut(tenantId, reservationId, user.sub);
  }

  @Post('reservations/:reservationId/cancel')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Cancel a confirmed or waitlisted reservation' })
  cancel(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: CancelReservationDto,
  ): ReturnType<ReservationsService['cancel']> {
    return this.reservationsService.cancel(tenantId, reservationId, dto, user.sub);
  }

  @Patch('reservations/:reservationId/modify')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Change dates, room type, or party size on a confirmed or waitlisted reservation (pre-check-in only)' })
  modifyReservation(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: ModifyReservationDto,
  ): ReturnType<ReservationsService['modifyReservation']> {
    return this.reservationsService.modifyReservation(tenantId, reservationId, dto, user.sub);
  }

  @Patch('reservations/:reservationId/extend-stay')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Push a checked-in guest\'s check-out date later — the one thing `modify` deliberately excludes for a checked-in stay' })
  extendStay(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: ExtendStayDto,
  ): ReturnType<ReservationsService['extendStay']> {
    return this.reservationsService.extendStay(tenantId, reservationId, dto, user.sub);
  }

  @Patch('reservations/:reservationId/rate-override')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Pin an absolute nightly rate on a confirmed or checked-in reservation — a manager-level override, not front desk' })
  setRateOverride(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: SetRateOverrideDto,
  ): ReturnType<ReservationsService['setRateOverride']> {
    return this.reservationsService.setRateOverride(tenantId, reservationId, dto, user.sub);
  }

  @Post('reservations/:reservationId/promote')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Promote a waitlisted reservation to confirmed, if a room has opened up' })
  promoteFromWaitlist(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): ReturnType<ReservationsService['promoteFromWaitlist']> {
    return this.reservationsService.promoteFromWaitlist(tenantId, reservationId, user.sub);
  }

  @Get('branches/:branchId/no-shows/pending')
  @ApiOperation({ summary: 'Confirmed reservations past their check-in date with no check-in yet' })
  listPendingNoShows(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<ReservationsService['listPendingNoShows']> {
    return this.reservationsService.listPendingNoShows(tenantId, branchId);
  }

  @Post('reservations/:reservationId/no-show')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Mark a confirmed reservation as a no-show now — penalty applied per the branch policy, room released, folio settled if nothing is owed' })
  markNoShow(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): ReturnType<ReservationsService['markNoShow']> {
    return this.reservationsService.markNoShow(tenantId, reservationId, user.sub);
  }

  @Post('no-show-records/:noShowRecordId/waive')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Waive a no-show penalty — reverses the charge if one was posted' })
  waiveNoShowPenalty(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('noShowRecordId', ParseUUIDPipe) noShowRecordId: string,
  ): ReturnType<ReservationsService['waiveNoShowPenalty']> {
    return this.reservationsService.waiveNoShowPenalty(tenantId, noShowRecordId, user.sub);
  }

  @Post('reservations/:reservationId/reinstate')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Reinstate a no-show with revised dates (late arrival) — optionally waives the penalty' })
  reinstateFromNoShow(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: ReinstateNoShowDto,
  ): ReturnType<ReservationsService['reinstateFromNoShow']> {
    return this.reservationsService.reinstateFromNoShow(tenantId, reservationId, dto, user.sub);
  }

  @Post('reservations/:reservationId/walk')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Walk a confirmed reservation — relocate to another property, refund any payment already recorded, auto-cancel here' })
  walkReservation(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: WalkReservationDto,
  ): ReturnType<ReservationsService['walkReservation']> {
    return this.reservationsService.walkReservation(tenantId, reservationId, dto, user.sub);
  }
}
