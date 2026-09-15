import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import {
  BookIntoGroupBlockDto,
  CreateEventBookingDto,
  CreateEventSpaceDto,
  CreateGroupBlockDto,
  RoomingListDto,
  UpdateEventBookingDto,
} from './dto/sales-events.dto';
import { GroupBlocksService, GroupBlockSummary, RoomingListResult } from './group-blocks.service';
import { EventBookingDetail, EventBookingSummary, EventSpaceSummary, EventSpacesService } from './event-spaces.service';

@ApiTags('sales-events')
@ApiBearerAuth()
@Controller()
export class SalesEventsController {
  constructor(
    private readonly groupBlocksService: GroupBlocksService,
    private readonly eventSpacesService: EventSpacesService,
  ) {}

  // --- Group Blocks -----------------------------------------------------------

  @Post('branches/:branchId/group-blocks')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: "Sales & Events — hold a block of rooms for a group's stay at a negotiated rate, until a cut-off" })
  createBlock(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateGroupBlockDto,
  ): Promise<GroupBlockSummary> {
    return this.groupBlocksService.createBlock(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/group-blocks')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'List group blocks with live pickup, and whether each is still holding rooms' })
  listBlocks(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): Promise<GroupBlockSummary[]> {
    return this.groupBlocksService.listBlocks(tenantId, branchId);
  }

  @Patch('group-blocks/:blockId/release')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Release a block — it takes no more bookings and its held rooms go back on sale; booked rooms are unaffected' })
  releaseBlock(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('blockId', ParseUUIDPipe) blockId: string,
  ): Promise<GroupBlockSummary> {
    return this.groupBlocksService.releaseBlock(tenantId, blockId, user);
  }

  @Post('group-blocks/:blockId/reservations')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: "Book a reservation into a group block at the block's own rate — rejects once the allotment is full" })
  bookIntoBlock(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Body() dto: BookIntoGroupBlockDto,
  ): ReturnType<GroupBlocksService['bookIntoBlock']> {
    return this.groupBlocksService.bookIntoBlock(tenantId, blockId, dto, user);
  }

  @Post('group-blocks/:blockId/rooming-list')
  @HttpCode(200)
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Book a rooming list into the block — every row checked first; reports each booking or refusal' })
  importRoomingList(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Body() dto: RoomingListDto,
  ): Promise<RoomingListResult> {
    return this.groupBlocksService.importRoomingList(tenantId, blockId, dto, user);
  }

  // --- Event Spaces -------------------------------------------------------------

  @Post('branches/:branchId/event-spaces')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Register a bookable event space (meeting room, ballroom, outdoor venue), with seats per layout' })
  createSpace(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string, @Body() dto: CreateEventSpaceDto): Promise<EventSpaceSummary> {
    return this.eventSpacesService.createSpace(tenantId, branchId, dto);
  }

  @Get('branches/:branchId/event-spaces')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'List event spaces for the branch' })
  listSpaces(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): Promise<EventSpaceSummary[]> {
    return this.eventSpacesService.listSpaces(tenantId, branchId);
  }

  @Get('branches/:branchId/event-bookings')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'The event space calendar — every booking across every space, in a date range' })
  listBookings(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<EventBookingSummary[]> {
    return this.eventSpacesService.listBookings(tenantId, branchId, new Date(from), new Date(to));
  }

  @Post('event-spaces/:eventSpaceId/bookings')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Book an event space for a time range — rejects an overlapping booking on the same space' })
  createBooking(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('eventSpaceId', ParseUUIDPipe) eventSpaceId: string,
    @Body() dto: CreateEventBookingDto,
  ): Promise<EventBookingSummary> {
    return this.eventSpacesService.createBooking(tenantId, eventSpaceId, dto, user.sub);
  }

  @Get('event-bookings/:bookingId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'One event booking, its catering priced' })
  getBooking(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
  ): Promise<EventBookingDetail> {
    return this.eventSpacesService.getBooking(tenantId, bookingId, user);
  }

  @Patch('event-bookings/:bookingId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: "Fill in the event's details — layout, headcount, contact, catering, AV, notes" })
  updateBooking(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: UpdateEventBookingDto,
  ): Promise<EventBookingDetail> {
    return this.eventSpacesService.updateBooking(tenantId, bookingId, dto, user);
  }

  @Get('event-bookings/:bookingId/beo')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'The Banquet Event Order as a PDF' })
  async getBeo(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, pdf } = await this.eventSpacesService.getBeoPdf(tenantId, bookingId, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  }

  @Delete('event-bookings/:bookingId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Cancel an event booking, freeing the slot' })
  async cancelBooking(@CurrentTenant() tenantId: string, @Param('bookingId', ParseUUIDPipe) bookingId: string): Promise<{ ok: true }> {
    await this.eventSpacesService.cancelBooking(tenantId, bookingId);
    return { ok: true };
  }
}
