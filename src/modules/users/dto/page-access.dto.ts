import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

export class SetPageAccessDto {
  @ApiProperty({ example: ['/dashboard/arrivals', '/dashboard/check-in'], description: 'Page keys from GET /branches/:branchId/page-access — every page the role opens; an empty list opens none' })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  pages!: string[];
}
