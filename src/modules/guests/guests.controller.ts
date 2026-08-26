import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Body } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { CreateGuestDto } from './dto/guest.dto';
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

  @Get('guests/search')
  @ApiOperation({ summary: 'Search guests by name or email (top 20 matches)' })
  searchGuests(@CurrentTenant() tenantId: string, @Query('q') q: string): ReturnType<GuestsService['searchGuests']> {
    return this.guestsService.searchGuests(tenantId, q);
  }

  @Get('guests/:guestId')
  @ApiOperation({ summary: 'Get a guest profile' })
  getGuest(
    @CurrentTenant() tenantId: string,
    @Param('guestId', ParseUUIDPipe) guestId: string,
  ): ReturnType<GuestsService['getGuestById']> {
    return this.guestsService.getGuestById(tenantId, guestId);
  }
}
