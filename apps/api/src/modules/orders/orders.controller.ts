import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Param,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ClerkAuthGuard } from '../../common/guards/clerk-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { isUUID } from 'class-validator';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @UseGuards(ClerkAuthGuard)
  async create(
    @CurrentUser('id') buyerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateOrderDto,
  ) {
    if (!idempotencyKey || !isUUID(idempotencyKey)) {
      throw new BadRequestException(
        'A valid UUID "Idempotency-Key" header is required to complete this request.',
      );
    }

    return this.ordersService.createOrder(buyerId, idempotencyKey, dto);
  }

  @Get(':id')
  @UseGuards(ClerkAuthGuard)
  async findOne(
    @CurrentUser('id') buyerId: string,
    @Param('id') orderId: string,
  ) {
    return this.ordersService.getOrder(buyerId, orderId);
  }
}
