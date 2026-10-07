import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { CreateGdprRequestDto, UpdateGdprRequestStatusDto } from './dto/gdpr.dto';
import { GdprService } from './gdpr.service';

@ApiTags('gdpr')
@ApiBearerAuth()
@Controller('gdpr')
@Roles(SystemRole.Owner)
export class GdprController {
  constructor(private readonly gdprService: GdprService) {}

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
