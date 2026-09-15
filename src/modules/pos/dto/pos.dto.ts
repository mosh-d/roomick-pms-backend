import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const OUTLET_CATEGORIES = ['restaurant', 'bar', 'spa', 'laundry', 'retail', 'room_service'] as const;
const SETTLEMENTS = ['room', 'cash', 'card'] as const;

// --- Outlets -----------------------------------------------------------------

export class CreateOutletDto {
  @ApiProperty({ example: 'Poolside Bar' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiProperty({ enum: OUTLET_CATEGORIES, description: "Decides the charge type on everything the outlet sells — set once, at creation" })
  @IsIn(OUTLET_CATEGORIES)
  category!: (typeof OUTLET_CATEGORIES)[number];

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** No `category`: it fixed the outlet's charge type at creation, and changing it later would split the outlet's own sales history across two types. */
export class UpdateOutletDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ description: 'Inactive outlets drop off the terminal but keep their history' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

// --- Menu ---------------------------------------------------------------------

export class ModifierOptionDto {
  @ApiProperty({ example: 'Medium rare' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  label!: string;

  @ApiProperty({ example: 0, description: 'Added to the item price; 0 for a free choice' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;
}

export class ModifierGroupDto {
  @ApiProperty({ example: 'Doneness' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiProperty({ enum: ['single', 'multi'] })
  @IsIn(['single', 'multi'])
  selection!: 'single' | 'multi';

  @ApiProperty()
  @IsBoolean()
  required!: boolean;

  @ApiProperty({ type: [ModifierOptionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ModifierOptionDto)
  options!: ModifierOptionDto[];
}

export class CreateMenuItemDto {
  @ApiProperty({ example: 'Jollof rice & chicken' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiProperty({ example: 'Mains' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  category!: string;

  @ApiProperty({ example: 6500, description: 'Before tax' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ type: [ModifierGroupDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ModifierGroupDto)
  modifiers?: ModifierGroupDto[];
}

export class UpdateMenuItemDto extends PartialType(CreateMenuItemDto) {}

export class SetAvailabilityDto {
  @ApiProperty({ description: "false = 86'd — greyed out on the terminal" })
  @IsBoolean()
  isAvailable!: boolean;
}

// --- Orders ---------------------------------------------------------------------

export class OrderModifierDto {
  @ApiProperty({ example: 'Doneness' })
  @IsString()
  @MaxLength(60)
  group!: string;

  @ApiProperty({ example: ['Medium rare'] })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  options!: string[];
}

export class OrderItemDto {
  @ApiProperty()
  @IsUUID()
  menuItemId!: string;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  @Max(99)
  qty!: number;

  @ApiPropertyOptional({ type: [OrderModifierDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => OrderModifierDto)
  modifiers?: OrderModifierDto[];
}

export class QuotePosOrderDto {
  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}

export class CreatePosOrderDto extends QuotePosOrderDto {
  @ApiProperty()
  @IsUUID()
  outletId!: string;

  @ApiProperty({ enum: SETTLEMENTS, description: 'room = charge to an in-house guest; cash / card = paid at the outlet' })
  @IsIn(SETTLEMENTS)
  settlement!: (typeof SETTLEMENTS)[number];

  @ApiPropertyOptional({ description: 'Required for a room charge — from the room lookup, so the cashier has confirmed the guest' })
  @IsOptional()
  @IsUUID()
  reservationId?: string;

  @ApiPropertyOptional({ example: 'T4' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;
}

export class VoidPosOrderDto {
  @ApiProperty({ example: 'Rung up on the wrong table' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ListOrdersQueryDto {
  @ApiPropertyOptional({ example: '2026-09-15', description: "The outlet's business day in the branch timezone; defaults to today" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  @IsISO8601({ strict: true })
  date?: string;
}

export class RoomLookupQueryDto {
  @ApiProperty({ example: '204' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  room!: string;
}
