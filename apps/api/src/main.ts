import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS for frontend API calls
  app.enableCors({
    origin: process.env.FRONTEND_URL || '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Register Global Database Exception Filter
  app.useGlobalFilters(new PrismaExceptionFilter());

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  console.log(`🚀 Foyer API Monolith successfully running on http://localhost:${port}`);
}
bootstrap();
