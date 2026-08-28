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
  ListReservationsQueryDto,
  ModifyReservationDto,
  WalkInReservationDto,
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
}
