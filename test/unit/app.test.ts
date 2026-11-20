import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { parseTokenConfig } from '../../src/auth/token-config.js';
import { parseBearer } from '../../src/auth/authenticate.js';
import { createLogger } from '../../src/logger.js';
import type { InspectionRecord, InspectionRepository, NewInspectionRecord } from '../../src/inspections/repository.js';

const token = () => randomBytes(32).toString('base64url');
const digest = (t: string) => createHash('sha256').update(t).digest('hex');

describe('parseBearer', () => {
  it('extracts a bearer token', () => {
    expect(parseBearer('Bearer abc.def')).toBe('abc.def');
    expect(parseBearer('bearer   abc')).toBe('abc');
  });

  it.each([undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc', 'Bearer a b', `Bearer ${'x'.repeat(513)}`])(
    'rejects %s',
    (header) => {
      expect(parseBearer(header)).toBeUndefined();
    },
  );
});

describe('app (stub repository)', () => {
  const inspector = token();
  const manager = token();
  let inserted: NewInspectionRecord[];
  let queried: string[];
  let stored: InspectionRecord[];
  let failWith: Error | undefined;
  let healthy: boolean;
  let logs: string[];
  let app: FastifyInstance;

  beforeEach(async () => {
    inserted = [];
    queried = [];
    stored = [];
    failWith = undefined;
    healthy = true;
    logs = [];
    const repository: InspectionRepository = {
      async insert(rec) {
        if (failWith) throw failWith;
        inserted.push(rec);
        return { ...rec, submittedAt: '2026-11-19T08:30:12.345Z' };
      },
      async listByDevice(deviceId) {
        if (failWith) throw failWith;
        queried.push(deviceId);
        return stored.filter((r) => r.deviceId === deviceId);
      },
    };
    const destination = new Writable({
      write(chunk, _e, cb) {
        logs.push(String(chunk));
        cb();
      },
    });
    app = buildApp({
      tokens: parseTokenConfig(
        JSON.stringify([
          { sha256: digest(inspector), holder: 'zhang.san', role: 'inspector' },
          { sha256: digest(manager), holder: 'wang.wu', role: 'manager' },
        ]),
      ),
      repository,
      healthCheck: async () => healthy,
      logger: createLogger({ level: 'info', destination }),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const submit = (headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method: 'POST', url: '/v1/inspection-records', headers, payload: payload as string });

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  it('accepts an inspector submission and records the holder, ignoring body identity fields', async () => {
    const res = await submit(auth(inspector), {
      deviceId: ' ASSET 1/2 ',
      storeId: 'STORE-1',
      conclusion: 'ABNORMAL',
      note: '压缩机异响',
      inspectorId: 'other',
      submittedAt: '2000-01-01T00:00:00Z',
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toBe('/v1/inspection-records?deviceId=ASSET%201%2F2');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const body = res.json();
    expect(body).toEqual({
      recordId: inserted[0]?.recordId,
      deviceId: 'ASSET 1/2',
      storeId: 'STORE-1',
      conclusion: 'ABNORMAL',
      note: '压缩机异响',
      inspectorId: 'zhang.san',
      submittedAt: '2026-11-19T08:30:12.345Z',
    });
    expect(body.recordId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(res.body).not.toContain(inspector);
  });

  it('returns 401 for missing, malformed or unknown tokens, before validation', async () => {
    for (const headers of [{}, { authorization: 'Basic abc' }, auth(token()), auth(digest(inspector))]) {
      const res = await submit(headers, { deviceId: '' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: '未识别身份' } });
    }
    expect(inserted).toHaveLength(0);
  });

  it('returns 403 for a manager submitting, regardless of the body', async () => {
    for (const payload of [{ deviceId: 'D', storeId: 'S', conclusion: 'NORMAL' }, { deviceId: '' }, undefined]) {
      const res = await submit(auth(manager), payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: { code: 'FORBIDDEN', message: '无权执行该操作' } });
    }
    expect(inserted).toHaveLength(0);
  });

  it('returns 400 naming each invalid field, without echoing values', async () => {
    const res = await submit(auth(inspector), { storeId: 'STORE-X', conclusion: '良好', note: 'NOTE-MARK' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: '输入不符合要求',
        fields: [
          { field: 'deviceId', reason: 'REQUIRED' },
          { field: 'conclusion', reason: 'INVALID_VALUE' },
        ],
      },
    });
    expect(res.body).not.toContain('STORE-X');
    expect(res.body).not.toContain('NOTE-MARK');
    expect(inserted).toHaveLength(0);
  });

  it.each([
    ['invalid JSON', { 'content-type': 'application/json' }, '{"deviceId": "SECRET-ish'],
    ['non-JSON content type', { 'content-type': 'text/plain' }, 'deviceId=D'],
    ['empty JSON body', { 'content-type': 'application/json' }, ''],
    ['JSON array', { 'content-type': 'application/json' }, '[]'],
  ])('returns 400 body MALFORMED for %s', async (_name, headers, payload) => {
    const res = await submit({ ...auth(inspector), ...headers }, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: '输入不符合要求', fields: [{ field: 'body', reason: 'MALFORMED' }] },
    });
    expect(res.body).not.toContain('SECRET-ish');
  });

  it('returns 413 for bodies over 16 KiB', async () => {
    const res = await submit(auth(inspector), { deviceId: 'D', storeId: 'S', conclusion: 'NORMAL', note: 'x'.repeat(17000) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: '输入不符合要求', fields: [{ field: 'body', reason: 'TOO_LARGE' }] },
    });
  });

  it('maps database unavailability to 503 and other failures to 500, logging only name and code', async () => {
    failWith = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
    let res = await submit(auth(inspector), { deviceId: 'DEV-LOGTEST', storeId: 'S', conclusion: 'NORMAL' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' } });

    failWith = Object.assign(new Error('permission denied for table inspection_record DEV-LOGTEST'), {
      name: 'DatabaseError',
      code: '42501',
    });
    res = await submit(auth(inspector), { deviceId: 'DEV-LOGTEST', storeId: 'S', conclusion: 'NORMAL' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: '服务内部错误' } });

    const all = logs.join('');
    expect(all).toContain('"errCode":"42501"');
    expect(all).not.toContain('DEV-LOGTEST');
    expect(all).not.toContain('10.0.0.1');
    expect(all).not.toContain('permission denied');
  });

  it('returns 404 for undefined paths and methods, including modification and token management', async () => {
    for (const [method, url] of [
      ['PUT', '/v1/inspection-records'],
      ['PATCH', '/v1/inspection-records'],
      ['DELETE', '/v1/inspection-records'],
      ['DELETE', '/v1/inspection-records/6f1c2a0e-6b0a-4f4b-9a63-0f3b8e0f2c11'],
      ['POST', '/v1/tokens'],
      ['GET', '/v1/tokens'],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(inspector) });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '资源不存在' } });
    }
  });

  it('serves /healthz without identity', async () => {
    let res = await app.inject({ method: 'GET', url: '/healthz', headers: { authorization: 'Bearer nonsense' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    healthy = false;
    res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
  });

  it('writes one whitelisted access log line per request without content', async () => {
    await submit(auth(inspector), { deviceId: 'DEV-ACCESS', storeId: 'STORE-ACCESS', conclusion: 'NORMAL', note: 'NOTE-ACCESS' });
    await submit(auth(manager), { deviceId: 'DEV-ACCESS' });
    const access = logs
      .flatMap((l) => l.split('\n'))
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'access');
    expect(access).toHaveLength(2);
    expect(access[0]).toMatchObject({ level: 'info', method: 'POST', route: '/v1/inspection-records', statusCode: 201 });
    expect(access[1]).toMatchObject({ statusCode: 403, errorCode: 'FORBIDDEN' });
    for (const line of access) {
      expect(Object.keys(line).sort()).toEqual(
        expect.arrayContaining(['time', 'level', 'msg', 'event', 'requestId', 'method', 'route', 'statusCode', 'durationMs']),
      );
    }
    const all = logs.join('');
    for (const needle of ['DEV-ACCESS', 'STORE-ACCESS', 'NOTE-ACCESS', 'zhang.san', 'wang.wu', inspector, manager, digest(inspector)]) {
      expect(all).not.toContain(needle);
    }
  });

  it('ignores a client-supplied request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'DEV-INJECT' } });
    expect(res.headers['x-request-id']).not.toBe('DEV-INJECT');
    expect(logs.join('')).not.toContain('DEV-INJECT');
  });

  describe('GET /v1/inspection-records', () => {
    const query = (headers: Record<string, string>, qs = '') =>
      app.inject({ method: 'GET', url: `/v1/inspection-records${qs}`, headers });
    const rec = (deviceId: string, recordId: string, submittedAt: string): InspectionRecord => ({
      recordId,
      deviceId,
      storeId: 'STORE-1',
      conclusion: 'NORMAL',
      note: null,
      inspectorId: 'zhang.san',
      submittedAt,
    });

    it('returns the device records for a manager, using the trimmed device id', async () => {
      stored = [rec('ASSET 1/2', 'r2', '2026-11-19T09:00:00.000Z'), rec('OTHER', 'r9', '2026-11-19T09:00:00.000Z')];
      const res = await query(auth(manager), '?deviceId=%20ASSET%201%2F2%20&storeId=IGNORED');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(queried).toEqual(['ASSET 1/2']);
      expect(res.json()).toEqual({ deviceId: 'ASSET 1/2', records: [stored[0]] });
    });

    it('returns 200 with an empty list for a device without records', async () => {
      const res = await query(auth(manager), '?deviceId=NEVER');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deviceId: 'NEVER', records: [] });
    });

    it('returns 401 without or with an unknown token, before validation', async () => {
      for (const headers of [{}, auth(token())]) {
        const res = await query(headers, '');
        expect(res.statusCode).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Bearer');
        expect(res.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: '未识别身份' } });
      }
      expect(queried).toHaveLength(0);
    });

    it('returns 403 for an inspector, before validation', async () => {
      for (const qs of ['?deviceId=D', '']) {
        const res = await query(auth(inspector), qs);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: { code: 'FORBIDDEN', message: '无权执行该操作' } });
      }
      expect(queried).toHaveLength(0);
    });

    it.each([
      ['', 'REQUIRED'],
      ['?deviceId=', 'REQUIRED'],
      ['?deviceId=%20%20', 'REQUIRED'],
      ['?storeId=S', 'REQUIRED'],
      ['?deviceId=A&deviceId=B', 'MULTIPLE_VALUES'],
      [`?deviceId=${'d'.repeat(129)}`, 'TOO_LONG'],
    ])('returns 400 for query %s', async (qs, reason) => {
      const res = await query(auth(manager), qs);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: { code: 'VALIDATION_FAILED', message: '输入不符合要求', fields: [{ field: 'deviceId', reason }] },
      });
      expect(queried).toHaveLength(0);
    });

    it('maps database unavailability to 503', async () => {
      failWith = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
      const res = await query(auth(manager), '?deviceId=D');
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用' } });
    });

    it('logs the route template only, never the query string or record content', async () => {
      stored = [{ ...rec('DEV-QLOG', 'REC-QLOG', '2026-11-19T09:00:00.000Z'), storeId: 'STORE-QLOG', note: 'NOTE-QLOG' }];
      await query(auth(manager), '?deviceId=DEV-QLOG');
      await query(auth(inspector), '?deviceId=DEV-QLOG');
      const access = logs
        .flatMap((l) => l.split('\n'))
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.event === 'access');
      expect(access).toHaveLength(2);
      expect(access[0]).toMatchObject({ method: 'GET', route: '/v1/inspection-records', statusCode: 200 });
      expect(access[1]).toMatchObject({ statusCode: 403, errorCode: 'FORBIDDEN' });
      const all = logs.join('');
      for (const needle of ['DEV-QLOG', 'REC-QLOG', 'STORE-QLOG', 'NOTE-QLOG', 'deviceId=', 'zhang.san', 'wang.wu', manager]) {
        expect(all).not.toContain(needle);
      }
    });
  });
});
