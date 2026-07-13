import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { toTrimmedLowerCase } from '../../../common/transforms/string.transforms';

export class InviteRowDto {
  @ApiProperty({ example: 'frontdesk@acmehotels.test' })
  @Transform(toTrimmedLowerCase)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ description: 'Role id from GET /auth/roles' })
  @IsUUID()
  roleId!: string;
}

export class BulkInviteDto {
  @ApiProperty({ type: [InviteRowDto], description: 'One invite row per email (spec §3.1)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => InviteRowDto)
  invites!: InviteRowDto[];
}
