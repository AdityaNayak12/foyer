import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const logLevelsString = process.env.PRISMA_LOG_LEVELS;
    const logLevels = logLevelsString
      ? (logLevelsString.split(',').map((level) => level.trim()) as any[])
      : process.env.NODE_ENV === 'development'
      ? ['query', 'info', 'warn', 'error']
      : ['error', 'warn'];

    super({
      log: logLevels,
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
