import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** A signature-pad export: a PNG or JPEG data URL. Anything else is refused here rather than failing in the PDF renderer after an encrypted file was already written. */
export class SignRegistrationCardDto {
  @ApiProperty({ description: 'The signature pad canvas as a data URL (`data:image/png;base64,…`), at most 2 MB' })
  @IsString()
  @MinLength(1)
  @MaxLength(2_000_000)
  @Matches(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/, { message: 'signatureData must be a PNG or JPEG data URL' })
  signatureData!: string;
}
