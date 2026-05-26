import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../../common/guards/clerk-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizerService } from './organizer.service';
import { CreateOrganizerDto } from './dto/create-organizer.dto';

@Controller('organizers')
export class OrganizerController {
  constructor(private readonly organizerService: OrganizerService) {}

  @Post('register')
  @UseGuards(ClerkAuthGuard)
  async register(
    @CurrentUser() user: { id: string; email: string },
    @Body() dto: CreateOrganizerDto,
  ) {
    return this.organizerService.registerOrganizer(user.id, user.email, dto);
  }

  @Get('profile')
  @UseGuards(ClerkAuthGuard)
  async getProfile(@CurrentUser() user: { id: string }) {
    return this.organizerService.getOrganizerProfile(user.id);
  }
}
