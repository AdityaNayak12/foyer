import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { OrderStatus, PaymentStatus, TicketStatus } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  async verifyPayment(buyerId: string, dto: VerifyPaymentDto) {
    // 1. Find the Payment record by gatewayOrderId
    const payment = await this.prisma.payment.findUnique({
      where: { gatewayOrderId: dto.razorpayOrderId },
      include: {
        order: {
          include: {
            items: {
              include: {
                ticketType: true,
              },
            },
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException(
        `Payment for gateway order "${dto.razorpayOrderId}" not found`,
      );
    }

    const order = payment.order;

    if (order.buyerId !== buyerId) {
      throw new BadRequestException(
        'Unauthorized payment verification request',
      );
    }

    // Idempotency: if already paid, return early with tickets
    if (order.status === OrderStatus.PAID) {
      const tickets = await this.prisma.ticket.findMany({
        where: {
          ownerId: buyerId,
          orderItems: {
            some: {
              orderId: order.id,
            },
          },
        },
      });
      return {
        success: true,
        message: 'Payment has already been successfully verified.',
        order,
        tickets,
      };
    }

    if (order.status !== OrderStatus.PENDING_CHECKOUT) {
      throw new BadRequestException(
        `Order is in state "${order.status}" and cannot be paid.`,
      );
    }

    // 2. Signature Check (HMAC-SHA256)
    const isMockOrder = dto.razorpayOrderId.startsWith('rzp_mock_');
    if (!isMockOrder) {
      const keySecret = this.configService.get<string>('RAZORPAY_KEY_SECRET');
      if (!keySecret) {
        throw new BadRequestException(
          'Razorpay gateway is not configured on the server.',
        );
      }

      const text = `${dto.razorpayOrderId}|${dto.razorpayPaymentId}`;
      const generatedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(text)
        .digest('hex');

      if (generatedSignature !== dto.razorpaySignature) {
        this.logger.warn(
          `Signature mismatch: generated=${generatedSignature}, provided=${dto.razorpaySignature}`,
        );
        throw new BadRequestException(
          'Invalid payment signature verification failed',
        );
      }
    } else {
      this.logger.log(
        `Mock payment signature verification triggered for order: ${dto.razorpayOrderId}`,
      );
    }

    // 3. Complete Checkout transactionally (lock Order row, update statuses, mint tickets)
    return this.prisma.$transaction(async (tx) => {
      // Perform a locked SELECT ... FOR UPDATE inside the transaction block
      const lockedOrders = await tx.$queryRaw<any[]>`
        SELECT id, status FROM "Order" WHERE id = ${order.id}::uuid FOR UPDATE
      `;

      const lockedOrder = lockedOrders?.[0];
      if (!lockedOrder) {
        throw new NotFoundException(
          `Order "${order.id}" not found during transaction lock.`,
        );
      }

      // Idempotency check inside transaction
      if (lockedOrder.status === OrderStatus.PAID) {
        this.logger.log(
          `Order ${order.id} was already marked as PAID inside transaction lock. Returning early.`,
        );
        // Find existing tickets using transactional client 'tx'
        const tickets = await tx.ticket.findMany({
          where: {
            ownerId: buyerId,
            orderItems: {
              some: {
                orderId: order.id,
              },
            },
          },
        });
        return {
          success: true,
          message: 'Payment has already been successfully verified.',
          order: {
            ...order,
            status: OrderStatus.PAID,
          },
          tickets,
        };
      }

      if (lockedOrder.status !== OrderStatus.PENDING_CHECKOUT) {
        throw new BadRequestException(
          `Order is in state "${lockedOrder.status}" and cannot be paid.`,
        );
      }

      // Transition order status to PAID
      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.PAID },
      });

      // Update payment status to CAPTURED
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.CAPTURED,
          gatewayPaymentId: dto.razorpayPaymentId,
          gatewaySignature: dto.razorpaySignature,
        },
      });

      const ticketsCreated = [];

      // Mint a ticket for each OrderItem
      for (const item of order.items) {
        if (!item.ticketType) {
          continue;
        }

        const qrToken = crypto.randomBytes(32).toString('hex');

        // Create physical ticket record
        const ticket = await tx.ticket.create({
          data: {
            eventId: item.ticketType.eventId,
            ticketTypeId: item.ticketType.id,
            ownerId: buyerId,
            purchasePrice: item.price,
            status: TicketStatus.ACTIVE,
            qrToken,
          },
        });

        // Link OrderItem to this Ticket
        await tx.orderItem.update({
          where: { id: item.id },
          data: { ticketId: ticket.id },
        });

        ticketsCreated.push(ticket);
      }

      this.logger.log(
        `Order verified and settled successfully: orderId=${order.id}, ticketsMinted=${ticketsCreated.length}`,
      );

      return {
        success: true,
        order: updatedOrder,
        tickets: ticketsCreated,
      };
    });
  }
}
