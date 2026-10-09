import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { ErrorCode } from '../../common/errors/error-codes';
import { ROOM_PHOTO_ROUTE } from './room-photos';
import { RoomsService } from './rooms.service';

/**
 * Uploaded room photos, for anyone — the booking page shows them to guests.
 * The bucket behind them stays private; only a room photo's own address
 * (random, and checked before storage is asked) reaches it. A photo never
 * changes once uploaded, so it's cached for a year.
 */
@ApiTags('public-room-photos')
@Controller(ROOM_PHOTO_ROUTE)
@Public()
export class RoomPhotosController {
  constructor(private readonly roomsService: RoomsService) {}

  @Get(':tenantId/:roomTypeId/:file')
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({ summary: 'An uploaded room photo' })
  async photo(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('roomTypeId', ParseUUIDPipe) roomTypeId: string,
    @Param('file') file: string,
    @Res() res: Response,
  ): Promise<void> {
    const photo = await this.roomsService.readRoomPhoto(tenantId, roomTypeId, file);
    if (!photo) throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Photo not found' });
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // Shown on the web app's own pages, another origin than this API's.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.send(photo.body);
  }
}
