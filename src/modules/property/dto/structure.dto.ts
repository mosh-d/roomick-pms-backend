import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateBuildingDto {
  @ApiProperty({ example: 'Main Tower' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}

export class RenameBuildingDto {
  @ApiProperty({ example: 'East Wing' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}

export class UpdateFloorDto {
  @ApiPropertyOptional({ example: 2, description: '0 = ground floor' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  floorNumber?: number;

  @ApiPropertyOptional({ example: 'Second Floor', description: 'Empty clears it' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  label?: string;
}

export class CreateFloorDto {
  @ApiProperty({ example: 1, description: '0 = ground floor' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  floorNumber!: number;

  @ApiPropertyOptional({ example: 'Mezzanine' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  label?: string;
}
