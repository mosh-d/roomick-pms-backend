import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateRolePermissionsDto {
  @ApiProperty({
    description: 'Permission map: {module: [actions]}',
    example: { reservations: ['read', 'create'], folios: ['read'] },
  })
  @IsObject()
  permissions!: Record<string, string[]>;
}

export class CreateRoleDto {
  @ApiProperty({ example: 'Night Auditor', description: 'Shown wherever staff are assigned a role. Can’t be one of the built-in role names.' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ description: 'Permission map: {module: [actions]}. Empty means the role can do nothing until it’s scoped.' })
  @IsOptional()
  @IsObject()
  permissions?: Record<string, string[]>;
}

export class UpdateRoleDto {
  @ApiPropertyOptional({ example: 'Night Manager' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ description: 'Permission map: {module: [actions]}' })
  @IsOptional()
  @IsObject()
  permissions?: Record<string, string[]>;
}
