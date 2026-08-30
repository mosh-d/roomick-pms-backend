import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GdprType } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
 * `completed`/`rejected` are terminal — this system never runs an automated
 * erasure itself (see `GdprService.downloadExport`'s own comment on why),
 * so "completed" here always means a human process outside this system
 * actually carried out the request; this only records that it happened.
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
