import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CorrectLineItemDto, PostChargeDto, RecordPaymentDto } from './dto/folio.dto';
import { FoliosService } from './folios.service';

@ApiTags('folios')
@ApiBearerAuth()
@Controller()
export class FoliosController {
  constructor(private readonly foliosService: FoliosService) {}

  @Get('folios/:folioId')
  @ApiOperation({ summary: 'Folio with line items, payments, and computed totals (balance is derived, never stored)' })
  getFolio(
    @CurrentTenant() tenantId: string,
    @Param('folioId', ParseUUIDPipe) folioId: string,
  ): ReturnType<FoliosService['getFolio']> {
    return this.foliosService.getFolio(tenantId, folioId);
  }

  @Get('folios/:folioId/tax-breakdown')
  @ApiOperation({ summary: 'Per-rule tax breakdown for a folio (§4.5 GROUP BY rule)' })
  getTaxBreakdown(
    @CurrentTenant() tenantId: string,
    @Param('folioId', ParseUUIDPipe) folioId: string,
  ): ReturnType<FoliosService['getTaxBreakdown']> {
    return this.foliosService.getTaxBreakdown(tenantId, folioId);
  }

  @Get('reservations/:reservationId/folios')
  @ApiOperation({ summary: 'Folios belonging to a reservation' })
  listForReservation(
    @CurrentTenant() tenantId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): ReturnType<FoliosService['listFoliosForReservation']> {
    return this.foliosService.listFoliosForReservation(tenantId, reservationId);
  }

  @Get('branches/:branchId/folios')
  @ApiOperation({
    summary:
      'Branch folios. filter=outstanding (balance owed) | overdue (balance owed and check-out date passed — a City Ledger receivable) | all',
  })
  listFolios(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query('filter') filter?: string,
  ): ReturnType<FoliosService['listFolios']> {
    const safeFilter = filter === 'outstanding' || filter === 'overdue' ? filter : 'all';
    return this.foliosService.listFolios(tenantId, branchId, safeFilter);
  }

  @Post('folios/:folioId/charges')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
  @ApiOperation({ summary: 'Post a charge to a folio — taxes are computed and posted as their own line items' })
  postCharge(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('folioId', ParseUUIDPipe) folioId: string,
    @Body() dto: PostChargeDto,
  ): ReturnType<FoliosService['postCharge']> {
    return this.foliosService.postCharge(tenantId, folioId, dto, user.sub);
  }

  @Post('folios/:folioId/payments')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
  @ApiOperation({ summary: 'Record a payment against a folio (deposits never post as line items)' })
  recordPayment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('folioId', ParseUUIDPipe) folioId: string,
    @Body() dto: RecordPaymentDto,
  ): ReturnType<FoliosService['recordPayment']> {
    return this.foliosService.recordPayment(tenantId, folioId, dto, user.sub);
  }

  @Post('folios/:folioId/close')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
  @ApiOperation({ summary: 'Close/settle a folio — only permitted at a zero or credit balance' })
  closeFolio(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('folioId', ParseUUIDPipe) folioId: string,
  ): ReturnType<FoliosService['closeFolio']> {
    return this.foliosService.closeFolio(tenantId, folioId, user.sub);
  }

  @Post('line-items/:lineItemId/correct')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({
    summary: 'Append a negating correction for a line item (the original is never mutated — append-only ledger, §4.5)',
  })
  correctLineItem(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('lineItemId', ParseUUIDPipe) lineItemId: string,
    @Body() dto: CorrectLineItemDto,
  ): ReturnType<FoliosService['correctLineItem']> {
    return this.foliosService.correctLineItem(tenantId, lineItemId, dto, user.sub);
  }
}
