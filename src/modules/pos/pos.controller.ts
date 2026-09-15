import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import {
  CreateMenuItemDto,
  CreateOutletDto,
  CreatePosOrderDto,
  ListOrdersQueryDto,
  QuotePosOrderDto,
  RoomLookupQueryDto,
  SetAvailabilityDto,
  UpdateMenuItemDto,
  UpdateOutletDto,
  VoidPosOrderDto,
} from './dto/pos.dto';
import { POS_TERMINAL_ROLES, PosService } from './pos.service';

@ApiTags('pos')
@ApiBearerAuth()
@Controller()
export class PosController {
  constructor(private readonly posService: PosService) {}

  // --- Outlets ---------------------------------------------------------------

  @Get('branches/:branchId/pos/outlets')
  @Roles(...POS_TERMINAL_ROLES)
  @ApiOperation({ summary: "The branch's outlets — managers see all of them, POS staff only the ones they're assigned to" })
  listOutlets(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<PosService['listOutlets']> {
    return this.posService.listOutlets(tenantId, branchId, user);
  }

  @Post('branches/:branchId/pos/outlets')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Open an outlet — its category fixes the charge type on everything it sells' })
  createOutlet(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateOutletDto,
  ): ReturnType<PosService['createOutlet']> {
    return this.posService.createOutlet(tenantId, branchId, dto, user.sub);
  }

  @Patch('pos/outlets/:outletId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Rename, reorder, or deactivate an outlet' })
  updateOutlet(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Body() dto: UpdateOutletDto,
  ): ReturnType<PosService['updateOutlet']> {
    return this.posService.updateOutlet(tenantId, outletId, dto, user);
  }

  // --- Menu --------------------------------------------------------------------

  @Get('pos/outlets/:outletId/menu')
  @Roles(...POS_TERMINAL_ROLES)
  @ApiOperation({ summary: "The outlet's menu, 86'd items included (the terminal greys them out)" })
  listMenu(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('outletId', ParseUUIDPipe) outletId: string,
  ): ReturnType<PosService['listMenu']> {
    return this.posService.listMenu(tenantId, outletId, user);
  }

  @Post('pos/outlets/:outletId/menu-items')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Add a menu item, with its modifier groups' })
  createMenuItem(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Body() dto: CreateMenuItemDto,
  ): ReturnType<PosService['createMenuItem']> {
    return this.posService.createMenuItem(tenantId, outletId, dto, user);
  }

  @Patch('pos/menu-items/:itemId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Edit a menu item — past orders keep the price they were sold at' })
  updateMenuItem(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateMenuItemDto,
  ): ReturnType<PosService['updateMenuItem']> {
    return this.posService.updateMenuItem(tenantId, itemId, dto, user);
  }

  @Patch('pos/menu-items/:itemId/availability')
  @Roles(...POS_TERMINAL_ROLES)
  @ApiOperation({ summary: "86 an item, or bring it back — anyone working the outlet's till" })
  setAvailability(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: SetAvailabilityDto,
  ): ReturnType<PosService['setAvailability']> {
    return this.posService.setAvailability(tenantId, itemId, dto.isAvailable, user);
  }

  @Delete('pos/menu-items/:itemId')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Take an item off the menu for good (soft delete)' })
  deleteMenuItem(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): ReturnType<PosService['deleteMenuItem']> {
    return this.posService.deleteMenuItem(tenantId, itemId, user);
  }

  // --- Selling -----------------------------------------------------------------

  @Post('pos/outlets/:outletId/quote')
  @HttpCode(200)
  @Roles(...POS_TERMINAL_ROLES)
  @ApiOperation({ summary: 'Price a basket — subtotal, tax and total from the server, modifiers included' })
  quote(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Body() dto: QuotePosOrderDto,
  ): ReturnType<PosService['quote']> {
    return this.posService.quote(tenantId, outletId, dto, user);
  }

  @Get('branches/:branchId/pos/room-lookup')
  @Roles(...POS_TERMINAL_ROLES)
  @ApiOperation({ summary: "Who's checked in to a room — confirm the guest before charging to their room" })
  roomLookup(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: RoomLookupQueryDto,
  ): ReturnType<PosService['roomLookup']> {
    return this.posService.roomLookup(tenantId, branchId, query.room);
  }

  @Post('pos/orders')
  @Roles(...POS_TERMINAL_ROLES)
  @ApiOperation({ summary: 'Ring up a sale — charge to room, cash, or card' })
  createOrder(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePosOrderDto,
  ): ReturnType<PosService['createOrder']> {
    return this.posService.createOrder(tenantId, dto, user);
  }

  @Get('pos/outlets/:outletId/orders')
  @Roles(...POS_TERMINAL_ROLES)
  @ApiOperation({ summary: "One business day of an outlet's sales, with the day's takings" })
  listOrders(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('outletId', ParseUUIDPipe) outletId: string,
    @Query() query: ListOrdersQueryDto,
  ): ReturnType<PosService['listOrders']> {
    return this.posService.listOrders(tenantId, outletId, query.date, user);
  }

  @Get('pos/orders/:orderId')
  @Roles(...POS_TERMINAL_ROLES)
  @ApiOperation({ summary: 'One order — the receipt' })
  getOrder(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): ReturnType<PosService['getOrder']> {
    return this.posService.getOrder(tenantId, orderId, user);
  }

  @Post('pos/orders/:orderId/void')
  @HttpCode(200)
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: "Void a sale — a room charge comes off the guest's bill, tax and all" })
  voidOrder(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: VoidPosOrderDto,
  ): ReturnType<PosService['voidOrder']> {
    return this.posService.voidOrder(tenantId, orderId, dto, user);
  }
}
