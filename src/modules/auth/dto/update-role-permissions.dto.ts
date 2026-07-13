import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class UpdateRolePermissionsDto {
  @ApiProperty({
    description: 'Permission map: {module: [actions]}',
    example: { reservations: ['read', 'create'], folios: ['read'] },
  })
  @IsObject()
  permissions!: Record<string, string[]>;
}
