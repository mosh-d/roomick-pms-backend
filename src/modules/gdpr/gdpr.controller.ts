import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { ErrorCode } from '../../common/errors/error-codes';
import { CreateGdprRequestDto, RetentionDto, UpdateGdprRequestStatusDto } from './dto/gdpr.dto';
import { GdprService } from './gdpr.service';
import { RetentionService } from './retention.service';

@ApiTags('gdpr')
@ApiBearerAuth()
@Controller('gdpr')
@Roles(SystemRole.Owner)
export class GdprController {
  constructor(
    private readonly gdprService: GdprService,
    private readonly retentionService: RetentionService,
  ) {}

  @Get('retention')
  @ApiOperation({ summary: 'How long registration cards and ID documents are kept, and what is past that now — or, with ?months=, what that period would remove' })
  retention(@CurrentTenant() tenantId: string, @Query('months') months?: string): ReturnType<RetentionService['status']> {
    if (months === undefined) return this.retentionService.status(tenantId);
    if (!/^\d{1,3}$/.test(months)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message: 'months must be a whole number' });
    }
    return this.retentionService.status(tenantId, Number(months));
  }

  @Put('retention')
  @ApiOperation({ summary: 'Set how long registration cards and ID documents are kept after a stay (null keeps them) — removed nightly after that' })
  setRetention(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload, @Body() dto: RetentionDto): ReturnType<RetentionService['setPeriod']> {
    return this.retentionService.setPeriod(tenantId, dto.months, user.sub);
  }

  @Post('retention/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove what is past the retention period now, instead of waiting for tonight' })
  runRetention(@CurrentTenant() tenantId: string, @CurrentUser() user: JwtPayload): ReturnType<RetentionService['purgeTenant']> {
    return this.retentionService.purgeTenant(tenantId, user.sub);
  }

  @Post('data-requests')
  @ApiOperation({ summary: 'File a GDPR data request (access, erasure, or portability) on behalf of a guest' })
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateGdprRequestDto,
  ): ReturnType<GdprService['createDataRequest']> {
    return this.gdprService.createDataRequest(tenantId, dto, user.sub);
  }

  @Get('data-requests')
  @ApiOperation({ summary: 'List all GDPR data requests for this tenant, newest first' })
  list(@CurrentTenant() tenantId: string): ReturnType<GdprService['listDataRequests']> {
    return this.gdprService.listDataRequests(tenantId);
  }

  @Post('data-requests/:requestId/erase')
  @ApiOperation({ summary: 'Carry out an erasure request: the guest’s identity, contact details, ID document, notes and messages are erased; bills, payments and stays are kept' })
  erase(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): ReturnType<GdprService['eraseGuestData']> {
    return this.gdprService.eraseGuestData(tenantId, requestId, user.sub);
  }

  @Patch('data-requests/:requestId/status')
  @ApiOperation({ summary: "Progress a request's status by hand — in progress, or rejected; an erasure completes through /erase" })
  updateStatus(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: UpdateGdprRequestStatusDto,
  ): ReturnType<GdprService['updateStatus']> {
    return this.gdprService.updateStatus(tenantId, requestId, dto, user.sub);
  }

  @Get('data-requests/:requestId/export')
  @ApiOperation({ summary: 'Download the data export for an access/portability request — generated on first call, then served from storage' })
  async downloadExport(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Res() res: Response,
  ): Promise<void> {
    const data = await this.gdprService.downloadExport(tenantId, requestId, user.sub);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="gdpr-export-${requestId}.json"`);
    res.send(data);
  }
}
