import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GdprType } from '@prisma/client';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class CreateGdprRequestDto {
  @ApiProperty()
  @IsUUID()
  guestId!: string;

  @ApiProperty({ enum: ['access', 'erasure', 'portability'] })
  @IsIn(['access', 'erasure', 'portability'])
  type!: GdprType;

  @ApiProperty({ example: 'guest@example.com', description: 'Who is asking — may not be a system user (the guest themself, or their legal representative)' })
  @IsString()
  @MaxLength(320)
  requestedBy!: string;

  @ApiPropertyOptional({ example: 'Verified via ID document on file + matching email' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  verificationMethod?: string;
}

/**
 * `completed`/`rejected` are terminal. An access/portability request
 * completes when its export is downloaded, an erasure when it's carried out
 * (`POST .../erase`) — marking one completed here by hand records work done
 * outside Roomick.
 */
export class UpdateGdprRequestStatusDto {
  @ApiProperty({ enum: ['in_progress', 'completed', 'rejected'] })
  @IsIn(['in_progress', 'completed', 'rejected'])
  status!: 'in_progress' | 'completed' | 'rejected';

  @ApiPropertyOptional({ example: 'Erasure carried out manually 2026-09-05, confirmed with guest by email' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** How long registration cards and guest ID documents are kept after a stay. */
export class RetentionDto {
  @ApiProperty({ nullable: true, example: 24, description: 'Months, 6 to 240; null keeps everything (the default)' })
  @ValidateIf((o: RetentionDto) => o.months !== null)
  @IsInt()
  @Min(6)
  @Max(240)
  months!: number | null;
}
