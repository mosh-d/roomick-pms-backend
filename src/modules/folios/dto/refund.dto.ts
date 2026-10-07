import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { RefundStatus } from '@prisma/client';

/** The ways money can go back to a guest. Points go back as a loyalty adjustment, and a voucher isn't money. */
export const REFUND_METHODS = ['cash', 'card', 'bank_transfer'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

export class RequestRefundDto {
  @ApiProperty({ example: 15000, description: 'Up to what the bill holds in credit, less refunds already on their way.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({ description: "The payment being refunded. Its method is the refund's, unless another is given." })
  @IsOptional()
  @IsUUID()
  paymentId?: string;

  @ApiPropertyOptional({ enum: REFUND_METHODS, description: 'How the money goes back. Required when no payment is named.' })
  @IsOptional()
  @IsIn(REFUND_METHODS)
  method?: RefundMethod;

  @ApiProperty({ example: 'Deposit returned — stay cancelled inside the free window' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}

export class RejectRefundDto {
  @ApiProperty({ example: 'Guest already took it as a discount on the next stay' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}

export class ListRefundsQueryDto {
  @ApiPropertyOptional({ enum: RefundStatus })
  @IsOptional()
  @IsIn(Object.values(RefundStatus))
  status?: RefundStatus;
}
