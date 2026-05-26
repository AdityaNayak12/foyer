import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, TicketStatus } from '@prisma/client';
import * as crypto from 'crypto';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: PrismaService;

  const mockPrisma = {
    payment: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    order: {
      update: jest.fn(),
    },
    ticket: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    orderItem: {
      update: jest.fn(),
    },
    $transaction: jest.fn((cb) => cb(mockPrisma)),
  };

  const mockConfig = {
    get: jest.fn((key: string) => {
      if (key === 'RAZORPAY_KEY_SECRET') return 'secret-123';
      return null;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    prisma = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('verifyPayment Flow', () => {
    it('should throw NotFoundException if payment record does not exist', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.verifyPayment('user-1', {
          razorpayOrderId: 'rzp_order_nonexistent',
          razorpayPaymentId: 'pay_xyz',
          razorpaySignature: 'sig_123',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return successfully early if order is already PAID (Idempotent)', async () => {
      const mockPayment = {
        id: 'pay-1',
        orderId: 'order-1',
        status: PaymentStatus.INITIATED,
        order: {
          id: 'order-1',
          buyerId: 'user-1',
          status: OrderStatus.PAID,
          items: [],
        },
      };

      const mockTickets = [
        { id: 't-1', ownerId: 'user-1', qrToken: 'token-abc' },
      ];

      mockPrisma.payment.findUnique.mockResolvedValue(mockPayment);
      mockPrisma.ticket.findMany.mockResolvedValue(mockTickets);

      const result = await service.verifyPayment('user-1', {
        razorpayOrderId: 'rzp_order_paid',
        razorpayPaymentId: 'pay_xyz',
        razorpaySignature: 'sig_123',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('already been successfully verified');
      expect(result.tickets).toEqual(mockTickets);
    });

    it('should throw BadRequestException if signature is invalid', async () => {
      const mockPayment = {
        id: 'pay-1',
        orderId: 'order-1',
        status: PaymentStatus.INITIATED,
        order: {
          id: 'order-1',
          buyerId: 'user-1',
          status: OrderStatus.PENDING_CHECKOUT,
          items: [],
        },
      };

      mockPrisma.payment.findUnique.mockResolvedValue(mockPayment);

      // Generating a signature that mismatch
      await expect(
        service.verifyPayment('user-1', {
          razorpayOrderId: 'rzp_order_abc', // not mock prefix
          razorpayPaymentId: 'pay_xyz',
          razorpaySignature: 'mismatch_signature_123',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should settle order and mint tickets on successful mock/valid verification', async () => {
      const mockPayment = {
        id: 'pay-1',
        orderId: 'order-1',
        status: PaymentStatus.INITIATED,
        order: {
          id: 'order-1',
          buyerId: 'user-1',
          status: OrderStatus.PENDING_CHECKOUT,
          items: [
            {
              id: 'item-1',
              price: 150.0,
              ticketType: { id: 'tt-1', eventId: 'event-1' },
            },
          ],
        },
      };

      mockPrisma.payment.findUnique.mockResolvedValue(mockPayment);
      mockPrisma.order.update.mockResolvedValue({
        id: 'order-1',
        status: OrderStatus.PAID,
      });
      mockPrisma.ticket.create.mockResolvedValue({
        id: 't-123',
        ownerId: 'user-1',
        qrToken: 'secure-token-123',
      });

      // Use a mock order ID to bypass actual cryptographic checks
      const result = await service.verifyPayment('user-1', {
        razorpayOrderId: 'rzp_mock_123',
        razorpayPaymentId: 'pay_mock_xyz',
        razorpaySignature: 'sig_mock_abc',
      });

      expect(result.success).toBe(true);
      expect(result.order.status).toBe(OrderStatus.PAID);
      expect(result.tickets.length).toBe(1);
      expect(mockPrisma.ticket.create).toHaveBeenCalled();
      expect(mockPrisma.orderItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { ticketId: 't-123' },
      });
    });
  });
});
