import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Deleting an organisation is the one action with no way back, so the owner proves it's them. */
export class DeleteOrganizationDto {
  @ApiProperty({ description: 'The owner’s own password' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}
