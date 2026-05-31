import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import '@nestjs/platform-express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  const frontendUrl = configService.get<string>('FRONTEND_URL');
  const nodeEnv = configService.get<string>('NODE_ENV') || 'development';

  if (!frontendUrl && nodeEnv === 'production') {
    throw new Error(
      'FRONTEND_URL environment variable is mandatory in production mode to configure secure CORS.',
    );
  }

  // Parse comma-separated origins if provided, otherwise default to wildcard for local development only
  const allowedOrigins = frontendUrl
    ? frontendUrl.split(',').map((url) => url.trim())
    : '*';

  // Enable CORS for frontend API calls
  app.enableCors({
    origin: allowedOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Register Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Register Global Database Exception Filter
  app.useGlobalFilters(new PrismaExceptionFilter());

  const port = configService.get<number>('PORT') ?? 4000;
  await app.listen(port);
  console.log(
    `Foyer API Monolith successfully running on http://localhost:${port}`,
  );
}

bootstrap().catch((err) => {
  console.error('Failed to start Foyer API Monolith:', err);
});
