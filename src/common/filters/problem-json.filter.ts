import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SentryExceptionCaptured } from '@sentry/nestjs';
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
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.TOO_MANY_REQUESTS,
};

/**
 * Express's body parser throws plain errors, not `HttpException`s: a body
 * over the size limit, or one that isn't JSON. They carry a `type` and a 4xx
 * `status`, and used to fall through to the 500 branch below — a photo too
 * large at check-in came back as "Something went wrong".
 */
function bodyParserError(exception: unknown): { status: number; code: ErrorCode; detail: string } | null {
  if (!exception || typeof exception !== 'object') return null;
  const { type, status } = exception as { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number' || status < 400 || status >= 500) return null;
  if (type === 'entity.too.large') {
    return {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      detail: 'The request is too large. If it carried a photo, take it again closer to the document or choose a smaller image.',
    };
  }
  if (type === 'entity.parse.failed') {
    return { status: HttpStatus.BAD_REQUEST, code: ErrorCode.VALIDATION_FAILED, detail: 'The request body is not valid JSON' };
  }
  return { status, code: ErrorCode.VALIDATION_FAILED, detail: 'The request body could not be read' };
}

/** The database's own date-order rules (`*_dates_check`), in the words a person needs. */
const CHECK_CONSTRAINT_MESSAGES: Record<string, string> = {
  reservations_dates_check: 'The check-out date has to be after the check-in date',
  group_blocks_dates_check: "The block's departure has to be after its arrival",
  availability_restrictions_dates_check: 'The restriction has to end after it starts',
  rate_plans_dates_check: 'The plan ends before it starts — "valid to" has to be on or after "valid from"',
  event_bookings_times_check: 'The event has to end after it starts',
  room_blocks_dates_check: 'A block has to end on or after the day it starts',
};

/**
 * What the database refused, said in words. A unique index, a foreign key,
 * a CHECK constraint or a transaction that ran out of time used to reach the
 * client as a bare 500 "Something went wrong" — whatever the service hadn't
 * checked for itself first.
 */
function databaseError(exception: unknown): { status: number; code: ErrorCode; detail: string } | null {
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    switch (exception.code) {
      case 'P2002':
        return { status: HttpStatus.CONFLICT, code: ErrorCode.CONFLICT, detail: 'That already exists — someone may have just made the same thing. Refresh and check.' };
      case 'P2003':
        return { status: HttpStatus.CONFLICT, code: ErrorCode.CONFLICT, detail: 'That refers to something that has since been removed — refresh and try again.' };
      case 'P2025':
        return { status: HttpStatus.NOT_FOUND, code: ErrorCode.NOT_FOUND, detail: 'That record no longer exists — refresh and try again.' };
      case 'P2028':
        return { status: HttpStatus.SERVICE_UNAVAILABLE, code: ErrorCode.TRY_AGAIN, detail: 'That took too long and was stopped before anything was saved — try again in a moment.' };
    }
  }
  if (exception instanceof Prisma.PrismaClientKnownRequestError || exception instanceof Prisma.PrismaClientUnknownRequestError) {
    // Postgres 23514 — the constraint's name is in the message, quoted (and escaped in Prisma's debug form).
    const constraint = /violates check constraint \\?"([a-z0-9_]+)\\?"/.exec(exception.message)?.[1];
    if (constraint) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ErrorCode.VALIDATION_FAILED,
        detail: CHECK_CONSTRAINT_MESSAGES[constraint] ?? 'That would break one of the rules the records keep — check the dates and amounts, and try again',
      };
    }
  }
  return null;
}

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

  /** No-op when Sentry was never initialized (no `SENTRY_DSN`) — the decorator itself doesn't require an active SDK. */
  @SentryExceptionCaptured()
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail: string | undefined;
    let code: string = ErrorCode.INTERNAL;
    let errors: unknown;

    const unreadable = bodyParserError(exception);
    const refused = unreadable ? null : databaseError(exception);
    if (unreadable) {
      ({ status, code, detail } = unreadable);
    } else if (refused) {
      ({ status, code, detail } = refused);
      // Still worth a look: a service let the database be the first to say no.
      this.logger.warn(exception instanceof Error ? exception.message : String(exception));
    } else if (exception instanceof HttpException) {
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
      // The throttler's own text is a class name; say it in words.
      if (status === HttpStatus.TOO_MANY_REQUESTS && (!detail || detail.startsWith('ThrottlerException'))) {
        detail = 'Too many requests — wait a minute and try again';
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
