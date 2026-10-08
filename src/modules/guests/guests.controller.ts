import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Permission } from '../../common/decorators/permission.decorator';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { AddGuestNoteDto, CreateGuestDto, ListGuestsQueryDto, SearchGuestsQueryDto, UpdateGuestDto } from './dto/guest.dto';
import { GuestsService } from './guests.service';

@ApiTags('guests')
@ApiBearerAuth()
@Controller()
@Permission('guests')
export class GuestsController {
  constructor(private readonly guestsService: GuestsService) {}

  @Post('guests')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Pre-register a guest (also happens inline via reservation creation)' })
  createGuest(@CurrentTenant() tenantId: string, @Body() dto: CreateGuestDto): ReturnType<GuestsService['createGuest']> {
    return this.guestsService.createGuest(tenantId, dto);
  }

  // Guest contact details are the front office's to read — not a POS
  // cashier's or a housekeeper's, who could list the whole guest database.
  @Get('guests')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Guest Profiles & CRM — the browsable, paginated list (unlike /guests/search, q is optional)' })
  listGuests(@CurrentTenant() tenantId: string, @Query() query: ListGuestsQueryDto): ReturnType<GuestsService['listGuests']> {
    return this.guestsService.listGuests(tenantId, query.q, query.page ?? 1, query.limit ?? 50);
  }

  @Get('guests/search')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Search guests by name, email or phone (top 20 matches) — the walk-in and booking forms suggest returning guests from it' })
  searchGuests(@CurrentTenant() tenantId: string, @Query() query: SearchGuestsQueryDto): ReturnType<GuestsService['searchGuests']> {
    return this.guestsService.searchGuests(tenantId, query.q);
  }

  @Get('guests/:guestId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
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
