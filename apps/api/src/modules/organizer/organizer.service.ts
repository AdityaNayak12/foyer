import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizerDto } from './dto/create-organizer.dto';
import { UserRole } from '@prisma/client';

@Injectable()
export class OrganizerService {
  constructor(private prisma: PrismaService) {}

  async registerOrganizer(userId: string, email: string, dto: CreateOrganizerDto) {
    // Check if organizer record already exists
    const existingOrganizer = await this.prisma.organizer.findUnique({
      where: { userId },
    });

    if (existingOrganizer) {
      throw new ConflictException('You are already registered as an organizer');
    }

    // Ensure the User record exists (lazy registration from Clerk token context)
    let user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          id: userId,
          email,
          role: UserRole.ORGANIZER,
        },
      });
    }

    // Transactionally create the organizer record and update the user role
    return this.prisma.$transaction(async (tx) => {
      const organizer = await tx.organizer.create({
        data: {
          userId,
          companyName: dto.companyName,
          payoutDetails: dto.payoutDetails,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { role: UserRole.ORGANIZER },
      });

      return organizer;
    });
  }

  async getOrganizerProfile(userId: string) {
    const organizer = await this.prisma.organizer.findUnique({
      where: { userId },
      include: { user: true },
    });

    if (!organizer) {
      throw new NotFoundException('Organizer profile not found');
    }

    return organizer;
  }
}
