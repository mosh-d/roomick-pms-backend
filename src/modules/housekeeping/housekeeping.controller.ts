import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { JwtPayload } from '../../common/types/request-context';
import { AssignTaskDto, CreateTaskDto, ListTasksQueryDto, ReportIssueDto } from './dto/housekeeping.dto';
import { HousekeepingService } from './housekeeping.service';

@ApiTags('housekeeping')
@ApiBearerAuth()
@Controller()
export class HousekeepingController {
  constructor(private readonly housekeepingService: HousekeepingService) {}

  @Post('branches/:branchId/housekeeping/tasks')
  @ApiOperation({ summary: 'Create a housekeeping task for a room' })
  createTask(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: CreateTaskDto,
  ): ReturnType<HousekeepingService['createTask']> {
    return this.housekeepingService.createTask(tenantId, branchId, dto, user.sub);
  }

  @Get('branches/:branchId/housekeeping/tasks')
  @ApiOperation({ summary: 'List housekeeping tasks (Task Board) — filter by status and/or assignee' })
  listTasks(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Query() query: ListTasksQueryDto,
  ): ReturnType<HousekeepingService['listTasks']> {
    return this.housekeepingService.listTasks(tenantId, branchId, query);
  }

  @Get('branches/:branchId/housekeeping/staff')
  @ApiOperation({ summary: 'Housekeepers visible at this branch (Staff Assignment)' })
  listHousekeepers(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
  ): ReturnType<HousekeepingService['listHousekeepers']> {
    return this.housekeepingService.listHousekeepers(tenantId, branchId);
  }

  @Post('housekeeping/tasks/:taskId/assign')
  @ApiOperation({ summary: 'Assign a task to a housekeeper — supervisor only' })
  assignTask(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: AssignTaskDto,
  ): ReturnType<HousekeepingService['assignTask']> {
    return this.housekeepingService.assignTask(tenantId, taskId, dto, user);
  }

  @Post('housekeeping/tasks/:taskId/start')
  @ApiOperation({ summary: 'Start cleaning — self-assigns if unclaimed, moves the room dirty → cleaning' })
  startTask(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): ReturnType<HousekeepingService['startTask']> {
    return this.housekeepingService.startTask(tenantId, taskId, user.sub);
  }

  @Post('housekeeping/tasks/:taskId/complete')
  @ApiOperation({ summary: 'Finish cleaning — moves the room cleaning → clean, awaiting inspection' })
  completeTask(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): ReturnType<HousekeepingService['completeTask']> {
    return this.housekeepingService.completeTask(tenantId, taskId, user.sub);
  }

  @Post('housekeeping/tasks/:taskId/report-issue')
  @ApiOperation({ summary: 'Report an issue instead of a normal clean — marks the task skipped' })
  reportIssue(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: ReportIssueDto,
  ): ReturnType<HousekeepingService['reportIssue']> {
    return this.housekeepingService.reportIssue(tenantId, taskId, dto, user.sub);
  }
}
