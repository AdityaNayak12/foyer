import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';

jest.mock('razorpay', () => {
  return jest.fn().mockImplementation(() => {
    return {
      orders: {
        create: jest.fn().mockResolvedValue({ id: 'rzp_order_mock' }),
      },
    };
  });
});

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: PrismaService;

  const mockPrisma: any = {
    order: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    ticketType: {
      findUnique: jest.fn(),
    },
    payment: {
      create: jest.fn(),
    },
    $transaction: jest.fn((cb) => cb(mockPrisma)),
    $executeRaw: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn((key: string) => {
      if (key === 'RAZORPAY_KEY_ID') return 'rzp_test_mock';
      if (key === 'RAZORPAY_KEY_SECRET') return 'sec_mock';
      return null;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    prisma = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createOrder Idempotency', () => {
    it('should return existing order if same key and same buyerId', async () => {
      const mockOrder = {
        id: 'order-123',
        buyerId: 'user-1',
        totalAmount: 100,
        status: OrderStatus.PENDING_CHECKOUT,
        idempotencyKey: 'key-123',
        items: [],
        payments: [],
      };

      mockPrisma.order.findUnique.mockResolvedValue(mockOrder);

      const result = await service.createOrder('user-1', 'key-123', {
        items: [],
      });

      expect(result).toEqual(mockOrder);
      expect(mockPrisma.order.findUnique).toHaveBeenCalledWith({
        where: { idempotencyKey: 'key-123' },
        include: { items: true, payments: true },
      });
    });

    it('should throw ConflictException if key exists but belongs to different buyerId', async () => {
      const mockOrder = {
        id: 'order-123',
        buyerId: 'user-2',
        totalAmount: 100,
        status: OrderStatus.PENDING_CHECKOUT,
        idempotencyKey: 'key-123',
      };

      mockPrisma.order.findUnique.mockResolvedValue(mockOrder);

      await expect(
        service.createOrder('user-1', 'key-123', { items: [] }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('createOrder Capacity & Checkouts', () => {
    it('should throw NotFoundException if ticket type does not exist', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrisma.ticketType.findUnique.mockResolvedValue(null);

      await expect(
        service.createOrder('user-1', 'key-abc', {
          items: [{ ticketTypeId: 'tt-456', quantity: 2 }],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if atomic stock check-increment yields 0 rows (Sold out)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrisma.ticketType.findUnique.mockResolvedValue({
        id: 'tt-456',
        name: 'VIP',
        price: new Prisma.Decimal(500),
        capacity: 10,
        soldCount: 9,
      });

      // Mock transaction execution raw query returns 0 rows (failed check)
      mockPrisma.$executeRaw.mockResolvedValue(0);

      await expect(
        service.createOrder('user-1', 'key-abc', {
          items: [{ ticketTypeId: 'tt-456', quantity: 2 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create order successfully on stock check match', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrisma.ticketType.findUnique.mockResolvedValue({
        id: 'tt-456',
        name: 'VIP',
        price: new Prisma.Decimal(500),
        capacity: 10,
        soldCount: 5,
      });

      mockPrisma.$executeRaw.mockResolvedValue(1); // 1 row updated

      const createdOrder = {
        id: 'order-uuid',
        buyerId: 'user-1',
        totalAmount: 1000,
        status: OrderStatus.PENDING_CHECKOUT,
        idempotencyKey: 'key-abc',
        items: [
          { id: 'item-1', ticketTypeId: 'tt-456', price: 500 },
          { id: 'item-2', ticketTypeId: 'tt-456', price: 500 },
        ],
      };

      mockPrisma.order.create.mockResolvedValue(createdOrder);
      mockPrisma.payment.create.mockResolvedValue({
        id: 'pay-uuid',
        orderId: 'order-uuid',
        amount: 1000,
        status: PaymentStatus.INITIATED,
        gatewayOrderId: 'rzp_order_mock',
      });

      const result = await service.createOrder('user-1', 'key-abc', {
        items: [{ ticketTypeId: 'tt-456', quantity: 2 }],
      });

      expect(result.id).toBe('order-uuid');
      expect(result.totalAmount).toBe(1000);
      expect(result.payments[0].status).toBe(PaymentStatus.INITIATED);
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });
  });
});
