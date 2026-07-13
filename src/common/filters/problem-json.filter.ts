import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ErrorCode } from '../errors/error-codes';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  errors?: unknown;
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.NOT_IMPLEMENTED]: ErrorCode.NOT_IMPLEMENTED,
};

/**
 * Global exception filter producing RFC 9457 application/problem+json bodies
 * with stable error codes. Internals are never leaked (spec §6).
 *
 * Domain exceptions can pass `{ code: ErrorCode, message: string }` as the
 * HttpException response object to control the `code` member.
 */
@Catch()
export class ProblemJsonExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemJsonExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail: string | undefined;
    let code: string = ErrorCode.INTERNAL;
    let errors: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      code = STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL;
      if (typeof body === 'string') {
        detail = body;
      } else if (typeof body === 'object' && body !== null) {
        const rec = body as Record<string, unknown>;
        if (typeof rec.code === 'string') code = rec.code;
        if (typeof rec.message === 'string') detail = rec.message;
        else if (Array.isArray(rec.message)) {
          detail = 'Request validation failed';
          errors = rec.message;
        }
      }
    } else {
      // Unknown error: log the full detail server-side, leak nothing to the client.
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const problem: ProblemDetails = {
      type: 'about:blank',
      title: HttpStatus[status] ?? 'Error',
      status,
      code,
      ...(detail !== undefined ? { detail } : {}),
      ...(errors !== undefined ? { errors } : {}),
    };

    response.status(status).type('application/problem+json').json(problem);
  }
}
