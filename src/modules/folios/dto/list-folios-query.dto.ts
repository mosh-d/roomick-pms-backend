import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { FOLIO_LIST_MAX, FolioListFilter } from '../folios.service';

const FILTERS: readonly FolioListFilter[] = ['all', 'outstanding', 'overdue', 'in_house', 'refund_due'];

export class ListFoliosQueryDto {
  @ApiPropertyOptional({ enum: FILTERS, description: 'outstanding = balance owed · overdue = owed and checked out · in_house = open bills of checked-in guests · refund_due = credit owed to the guest · all (paged)' })
  @IsOptional()
  @IsIn(FILTERS)
  filter?: FolioListFilter;

  @ApiPropertyOptional({ example: 200, description: `"all" only — at most ${FOLIO_LIST_MAX}` })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FOLIO_LIST_MAX)
  limit?: number;

  @ApiPropertyOptional({ example: 0, description: '"all" only' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
