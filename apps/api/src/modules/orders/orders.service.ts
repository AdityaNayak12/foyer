import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStatus, PaymentStatus, TicketType, Prisma, UserRole } from '@prisma/client';
import Razorpay from 'razorpay';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private razorpay: Razorpay | null = null;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    const keyId = this.configService.get<string>('RAZORPAY_KEY_ID');
    const keySecret = this.configService.get<string>('RAZORPAY_KEY_SECRET');
    const enableMock = this.configService.get<boolean>('ENABLE_MOCK_PAYMENTS') ?? false;
    const isProd = this.configService.get<string>('NODE_ENV') === 'production';

    if (enableMock) {
      if (isProd) {
        throw new Error(
          'Security Violation: Mock payments cannot be enabled in production environments!',
        );
      }
      this.logger.warn('Operating in MOCK payment gateway mode as requested by configuration.');
    } else if (keyId && keySecret && keyId !== 'rzp_test_...') {
      this.razorpay = new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      });
    } else {
      if (isProd) {
        throw new Error(
          'Razorpay credentials are not fully configured in production mode.',
        );
      }
      this.logger.warn(
        'Razorpay credentials not fully configured or sandbox keys are placeholders. Operating in MOCK payment gateway mode.',
      );
    }
  }

  async createOrder(
    buyerId: string,
    idempotencyKey: string,
    dto: CreateOrderDto,
  ) {
    // 1. Idempotency Check: search for existing order by idempotencyKey
    const existingOrder = await this.prisma.order.findUnique({
      where: { idempotencyKey },
      include: {
        items: true,
        payments: true,
      },
    });

    if (existingOrder) {
      if (existingOrder.buyerId !== buyerId) {
        throw new ConflictException(
          'This idempotency key is already registered to another user order.',
        );
      }
      this.logger.log(
        `Idempotency trigger: Order already exists for key ${idempotencyKey}. Returning existing record.`,
      );
      return existingOrder;
    }

    // Ensure the User record exists (lazy registration from Clerk token context)
    const userExists = await this.prisma.user.findUnique({
      where: { id: buyerId },
    });
    if (!userExists) {
      // Create user record using lazy registration
      const fallbackDomain = this.configService.get<string>('FALLBACK_USER_DOMAIN') ?? 'clerk.foyer.dev';
      await this.prisma.user.create({
        data: {
          id: buyerId,
          email: `${buyerId}@${fallbackDomain}`, // fallback, usually matches
          role: UserRole.BUYER,
        },
      });
    }

    // 2. Perform Transactional Stock Reservation and Order Creation
    return this.prisma.$transaction(
      async (tx) => {
        let totalAmount = new Prisma.Decimal(0);
        const ticketTypesSnapshot: TicketType[] = [];

        // Validate ticket types and check/reserve capacity atomically
        for (const item of dto.items) {
          const ticketType = await tx.ticketType.findUnique({
            where: { id: item.ticketTypeId },
          });

          if (!ticketType) {
            throw new NotFoundException(
              `Ticket type with ID "${item.ticketTypeId}" not found`,
            );
          }

          ticketTypesSnapshot.push(ticketType);
          totalAmount = totalAmount.add(ticketType.price.mul(item.quantity));

          // Perform atomic capacity increment and bounds check
          const affectedRows = await tx.$executeRaw`
            UPDATE "TicketType"
            SET "soldCount" = "soldCount" + ${item.quantity}
            WHERE id = ${item.ticketTypeId}::uuid AND "soldCount" + ${item.quantity} <= capacity
          `;

          if (affectedRows === 0) {
            throw new BadRequestException(
              `Insufficient capacity for ticket type "${ticketType.name}". Insufficient tickets remaining.`,
            );
          }
        }

        // Create the Order in PENDING_CHECKOUT state
        const orderExpiry = new Date();
        const expiryMinutes = this.configService.get<number>('ORDER_EXPIRY_MINUTES') ?? 10;
        orderExpiry.setMinutes(orderExpiry.getMinutes() + expiryMinutes); // Configurable expiry window

        // Flatten items to create one OrderItem row per ticket quantity
        const orderItemsCreate: any[] = [];
        dto.items.forEach((item, idx) => {
          const tType = ticketTypesSnapshot[idx];
          for (let q = 0; q < item.quantity; q++) {
            orderItemsCreate.push({
              ticketTypeId: item.ticketTypeId,
              price: tType.price,
            });
          }
        });

        const order = await tx.order.create({
          data: {
            buyerId,
            totalAmount,
            status: OrderStatus.PENDING_CHECKOUT,
            expiresAt: orderExpiry,
            idempotencyKey,
            items: {
              create: orderItemsCreate,
            },
          },
          include: {
            items: true,
          },
        });

        // Initialize Razorpay Order reference
        let gatewayOrderId = `rzp_mock_${Math.random().toString(36).substring(2, 15)}`;
        if (this.razorpay) {
          try {
            const rzpOrder = await this.razorpay.orders.create({
              amount: Math.round(totalAmount.toNumber() * 100), // convert to paise
              currency: 'INR',
              receipt: order.id,
            });
            gatewayOrderId = rzpOrder.id;
          } catch (err) {
            this.logger.error('Failed to create Razorpay checkout order:', err);
            throw new BadRequestException(
              `Payment gateway integration failure: ${err instanceof Error ? err.message : 'Unknown payment gateway response'}`,
            );
          }
        }

        // Save the Payment record mapped to our Order
        const payment = await tx.payment.create({
          data: {
            orderId: order.id,
            amount: totalAmount,
            status: PaymentStatus.INITIATED,
            gateway: 'RAZORPAY',
            gatewayOrderId,
          },
        });

        this.logger.log(
          `Order created successfully: id=${order.id}, totalAmount=${totalAmount.toString()}, gatewayOrderId=${gatewayOrderId}`,
        );

        return {
          ...order,
          payments: [payment],
        };
      },
      {
        timeout: 10000, // 10s timeout to prevent thread blocks on high capacity locking
      },
    );
  }

  async getOrder(buyerId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            ticketType: {
              include: {
                event: true,
              },
            },
          },
        },
        payments: true,
      },
    });

    if (!order) {
      throw new NotFoundException(`Order with ID "${orderId}" not found`);
    }

    if (order.buyerId !== buyerId) {
      throw new ForbiddenException('You are not authorized to view this order');
    }

    return order;
  }

  // Background Cron to reclaim expired checkout reservations every 1 minute
  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupExpiredOrders() {
    const now = new Date();

    // Find all expired pending orders
    const expiredOrders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING_CHECKOUT,
        expiresAt: {
          lt: now,
        },
      },
      include: {
        items: true,
      },
    });

    if (expiredOrders.length === 0) {
      return;
    }

    this.logger.log(
      `Found ${expiredOrders.length} expired pending checkout orders to reclaim.`,
    );

    for (const order of expiredOrders) {
      try {
        await this.prisma.$transaction(async (tx) => {
          // Transition order state to EXPIRED
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.EXPIRED },
          });

          // Decr payment record to FAILED
          await tx.payment.updateMany({
            where: { orderId: order.id, status: PaymentStatus.INITIATED },
            data: { status: PaymentStatus.FAILED },
          });

          // Reclaim capacity by grouping ticket types and executing bulk updates
          const reclamationMap: Record<string, number> = {};
          for (const item of order.items) {
            if (item.ticketTypeId) {
              reclamationMap[item.ticketTypeId] =
                (reclamationMap[item.ticketTypeId] || 0) + 1;
            }
          }

          for (const [ttId, qty] of Object.entries(reclamationMap)) {
            await tx.$executeRaw`
              UPDATE "TicketType"
              SET "soldCount" = GREATEST(0, "soldCount" - ${qty})
              WHERE id = ${ttId}::uuid
            `;
          }
        });
        this.logger.log(
          `Successfully expired order=${order.id} and reclaimed capacities.`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to reclaim capacity for expired order=${order.id}:`,
          err,
        );
      }
    }
  }
}
