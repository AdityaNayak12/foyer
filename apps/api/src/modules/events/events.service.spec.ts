import { Test, TestingModule } from '@nestjs/testing';
import { EventsService } from './events.service';
import { PrismaService } from '../prisma/prisma.service';
import { ForbiddenException, BadRequestException } from '@nestjs/common';

describe('EventsService', () => {
  let service: EventsService;


  const mockPrisma: any = {
    organizer: {
      findUnique: jest.fn(),
    },
    event: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn((cb) => cb(mockPrisma)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createEvent Date Validations', () => {
    it('should throw BadRequestException if startDate is after endDate', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const dayBefore = new Date();
      dayBefore.setDate(dayBefore.getDate() - 1);

      await expect(
        service.createEvent('user-1', {
          title: 'Concert',
          location: 'Stadium',
          startDate: tomorrow.toISOString(),
          endDate: dayBefore.toISOString(), // end date is prior
          ticketTypes: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if startDate is in the past', async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 2);

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 2);

      await expect(
        service.createEvent('user-1', {
          title: 'Concert',
          location: 'Stadium',
          startDate: pastDate.toISOString(),
          endDate: futureDate.toISOString(),
          ticketTypes: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException if user is not a registered organizer', async () => {
      const futureStart = new Date();
      futureStart.setDate(futureStart.getDate() + 1);

      const futureEnd = new Date();
      futureEnd.setDate(futureEnd.getDate() + 2);

      mockPrisma.organizer.findUnique.mockResolvedValue(null); // not registered

      await expect(
        service.createEvent('user-1', {
          title: 'Concert',
          location: 'Stadium',
          startDate: futureStart.toISOString(),
          endDate: futureEnd.toISOString(),
          ticketTypes: [],
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
