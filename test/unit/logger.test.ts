import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, sanitizeLogObject } from '../../src/logger.js';

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...String(chunk).split('\n').filter(Boolean));
      cb();
    },
  });
  const logger = createLogger({ level: 'debug', destination: stream });
  return { logger, lines: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>), raw: () => lines.join('\n') };
}

describe('sanitizeLogObject', () => {
  it('keeps whitelisted fields only', () => {
    expect(
      sanitizeLogObject({
        event: 'access',
        requestId: 'r',
        method: 'POST',
        route: '/v1/inspection-records',
        statusCode: 201,
        durationMs: 3.2,
        errorCode: 'X',
        deviceId: 'ASSET-1',
        url: '/v1/inspection-records?deviceId=ASSET-1',
        headers: { authorization: 'Bearer abc' },
        body: { note: 'n' },
      }),
    ).toEqual({
      event: 'access',
      requestId: 'r',
      method: 'POST',
      route: '/v1/inspection-records',
      statusCode: 201,
      durationMs: 3.2,
      errorCode: 'X',
    });
  });

  it('reduces errors to name and code only', () => {
    const err = Object.assign(new Error('Key (device_id)=(ASSET-9) secret detail'), {
      name: 'DatabaseError',
      code: '23505',
      detail: 'Failing row contains (ASSET-9, STORE-9)',
    });
    expect(sanitizeLogObject({ err })).toEqual({ errName: 'DatabaseError', errCode: '23505' });
    expect(sanitizeLogObject({ error: new SyntaxError('Unexpected token s in {"secret"') })).toEqual({
      errName: 'SyntaxError',
    });
  });
});

describe('createLogger', () => {
  it('writes JSON lines with a text level label and no content fields', () => {
    const { logger, lines, raw } = captureLogger();
    const err = Object.assign(new Error('row (ASSET-7) note 压缩机'), { code: '57P01', detail: 'ASSET-7' });
    logger.error({ event: 'db_error', err, deviceId: 'ASSET-7', authorization: 'Bearer tok' }, 'database error');
    logger.child({ reqId: 'abc', holder: 'zhang.san' }).info({ password: 'pw' }, 'child');
    const [first, second] = lines();
    expect(first).toMatchObject({ level: 'error', msg: 'database error', event: 'db_error', errName: 'Error', errCode: '57P01' });
    expect(typeof first?.time).toBe('string');
    expect(second).toMatchObject({ level: 'info', msg: 'child' });
    for (const needle of ['ASSET-7', '压缩机', 'Bearer', 'tok', 'zhang.san', 'pw', 'stack', 'detail']) {
      expect(raw()).not.toContain(needle);
    }
  });
});
