import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

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

  @ApiPropertyOptional({ example: 30, description: 'Days the company has to pay an invoice — its due date. Null = due on receipt.', nullable: true })
  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermsDays?: number | null;

  @ApiPropertyOptional({ example: '1 Alfred Rewane Road, Ikoyi, Lagos', description: 'Printed on its invoices. Blank to clear.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  billingAddress?: string;
}

/** The company list a page at a time, and found by name or email domain. */
export class ListCorporateAccountsQueryDto {
  @ApiPropertyOptional({ example: 'dangote', description: 'Part of a name, a contact, or an email domain' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Only active accounts (true) or only switched-off ones (false)' })
  @IsOptional()
  @IsIn(['true', 'false'])
  active?: 'true' | 'false';

  @ApiPropertyOptional({ default: 500, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class UpdateCorporateAccountDto extends PartialType(CreateCorporateAccountDto) {
  @ApiPropertyOptional({ description: 'false stops the account being offered at booking; its past stays keep it' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
