import { Module } from '@nestjs/common';
import { FoliosModule } from '../folios/folios.module';
import { PropertyModule } from '../property/property.module';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';

@Module({
  imports: [PropertyModule, FoliosModule],
  controllers: [PosController],
  providers: [PosService],
})
export class PosModule {}
