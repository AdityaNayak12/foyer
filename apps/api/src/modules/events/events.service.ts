import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEventDto } from './dto/create-event.dto';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private prisma: PrismaService) {}

  async createEvent(userId: string, dto: CreateEventDto) {
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    const now = new Date();

    if (start >= end) {
      throw new BadRequestException('Event start date must be prior to end date');
    }

    if (start <= now) {
      throw new BadRequestException('Event start date must be in the future');
    }

    // 1. Verify user is registered as an organizer
    const organizer = await this.prisma.organizer.findUnique({
      where: { userId },
    });

    if (!organizer) {
      throw new ForbiddenException(
        'Only registered organizers are authorized to create events',
      );
    }

    // 2. Generate unique slug
    let slug = this.slugify(dto.title);
    const existingEvent = await this.prisma.event.findUnique({
      where: { slug },
    });

    if (existingEvent) {
      // Append a small unique random suffix if slug clashes
      const suffix = Math.random().toString(36).substring(2, 7);
      slug = `${slug}-${suffix}`;
    }

    // 3. Create Event and TicketTypes in a transaction
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.event.create({
        data: {
          organizerId: organizer.id,
          title: dto.title,
          description: dto.description,
          slug,
          location: dto.location,
          imageUrl: dto.imageUrl,
          startDate: new Date(dto.startDate),
          endDate: new Date(dto.endDate),
          ticketTypes: {
            create: dto.ticketTypes.map((tt) => ({
              name: tt.name,
              price: tt.price,
              capacity: tt.capacity,
              soldCount: 0,
            })),
          },
        },
        include: {
          ticketTypes: true,
        },
      });

      this.logger.log(
        `Event created successfully: id=${event.id}, slug=${event.slug}, organizerId=${organizer.id}`,
      );

      return event;
    });
  }

  async listEvents() {
    return this.prisma.event.findMany({
      where: {
        endDate: {
          gte: new Date(),
        },
      },
      include: {
        ticketTypes: {
          select: {
            id: true,
            name: true,
            price: true,
            capacity: true,
            soldCount: true,
          },
        },
      },
      orderBy: {
        startDate: 'asc',
      },
    });
  }

  async getEventBySlug(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: {
        ticketTypes: {
          select: {
            id: true,
            name: true,
            price: true,
            capacity: true,
            soldCount: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException(`Event with slug "${slug}" not found`);
    }

    return event;
  }

  async getOrganizerInventory(userId: string, eventId: string) {
    // 1. Verify organizer profile exists
    const organizer = await this.prisma.organizer.findUnique({
      where: { userId },
    });

    if (!organizer) {
      throw new ForbiddenException(
        'Only registered organizers can view event inventories',
      );
    }

    // 2. Fetch event and verify ownership
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        organizerId: organizer.id,
      },
      include: {
        ticketTypes: {
          include: {
            _count: {
              select: {
                tickets: true,
                orderItems: true,
              },
            },
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException(
        'Event not found or you are not authorized to view its inventory',
      );
    }

    return event;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
