import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { MaintenancePriority, MaintenanceStatus } from '@prisma/client';
import { IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * The architecture map's own payload (`location: {roomId?, areaId?}`,
 * no `title`) is illustrative, not the real shape — `MaintenanceOrder.title`
 * is a required column with no equivalent in that sketch, and there's no
 * `areaId` concept anywhere in this schema (a `null` `roomId` already means
 * "common area", the same convention `Asset.roomId` already uses). This
 * DTO follows the real schema rather than the mockup.
 */
export class CreateWorkOrderDto {
  @ApiProperty({ example: 'AC not cooling in 204' })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ example: 'Guest reported the unit blows warm air even at the lowest setting.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Omit for a common-area issue — the same "null = common area" convention Asset.roomId already uses' })
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({ enum: ['low', 'medium', 'high', 'urgent'], description: 'Defaults to medium' })
  @IsOptional()
  @IsIn(['low', 'medium', 'high', 'urgent'])
  priority?: MaintenancePriority;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photoUrls?: string[];

  @ApiPropertyOptional({ description: 'Blocks the room (heldStatus = out_of_order) atomically with creating this order — requires roomId' })
  @IsOptional()
  @IsBoolean()
  blockRoom?: boolean;
}

export class UpdateWorkOrderDto {
  @ApiPropertyOptional({ enum: ['open', 'in_progress', 'on_hold', 'resolved', 'cancelled'] })
  @IsOptional()
  @IsIn(['open', 'in_progress', 'on_hold', 'resolved', 'cancelled'])
  status?: MaintenanceStatus;

  @ApiPropertyOptional({ description: 'Staff member to assign this to' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  completionNotes?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  partsUsed?: string[];
}

/** `category` is free text with a suggested set (matches the model's own comment: hvac | plumbing | electrical | furniture | appliance) rather than a hard enum — the reference's own four-value list doesn't match this schema's, so this follows the schema. */
export class CreateAssetDto {
  @ApiProperty({ example: 'Rooftop HVAC Unit 2' })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: 'hvac' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ description: 'Omit for a common-area asset (roof unit, lobby generator, etc.)' })
  @IsOptional()
  @IsUUID()
  roomId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serialNumber?: string;

  @ApiPropertyOptional({ example: '2024-03-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  purchaseDate?: string;

  @ApiPropertyOptional({ example: '2027-03-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  warrantyUntil?: string;

  @ApiPropertyOptional({ example: 180, description: 'Preventive maintenance cadence, in days' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  serviceIntervalDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
