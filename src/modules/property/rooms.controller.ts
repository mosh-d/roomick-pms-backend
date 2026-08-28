import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CreateRoomTypeDto } from './dto/room-type.dto';
import { BulkCreateRoomsDto, ChangeRoomStatusDto, CreateRoomBlockDto } from './dto/rooms.dto';
import { RoomsService } from './rooms.service';

@ApiTags('rooms')
@ApiBearerAuth()
@Controller()
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Post('branches/:branchId/room-types')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Create a room type (carries baseRate — the rate cascade root)' })
  createRoomType(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateRoomTypeDto,
  ): ReturnType<RoomsService['createRoomType']> {
    return this.roomsService.createRoomType(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/room-types')
  @ApiOperation({ summary: 'List room types for a branch' })
  listRoomTypes(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<RoomsService['listRoomTypes']> {
    return this.roomsService.listRoomTypes(tenantId, branchId);
  }

  @Post('branches/:branchId/rooms/bulk')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({
    summary:
      'Bulk-create rooms from a range (301–320) and/or explicit numbers. Omitting floorId auto-creates the hidden default building/floor.',
  })
  bulkCreateRooms(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: BulkCreateRoomsDto,
  ): ReturnType<RoomsService['bulkCreateRooms']> {
    return this.roomsService.bulkCreateRooms(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/rooms')
  @ApiOperation({ summary: 'List rooms for a branch with floor/building/room-type detail — powers the Room Status Board' })
  listRooms(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<RoomsService['listRoomsForBranch']> {
    return this.roomsService.listRoomsForBranch(tenantId, branchId);
  }

  @Patch('rooms/:roomId/status')
  @ApiOperation({
    summary:
      'Change room status axes (§4.1): housekeeping ladder for everyone, occupancy/held + inspected are supervisor-only',
  })
  changeStatus(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body() dto: ChangeRoomStatusDto,
  ): ReturnType<RoomsService['changeStatus']> {
    return this.roomsService.changeStatus(tenantId, roomId, dto, user);
  }

  @Post('rooms/:roomId/block')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Create a date-ranged administrative block on a room' })
  blockRoom(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body() dto: CreateRoomBlockDto,
  ): ReturnType<RoomsService['blockRoom']> {
    return this.roomsService.blockRoom(tenantId, roomId, dto, user.sub);
  }

  @Get('branches/:branchId/room-blocks')
  @ApiOperation({ summary: 'Every room block still in effect today or later (Room Blocking / OOO)' })
  listActiveBlocks(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<RoomsService['listActiveBlocks']> {
    return this.roomsService.listActiveBlocks(tenantId, branchId);
  }

  @Post('room-blocks/:blockId/end')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'End a room block early by pulling its toDate back to today' })
  unblockRoom(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('blockId', ParseUUIDPipe) blockId: string,
  ): ReturnType<RoomsService['unblockRoom']> {
    return this.roomsService.unblockRoom(tenantId, blockId, user.sub);
  }
}
