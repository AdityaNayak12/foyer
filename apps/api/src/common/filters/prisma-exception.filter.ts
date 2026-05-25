import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientValidationError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientInitializationError,
  Prisma.PrismaClientRustPanicError,
)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'An unexpected database error occurred';
    let errorCode = 'UNKNOWN_DB_ERROR';

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      errorCode = exception.code;
      switch (exception.code) {
        case 'P2002': {
          // Unique constraint violation
          status = HttpStatus.CONFLICT;
          const targetFields = (exception.meta?.target as string[]) || [];
          message = `A record with this field configuration already exists: (${targetFields.join(', ')})`;
          break;
        }

        case 'P2025': // Record not found
          status = HttpStatus.NOT_FOUND;
          message =
            (exception.meta?.cause as string) ||
            'The requested database record was not found';
          break;

        case 'P2003': // Foreign key violation
          status = HttpStatus.BAD_REQUEST;
          message =
            'Foreign key constraint failed: the referenced model is missing or restricted';
          break;

        case 'P2000': // Value too long for column
          status = HttpStatus.BAD_REQUEST;
          message =
            'The provided value exceeds the maximum allowable length for this database field';
          break;

        default:
          message = exception.message || message;
          break;
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      errorCode = 'PRISMA_VALIDATION_ERROR';
      message =
        'Database validation error. Please verify the provided request data matches the expected database schema formats.';
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      errorCode = 'PRISMA_INIT_ERROR';
      message =
        'Database connection or initialization failure. The database service may be temporarily unavailable.';
    } else if (exception instanceof Prisma.PrismaClientUnknownRequestError) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      errorCode = 'PRISMA_UNKNOWN_ERROR';
      message = 'An unknown database request error occurred.';
    } else if (exception instanceof Prisma.PrismaClientRustPanicError) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      errorCode = 'PRISMA_ENGINE_PANIC';
      message =
        'The database engine has encountered a critical panic. Please contact administration.';
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      errorCode,
      message,
    });
  }
}
