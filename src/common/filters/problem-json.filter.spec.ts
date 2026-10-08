import { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ProblemJsonExceptionFilter } from './problem-json.filter';

/** What the filter would send for this exception. */
function answer(exception: unknown): { status: number; body: Record<string, unknown> } {
  const sent: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  const response = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    type() {
      return this;
    },
    json(body: Record<string, unknown>) {
      sent.body = body;
      return this;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  new ProblemJsonExceptionFilter().catch(exception, host);
  return sent;
}

const known = (code: string, message = 'boom') => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });

describe('ProblemJsonExceptionFilter — what the database refused', () => {
  it('a broken date rule is a 400 that says which', () => {
    const exception = new Prisma.PrismaClientUnknownRequestError(
      'ConnectorError(ConnectorError { kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"room_blocks\\" violates check constraint \\"room_blocks_dates_check\\"" }) })',
      { clientVersion: 'test' },
    );
    expect(answer(exception)).toEqual({ status: 400, body: expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'A block has to end on or after the day it starts' }) });
  });

  it('an unnamed check rule still gets a sentence, not a 500', () => {
    const exception = new Prisma.PrismaClientUnknownRequestError('violates check constraint "line_items_amount_check"', { clientVersion: 'test' });
    expect(answer(exception).status).toBe(400);
  });

  it('a unique clash is a 409, a vanished record a 404, a timed-out transaction a 503 to try again', () => {
    expect(answer(known('P2002'))).toEqual({ status: 409, body: expect.objectContaining({ code: 'CONFLICT' }) });
    expect(answer(known('P2025'))).toEqual({ status: 404, body: expect.objectContaining({ code: 'NOT_FOUND' }) });
    expect(answer(known('P2028'))).toEqual({ status: 503, body: expect.objectContaining({ code: 'TRY_AGAIN' }) });
  });

  it('anything else is still a 500 that leaks nothing', () => {
    const sent = answer(new Error('secret internals'));
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain('secret internals');
  });
});
