import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, Min, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { IssuePriority, IssueStatus, ShiftType } from '@prisma/client';

export class CashDenominationDto {
  @ApiProperty({ example: 1000, description: 'Note/coin face value, in the branch currency’s smallest-to-largest denominations' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  denomination!: number;

  @ApiProperty({ example: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  count!: number;
}

export class OpenShiftDto {
  @ApiProperty({ enum: ShiftType, example: 'morning' })
  @IsIn(Object.values(ShiftType))
  shiftType!: ShiftType;

  @ApiProperty({ example: 50000.0, description: 'Cash float the drawer opens with' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  openingFloat!: number;

  @ApiPropertyOptional({ type: [CashDenominationDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CashDenominationDto)
  openingBreakdown?: CashDenominationDto[];
}

export class AddShiftIssueDto {
  @ApiProperty({ example: 'POS terminal 2 offline, taking cash-only at the bar until IT arrives.' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @ApiPropertyOptional({ enum: IssuePriority, description: 'Defaults to "medium"' })
  @IsOptional()
  @IsIn(Object.values(IssuePriority))
  priority?: IssuePriority;
}

export class CloseShiftDto {
  @ApiProperty({ example: 187500.0, description: 'Physically counted cash in the drawer at close' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  closingCashCounted!: number;

  @ApiPropertyOptional({ type: [CashDenominationDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CashDenominationDto)
  closingBreakdown?: CashDenominationDto[];

  @ApiPropertyOptional({
    example: 'Guest paid exact change for a walk-in that was voided and re-booked; drawer never received the correction.',
    description: 'Required only when the counted-vs-system variance exceeds the branch threshold',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  varianceExplanation?: string;

  @ApiPropertyOptional({ example: 'Room 214 minibar restock still pending — housekeeping notified.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  handoverNotes?: string;

  @ApiPropertyOptional({
    type: [AddShiftIssueDto],
    description: 'New issues to hand to the next shift, logged in the same close action rather than a separate round trip',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddShiftIssueDto)
  unresolvedIssues?: AddShiftIssueDto[];
}

const ISSUE_UPDATE_STATUSES: IssueStatus[] = ['resolved', 'carried_over'];

export class UpdateShiftIssueDto {
  @ApiProperty({ enum: ISSUE_UPDATE_STATUSES, description: '"resolved" = handled, stamped with who/when. "carried_over" = still open, explicitly passed forward again — never silently deleted.' })
  @IsIn(ISSUE_UPDATE_STATUSES)
  status!: 'resolved' | 'carried_over';

  @ApiPropertyOptional({ example: 'IT swapped the terminal at 14:20 — back online.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  resolution?: string;
}
