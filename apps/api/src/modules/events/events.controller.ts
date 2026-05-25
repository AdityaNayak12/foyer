import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ClerkAuthGuard } from '../../common/guards/clerk-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @UseGuards(ClerkAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateEventDto,
  ) {
    return this.eventsService.createEvent(userId, dto);
  }

  @Get()
  async findAll() {
    return this.eventsService.listEvents();
  }

  @Get('slug/:slug')
  async findBySlug(@Param('slug') slug: string) {
    return this.eventsService.getEventBySlug(slug);
  }

  @Get(':id/inventory')
  @UseGuards(ClerkAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  async getInventory(
    @CurrentUser('id') userId: string,
    @Param('id') eventId: string,
  ) {
    return this.eventsService.getOrganizerInventory(userId, eventId);
  }
}
