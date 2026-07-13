import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';

export class SetUserOutletsDto {
  @ApiProperty({ description: 'Branch the outlet assignments belong to' })
  @IsUUID()
  branchId!: string;

  @ApiProperty({ type: [String], description: 'Full replacement set — [] clears assignments' })
  @IsArray()
  @IsUUID(undefined, { each: true })
  outletIds!: string[];
}
