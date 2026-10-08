import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { IsDateOnly } from '../../../common/validation/is-date-only.decorator';

export class CustomReportFilterDto {
  @ApiProperty({ example: 'status' })
  @IsString()
  @MaxLength(40)
  field!: string;

  @ApiProperty({ example: 'equals' })
  @IsString()
  @MaxLength(20)
  operator!: string;

  @ApiProperty({ example: 'checked_out' })
  @IsString()
  @MaxLength(200)
  value!: string;
}

/** What a report is: a dataset, its columns, filters, grouping and sort. Saved as a template without the dates. */
export class CustomReportDefinitionDto {
  @ApiProperty({ enum: ['reservations', 'charges', 'payments', 'guests'] })
  @IsIn(['reservations', 'charges', 'payments', 'guests'])
  dataset!: string;

  @ApiProperty({ type: [String], example: ['confirmationNumber', 'guestName', 'roomTotal'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @IsString({ each: true })
  fields!: string[];

  @ApiPropertyOptional({ type: [CustomReportFilterDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CustomReportFilterDto)
  filters?: CustomReportFilterDto[];

  @ApiPropertyOptional({ example: 'roomType', description: 'One row per value, with a count and the sum of every money and number column' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  groupBy?: string;

  @ApiPropertyOptional({ example: 'roomTotal' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';
}

export class RunCustomReportDto extends CustomReportDefinitionDto {
  @ApiProperty({ example: '2026-10-01' })
  @IsDateOnly()
  from!: string;

  @ApiProperty({ example: '2026-11-01', description: 'Exclusive' })
  @IsDateOnly()
  to!: string;
}

export class SaveReportTemplateDto {
  @ApiProperty({ example: 'Corporate stays this month' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ type: CustomReportDefinitionDto })
  @ValidateNested()
  @Type(() => CustomReportDefinitionDto)
  definition!: CustomReportDefinitionDto;
}
