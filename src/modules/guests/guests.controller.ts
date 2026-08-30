import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { AddGuestNoteDto, CreateGuestDto, UpdateGuestDto } from './dto/guest.dto';
import { GuestsService } from './guests.service';

@ApiTags('guests')
@ApiBearerAuth()
@Controller()
export class GuestsController {
  constructor(private readonly guestsService: GuestsService) {}

  @Post('guests')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Pre-register a guest (also happens inline via reservation creation)' })
  createGuest(@CurrentTenant() tenantId: string, @Body() dto: CreateGuestDto): ReturnType<GuestsService['createGuest']> {
    return this.guestsService.createGuest(tenantId, dto);
  }

  @Get('guests')
  @ApiOperation({ summary: 'Guest Profiles & CRM — the browsable, paginated list (unlike /guests/search, q is optional)' })
  listGuests(
    @CurrentTenant() tenantId: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): ReturnType<GuestsService['listGuests']> {
    return this.guestsService.listGuests(tenantId, q, page ? Number(page) : 1, limit ? Number(limit) : 50);
  }

  @Get('guests/search')
  @ApiOperation({ summary: 'Search guests by name or email (top 20 matches)' })
  searchGuests(@CurrentTenant() tenantId: string, @Query('q') q: string): ReturnType<GuestsService['searchGuests']> {
    return this.guestsService.searchGuests(tenantId, q);
  }

  @Get('guests/:guestId')
  @ApiOperation({ summary: 'Full guest profile — preferences, loyalty, stay history, spend summary, notes feed' })
  getGuest(
    @CurrentTenant() tenantId: string,
    @Param('guestId', ParseUUIDPipe) guestId: string,
  ): ReturnType<GuestsService['getGuestById']> {
    return this.guestsService.getGuestById(tenantId, guestId);
  }

  @Patch('guests/:guestId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Update a guest\'s CRM fields — preferences, VIP level, tags, loyalty' })
  updateGuest(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('guestId', ParseUUIDPipe) guestId: string,
    @Body() dto: UpdateGuestDto,
  ): ReturnType<GuestsService['updateGuest']> {
    return this.guestsService.updateGuest(tenantId, guestId, dto, user.sub);
  }

  @Post('guests/:guestId/notes')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Append to the guest\'s notes feed — never edits or deletes an existing note' })
  addGuestNote(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('guestId', ParseUUIDPipe) guestId: string,
    @Body() dto: AddGuestNoteDto,
  ): ReturnType<GuestsService['addGuestNote']> {
    return this.guestsService.addGuestNote(tenantId, guestId, dto, user.sub);
  }

  @Get('guests/:guestId/id-document')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Get a guest\'s ID-document state — masked idDocNumber unless ?reveal=true (audited as pii.reveal)' })
  getGuestIdDocument(
    @CurrentTenant() tenantId: string,
    @Param('guestId', ParseUUIDPipe) guestId: string,
    @Query('reveal') reveal?: string,
  ): ReturnType<GuestsService['getGuestDetail']> {
    return this.guestsService.getGuestDetail(tenantId, guestId, reveal === 'true');
  }
}
