import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { BranchOf } from '../../common/decorators/branch-of.decorator';
import { Permission } from '../../common/decorators/permission.decorator';
import { ALL_SYSTEM_ROLES, Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { RecordDepositDto, SetExchangeRateDto, VoidPaymentDto } from './dto/folio.dto';
import { ExchangeRatesService, ExchangeRateView } from './exchange-rates.service';
import { FoliosService } from './folios.service';
import { InvoicesService, InvoiceView } from './invoices.service';

/**
 * Money on a bill beyond charges and payments: deposits before arrival,
 * voiding a payment recorded in error, invoices, and the exchange rates a
 * branch takes other currencies at.
 */
@ApiTags('folios')
@ApiBearerAuth()
@Controller()
@Permission('folios')
export class MoneyController {
  constructor(
    private readonly foliosService: FoliosService,
    private readonly invoicesService: InvoicesService,
    private readonly exchangeRatesService: ExchangeRatesService,
  ) {}

  @Post('reservations/:reservationId/deposits')
  @BranchOf('reservation', 'reservationId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
  @ApiOperation({ summary: "Take a deposit before the guest arrives — it goes on the stay's own bill, which holds it until check-in" })
  recordDeposit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: RecordDepositDto,
  ): ReturnType<FoliosService['recordDeposit']> {
    return this.foliosService.recordDeposit(tenantId, reservationId, dto, user.sub);
  }

  @Post('payments/:paymentId/void')
  @HttpCode(HttpStatus.OK)
  @BranchOf('payment', 'paymentId')
  @Permission('folios', 'update')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.Accountant)
  @ApiOperation({ summary: 'Void a payment recorded in error — it stays on record, marked void with who and why, and the bill owes it again' })
  voidPayment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: VoidPaymentDto,
  ): ReturnType<FoliosService['voidPayment']> {
    return this.foliosService.voidPayment(tenantId, paymentId, dto.reason, user.sub);
  }

  @Post('folios/:folioId/invoices')
  @BranchOf('folio', 'folioId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
  @ApiOperation({ summary: 'Issue an invoice for the bill as it stands — the same invoice again when nothing changed, a new number replacing it when something did' })
  issueInvoice(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Param('folioId', ParseUUIDPipe) folioId: string): Promise<InvoiceView> {
    return this.invoicesService.issue(tenantId, folioId, user.sub);
  }

  @Get('folios/:folioId/invoices')
  @BranchOf('folio', 'folioId')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: "A bill's invoices, newest first — replaced ones included" })
  listInvoices(@CurrentTenant() tenantId: string, @Param('folioId', ParseUUIDPipe) folioId: string): Promise<InvoiceView[]> {
    return this.invoicesService.listForFolio(tenantId, folioId);
  }

  @Get('invoices/:invoiceId/pdf')
  @BranchOf('invoice', 'invoiceId')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: 'An invoice as a PDF' })
  async invoicePdf(@CurrentTenant() tenantId: string, @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Res() res: Response): Promise<void> {
    const { filename, pdf } = await this.invoicesService.pdf(tenantId, invoiceId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  }

  @Get('branches/:branchId/exchange-rates')
  @Roles(...ALL_SYSTEM_ROLES)
  @ApiOperation({ summary: "The other currencies this branch takes payment in, and what one unit of each is worth in the branch's own" })
  listExchangeRates(@CurrentTenant() tenantId: string, @Param('branchId', ParseUUIDPipe) branchId: string): ReturnType<ExchangeRatesService['list']> {
    return this.exchangeRatesService.list(tenantId, branchId);
  }

  @Put('branches/:branchId/exchange-rates/:currency')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Set the rate for a currency — payments already taken keep the rate they were taken at' })
  setExchangeRate(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('currency') currency: string,
    @Body() dto: SetExchangeRateDto,
  ): Promise<ExchangeRateView> {
    return this.exchangeRatesService.set(tenantId, branchId, currency, dto.rate, user.sub);
  }

  @Delete('branches/:branchId/exchange-rates/:currency')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Stop taking a currency' })
  removeExchangeRate(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('currency') currency: string,
  ): Promise<{ removed: true }> {
    return this.exchangeRatesService.remove(tenantId, branchId, currency, user.sub);
  }
}
