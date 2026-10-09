import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Permission } from '../../common/decorators/permission.decorator';
import { ALL_SYSTEM_ROLES, Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CreateRoomTypeDto, UpdateRoomTypeDto } from './dto/room-type.dto';
import { BulkCreateRoomsDto, ChangeRoomStatusDto, CreateRoomBlockDto, UpdateRoomDto } from './dto/rooms.dto';
import { RoomsService } from './rooms.service';
import { MAX_PHOTO_BYTES } from './room-photos';
import { BranchOf } from '../../common/decorators/branch-of.decorator';

@ApiTags('rooms')
@ApiBearerAuth()
@Controller()
@Permission('property')
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
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'List room types for a branch' })
  listRoomTypes(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<RoomsService['listRoomTypes']> {
    return this.roomsService.listRoomTypes(tenantId, branchId);
  }

  @Get('branches/:branchId/room-photo-uploads')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Whether room photos can be uploaded — a storage bucket is set up — and the largest one taken' })
  photoUploads(@Param('branchId', ParseUUIDPipe) _branchId: string): ReturnType<RoomsService['photoUploadsEnabled']> {
    return this.roomsService.photoUploadsEnabled();
  }

  @Post('room-types/:roomTypeId/photos')
  @BranchOf('roomType', 'roomTypeId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { photo: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Upload a photo of a room type (JPEG, PNG or WebP, up to 5 MB) — added to its photos, shown on the booking page' })
  uploadRoomTypePhoto(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('roomTypeId', ParseUUIDPipe) roomTypeId: string,
    @UploadedFile() photo: Express.Multer.File | undefined,
  ): ReturnType<RoomsService['uploadRoomTypePhoto']> {
    return this.roomsService.uploadRoomTypePhoto(tenantId, roomTypeId, photo, user.sub);
  }

  @Patch('room-types/:roomTypeId')
  @BranchOf('roomType', 'roomTypeId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Update a room type — Property Config\'s own editor, never retroactively reprices existing reservations' })
  updateRoomType(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('roomTypeId', ParseUUIDPipe) roomTypeId: string,
    @Body() dto: UpdateRoomTypeDto,
  ): ReturnType<RoomsService['updateRoomType']> {
    return this.roomsService.updateRoomType(tenantId, roomTypeId, dto, user.sub);
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
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'List rooms for a branch with floor/building/room-type detail — powers the Room Status Board' })
  listRooms(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<RoomsService['listRoomsForBranch']> {
    return this.roomsService.listRoomsForBranch(tenantId, branchId);
  }

  @Patch('rooms/:roomId')
  @BranchOf('room', 'roomId')
  @Permission('property', 'update')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: "Edit a room — number, type, floor, view, notes. Type changes are refused while it's occupied or would leave its type short" })
  updateRoom(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body() dto: UpdateRoomDto,
  ): ReturnType<RoomsService['updateRoom']> {
    return this.roomsService.updateRoom(tenantId, roomId, dto, user.sub);
  }

  @Delete('rooms/:roomId')
  @BranchOf('room', 'roomId')
  @Permission('property', 'delete')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Take a room out of the inventory (kept on record; adding its number back brings it back)' })
  removeRoom(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('roomId', ParseUUIDPipe) roomId: string,
  ): ReturnType<RoomsService['removeRoom']> {
    return this.roomsService.removeRoom(tenantId, roomId, user.sub);
  }

  @Patch('rooms/:roomId/status')
  @BranchOf('room', 'roomId')
  @Roles(...ALL_SYSTEM_ROLES)
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
  @BranchOf('room', 'roomId')
  @Permission('property', 'update')
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
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'Every room block still in effect today or later (Room Blocking / OOO)' })
  listActiveBlocks(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<RoomsService['listActiveBlocks']> {
    return this.roomsService.listActiveBlocks(tenantId, branchId);
  }

  @Post('room-blocks/:blockId/end')
  @BranchOf('roomBlock', 'blockId')
  @Permission('property', 'update')
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
