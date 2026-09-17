import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
  ValidateNested,
} from 'class-validator';
import { LOYALTY_BENEFITS } from '../loyalty-rules';

export class LoyaltyTierDto {
  @ApiProperty({ example: 'Gold' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  name!: string;

  @ApiProperty({ example: 1500, description: 'Lifetime points a member needs to reach this tier' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  threshold!: number;

  @ApiProperty({ enum: LOYALTY_BENEFITS, isArray: true, example: ['room_upgrade', 'late_checkout'] })
  @IsArray()
  @ArrayMaxSize(LOYALTY_BENEFITS.length)
  @IsIn(LOYALTY_BENEFITS, { each: true })
  benefits!: string[];
}

export class SaveLoyaltyProgramDto {
  @ApiProperty({ description: 'Off = nobody earns or redeems; balances are kept' })
  @IsBoolean()
  isActive!: boolean;

  @ApiProperty({ example: 'NGN', description: 'Earning and redemption happen at branches that charge in this currency' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency!: string;

  @ApiProperty({ example: 0.01, description: 'Points per 1 unit of currency spent before tax — 0.01 is 1 point per 100' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(1000)
  pointsPerUnit!: number;

  @ApiProperty({ example: 1, description: 'What one point is worth when redeemed' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(1_000_000)
  pointValue!: number;

  @ApiProperty({ type: [LoyaltyTierDto] })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => LoyaltyTierDto)
  tiers!: LoyaltyTierDto[];
}

export class AdjustPointsDto {
  @ApiProperty({ example: 250, description: 'Signed: positive adds points, negative takes them off' })
  @Type(() => Number)
  @IsInt()
  @NotEquals(0)
  @Min(-10_000_000)
  @Max(10_000_000)
  points!: number;

  @ApiProperty({ example: 'Goodwill — noisy room on the 14th' })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

export class RedeemPointsDto {
  @ApiProperty({ example: 1200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  points!: number;
}
