import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, CurrentUser } from '../../common/decorators';
import { Roles, SystemRole } from '../../common/decorators/roles.decorator';
import { JwtPayload } from '../../common/types/request-context';
import { SignRegistrationCardDto } from './dto/registration-card.dto';
import { RegistrationCardsService } from './registration-cards.service';

@ApiTags('registration-cards')
@ApiBearerAuth()
@Controller()
export class RegistrationCardsController {
  constructor(private readonly registrationCardsService: RegistrationCardsService) {}

  @Post('reservations/:reservationId/registration-card/generate')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Generate a pre-filled registration card for a checked-in reservation (usually automatic at check-in — this is the manual/backfill path)' })
  generateCard(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): ReturnType<RegistrationCardsService['generateCard']> {
    return this.registrationCardsService.generateCard(tenantId, reservationId, user.sub);
  }

  @Get('reservations/:reservationId/registration-card')
  @ApiOperation({ summary: "A reservation's own registration card, if one has been generated yet" })
  getCardForReservation(
    @CurrentTenant() tenantId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): ReturnType<RegistrationCardsService['getCardForReservation']> {
    return this.registrationCardsService.getCardForReservation(tenantId, reservationId);
  }

  @Get('registration-cards/:cardId')
  @ApiOperation({ summary: 'Get a registration card' })
  getCard(@CurrentTenant() tenantId: string, @Param('cardId', ParseUUIDPipe) cardId: string): ReturnType<RegistrationCardsService['getCard']> {
    return this.registrationCardsService.getCard(tenantId, cardId);
  }

  @Post('registration-cards/:cardId/sign')
  @Roles(SystemRole.Owner, SystemRole.Manager, SystemRole.FrontDesk)
  @ApiOperation({ summary: 'Capture the guest signature — a legal document, signed once' })
  signCard(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('cardId', ParseUUIDPipe) cardId: string,
    @Body() dto: SignRegistrationCardDto,
  ): ReturnType<RegistrationCardsService['signCard']> {
    return this.registrationCardsService.signCard(tenantId, cardId, dto, user.sub);
  }
}
