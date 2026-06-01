import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { UserRole } from '@prisma/client';

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private client: jwksClient.JwksClient;

  constructor() {
    const jwksUri = process.env.CLERK_JWKS_URI;
    if (!jwksUri) {
      throw new Error('CLERK_JWKS_URI env variable is not configured');
    }

    this.client = jwksClient({
      jwksUri,
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Authorization header is missing');
    }

    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization scheme (must be Bearer)');
    }

    try {
      const decodedToken = await this.verifyToken(token);
      request.user = {
        id: decodedToken.sub,
        email: decodedToken.email || decodedToken.emails?.[0],
        role: decodedToken.metadata?.role || UserRole.BUYER,
      };
      return true;
    } catch (err) {
      throw new UnauthorizedException(
        `Token verification failed: ${err instanceof Error ? err.message : 'Invalid signature'}`,
      );
    }
  }

  private verifyToken(token: string): Promise<any> {
    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        (header, callback) => {
          this.client.getSigningKey(header.kid, (err, key) => {
            if (err) {
              callback(err);
            } else {
              const signingKey = key?.getPublicKey();
              callback(null, signingKey);
            }
          });
        },
        { algorithms: ['RS256'] },
        (err, decoded) => {
          if (err) {
            reject(err);
          } else {
            resolve(decoded);
          }
        },
      );
    });
  }
}
