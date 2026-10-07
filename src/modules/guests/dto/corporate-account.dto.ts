import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class CreateCorporateAccountDto {
  @ApiProperty({ example: 'Dangote Group' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: ['dangote.com'], description: "Staff email domains — a guest booked with one is offered this company's rate" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  emailDomains?: string[];

  @ApiPropertyOptional({ description: 'The contracted rate: a negotiated rate plan. Null to clear.', nullable: true })
  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsUUID()
  ratePlanId?: string | null;

  @ApiPropertyOptional({ example: 'Amaka Eze' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional({ example: 'travel@dangote.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  contactEmail?: string;
}

export class UpdateCorporateAccountDto extends PartialType(CreateCorporateAccountDto) {
  @ApiPropertyOptional({ description: 'false stops the account being offered at booking; its past stays keep it' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
