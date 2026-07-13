import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class PatchStaffDto {
  @ApiPropertyOptional({ description: 'New role id (requires branchId to scope the change)' })
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @ApiPropertyOptional({
    description: 'Branch the role/outlet change applies to. Omit for an all-branches role.',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Replace outlet assignments at branchId', type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  outletIds?: string[];

  @ApiPropertyOptional({ description: 'false = deactivate (soft delete), true = reactivate' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
