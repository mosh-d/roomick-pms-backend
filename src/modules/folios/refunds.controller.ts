import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { BranchOf } from '../../common/decorators/branch-of.decorator';
import { Permission } from '../../common/decorators/permission.decorator';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { ListRefundsQueryDto, RejectRefundDto, RequestRefundDto } from './dto/refund.dto';
import { RefundsService } from './refunds.service';

@ApiTags('refunds')
@ApiBearerAuth()
@Controller()
@Permission('folios')
export class RefundsController {
  constructor(private readonly refundsService: RefundsService) {}

  @Post('folios/:folioId/refunds')
  @BranchOf('folio', 'folioId')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
  @ApiOperation({ summary: "Ask to refund a bill's credit — a manager's or owner's own request is approved as it's made" })
  request(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('folioId', ParseUUIDPipe) folioId: string,
    @Body() dto: RequestRefundDto,
  ): ReturnType<RefundsService['request']> {
    return this.refundsService.request(tenantId, folioId, dto, user);
  }

  @Get('branches/:branchId/refunds')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
  @ApiOperation({ summary: 'Refunds at the branch, newest first — filter by status' })
  list(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: ListRefundsQueryDto,
  ): ReturnType<RefundsService['listForBranch']> {
    return this.refundsService.listForBranch(tenantId, branchId, query.status);
  }

  @Post('refunds/:refundId/approve')
  @BranchOf('refund', 'refundId')
  @Permission('folios', 'update')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Manager approval — the refund can then be paid out' })
  approve(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('refundId', ParseUUIDPipe) refundId: string,
  ): ReturnType<RefundsService['approve']> {
    return this.refundsService.approve(tenantId, refundId, user);
  }

  @Post('refunds/:refundId/reject')
  @BranchOf('refund', 'refundId')
  @Permission('folios', 'update')
  @Roles(SystemRole.Owner, SystemRole.Manager)
  @ApiOperation({ summary: 'Turn a refund down, with the reason — before it is paid out' })
  reject(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('refundId', ParseUUIDPipe) refundId: string,
    @Body() dto: RejectRefundDto,
  ): ReturnType<RefundsService['reject']> {
    return this.refundsService.reject(tenantId, refundId, dto.reason, user);
  }

  @Post('refunds/:refundId/pay-out')
  @BranchOf('refund', 'refundId')
  @Permission('folios', 'update')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk, SystemRole.Accountant)
  @ApiOperation({ summary: 'Hand an approved refund over — recorded as a negative payment; cash comes out of your open drawer' })
  payOut(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('refundId', ParseUUIDPipe) refundId: string,
  ): ReturnType<RefundsService['payOut']> {
    return this.refundsService.payOut(tenantId, refundId, user);
  }
}
