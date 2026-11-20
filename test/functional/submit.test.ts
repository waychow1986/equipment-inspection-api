/* eslint-disable @typescript-eslint/no-explicit-any -- black-box tests walk arbitrary JSON responses */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveWriterRole } from '../../src/config.js';
import { dropTestSchema, requireDbEnv, uniqueSchema, withOwner } from '../support/db.js';
import {
  capturedOutput,
  freePort,
  makeToken,
  runService,
  startService,
  tokenList,
  type RunningService,
} from '../support/service.js';

const schema = uniqueSchema();
const runTag = randomBytes(4).toString('hex');
const dbEnv = requireDbEnv();
const writerRole = deriveWriterRole(dbEnv.AIDH_DEP_INSPECTION_DB_DATABASE as string, schema);

const I1 = makeToken('inspector', `i1.${runTag}`);
const I2 = makeToken('inspector', `i2.${runTag}`);
const M1 = makeToken('manager', `m1.${runTag}`);
const X = makeToken('inspector', `x.${runTag}`); // never configured → invalid token

/** Every content value the tests send; IQA-019-style zero-hit search uses this list. */
const sensitive: string[] = [I1.token, I2.token, M1.token, X.token, I1.sha256, I2.sha256, M1.sha256, X.sha256];
function mark(prefix: string): string {
  const v = `${prefix}-${runTag}-${randomBytes(3).toString('hex')}`;
  sensitive.push(v);
  return v;
}
const S1 = mark('S1');

let svc: RunningService;
let serviceEnv: Record<string, string>;

function headers(token?: TestTokenLike, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (token) h.authorization = `Bearer ${token.token}`;
  return h;
}
type TestTokenLike = { token: string };

async function submit(token: TestTokenLike | undefined, body: unknown) {
  const res = await fetch(`${svc.baseUrl}/v1/inspection-records`, {
    method: 'POST',
    headers: headers(token, { 'content-type': 'application/json' }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { res, text, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

async function rowsFor(column: 'device_id' | 'store_id' | 'note', value: string) {
  return withOwner(async (c) => {
    const r = await c.query(
      `SELECT record_id, device_id, store_id, conclusion, note, inspector_id, submitted_at
         FROM ${c.escapeIdentifier(schema)}.inspection_record WHERE ${column} = $1 ORDER BY submitted_at, record_id`,
      [value],
    );
    return r.rows;
  });
}

beforeAll(async () => {
  serviceEnv = {
    ...dbEnv,
    INSPECTION_DB_SCHEMA: schema,
    PORT: String(await freePort()),
    LOG_LEVEL: 'debug',
    AIDH_SECRET_INSPECTION_ACCESS_TOKENS: tokenList([I1, I2, M1]),
  };
  svc = await startService(serviceEnv);
});

afterAll(async () => {
  if (svc) expect(await svc.stop()).toBe(0);
  await dropTestSchema(schema, writerRole);
});

describe('AC-01 巡检员提交被接受并保存为一条记录', () => {
  it('IQA-001 提交含备注的“异常”结论，返回记录且数据库中有一致的一条记录', async () => {
    const D1 = mark('D1');
    const R1 = mark('R1');
    const { res, json, text } = await submit(I1, { deviceId: D1, storeId: S1, conclusion: 'ABNORMAL', note: R1 });
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('location')).toBe(`/v1/inspection-records?deviceId=${encodeURIComponent(D1)}`);
    expect(json).toMatchObject({ deviceId: D1, storeId: S1, conclusion: 'ABNORMAL', note: R1, inspectorId: I1.holder });
    expect(json?.recordId).toMatch(/^[0-9a-f-]{36}$/);
    expect(json?.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // IQA-014: response never echoes any token
    for (const t of [I1, M1]) expect(text).not.toContain(t.token);

    const rows = await rowsFor('device_id', D1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      record_id: json?.recordId,
      device_id: D1,
      store_id: S1,
      conclusion: 'ABNORMAL',
      note: R1,
      inspector_id: I1.holder,
    });
  });

  it('IQA-002 不填备注的“正常”结论被接受，备注为空', async () => {
    const D2 = mark('D2');
    const { res, json } = await submit(I1, { deviceId: D2, storeId: S1, conclusion: 'NORMAL' });
    expect(res.status).toBe(201);
    expect(json?.note).toBeNull();
    const rows = await rowsFor('device_id', D2);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBeNull();
  });

  it('IQA-003 巡检员与提交时间由服务端决定，忽略请求中的伪造值', async () => {
    const D3 = mark('D3');
    const t0 = Date.now();
    const { res, json } = await submit(I1, {
      deviceId: D3,
      storeId: S1,
      conclusion: 'NORMAL',
      inspectorId: I2.holder,
      inspector: I2.holder,
      submittedAt: '2000-01-01T00:00:00.000Z',
      recordId: '00000000-0000-0000-0000-000000000000',
    });
    const t1 = Date.now();
    expect(res.status).toBe(201);
    expect(json?.inspectorId).toBe(I1.holder);
    expect(json?.recordId).not.toBe('00000000-0000-0000-0000-000000000000');
    const at = Date.parse(json?.submittedAt as string);
    // allow 1 s clock skew between test host and database
    expect(at).toBeGreaterThanOrEqual(t0 - 1000);
    expect(at).toBeLessThanOrEqual(t1 + 1000);
    const rows = await rowsFor('device_id', D3);
    expect(rows).toHaveLength(1);
    expect(rows[0].inspector_id).toBe(I1.holder);
    expect(new Date(rows[0].submitted_at).getUTCFullYear()).not.toBe(2000);
  });

  it('FR-009 同一内容重复提交各自生成一条新记录', async () => {
    const D5 = mark('D5');
    const body = { deviceId: D5, storeId: S1, conclusion: 'NORMAL' };
    const a = await submit(I1, body);
    const b = await submit(I1, body);
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);
    expect(a.json?.recordId).not.toBe(b.json?.recordId);
    expect(await rowsFor('device_id', D5)).toHaveLength(2);
  });
});

function expectValidationError(r: { res: Response; json?: Record<string, any> }, field: string, reason: string) {
  expect(r.res.status).toBe(400);
  expect(r.json?.error.code).toBe('VALIDATION_FAILED');
  expect(r.json?.error.message).toBe('输入不符合要求');
  expect(r.json?.error.fields).toContainEqual({ field, reason });
}

describe('AC-06 缺少必填项或结论非法的提交被拒绝且不产生记录', () => {
  it('IQA-008 缺少设备标识被拒绝并指明 deviceId，无记录产生', async () => {
    const store = mark('S-iqa008');
    const note = mark('N-iqa008');
    const r = await submit(I1, { storeId: store, conclusion: 'NORMAL', note });
    expectValidationError(r, 'deviceId', 'REQUIRED');
    expect(r.text).not.toContain(store);
    expect(r.text).not.toContain(note);
    expect(await rowsFor('store_id', store)).toHaveLength(0);
    expect(await rowsFor('note', note)).toHaveLength(0);
  });

  it('IQA-009 缺少巡检结论被拒绝并指明 conclusion，无记录产生', async () => {
    const D9 = mark('D9');
    const r = await submit(I1, { deviceId: D9, storeId: S1, note: mark('N-iqa009') });
    expectValidationError(r, 'conclusion', 'REQUIRED');
    expect(await rowsFor('device_id', D9)).toHaveLength(0);
  });

  it('IQA-010 缺少门店标识、结论为“良好”均被拒绝并分别指明字段', async () => {
    const D10 = mark('D10');
    const D11 = mark('D11');
    expectValidationError(await submit(I1, { deviceId: D10, conclusion: 'NORMAL' }), 'storeId', 'REQUIRED');
    expectValidationError(await submit(I1, { deviceId: D11, storeId: S1, conclusion: '良好' }), 'conclusion', 'INVALID_VALUE');
    expect(await rowsFor('device_id', D10)).toHaveLength(0);
    expect(await rowsFor('device_id', D11)).toHaveLength(0);
  });

  it('空白字符串、超长字段、非对象请求体、畸形 JSON 均为 400，超大请求体为 413', async () => {
    const D = mark('D-limits');
    expectValidationError(await submit(I1, { deviceId: '   ', storeId: S1, conclusion: 'NORMAL' }), 'deviceId', 'REQUIRED');
    expectValidationError(await submit(I1, { deviceId: 'd'.repeat(129), storeId: S1, conclusion: 'NORMAL' }), 'deviceId', 'TOO_LONG');
    expectValidationError(await submit(I1, { deviceId: D, storeId: S1, conclusion: 'NORMAL', note: 'n'.repeat(2001) }), 'note', 'TOO_LONG');
    expectValidationError(await submit(I1, [1, 2]), 'body', 'MALFORMED');
    const malformed = await submit(I1, '{"deviceId":');
    expect(malformed.res.status).toBe(400);
    expect(malformed.json?.error.code).toBe('VALIDATION_FAILED');
    const huge = await submit(I1, { deviceId: D, storeId: S1, conclusion: 'NORMAL', note: 'x'.repeat(70_000) });
    expect(huge.res.status).toBe(413);
    expect(await rowsFor('device_id', D)).toHaveLength(0);
  });
});

describe('身份与权限（401 → 403 → 400 次序）', () => {
  it('IQA-011 不带令牌、无效令牌提交均为 401，无记录，响应不含令牌', async () => {
    const D12 = mark('D12');
    const body = { deviceId: D12, storeId: S1, conclusion: 'NORMAL' };
    const none = await submit(undefined, body);
    const bad = await submit(X, body);
    for (const r of [none, bad]) {
      expect(r.res.status).toBe(401);
      expect(r.res.headers.get('www-authenticate')).toBe('Bearer');
      expect(r.json).toEqual({ error: { code: 'UNAUTHENTICATED', message: '未识别身份' } });
    }
    expect(bad.text).not.toContain(X.token);
    // 401 precedes body validation
    expect((await submit(X, {})).res.status).toBe(401);
    expect(await rowsFor('device_id', D12)).toHaveLength(0);
  });

  it('IQA-015 管理人员提交为 403 且无记录；403 先于输入校验', async () => {
    const D14 = mark('D14');
    const r = await submit(M1, { deviceId: D14, storeId: S1, conclusion: 'NORMAL' });
    expect(r.res.status).toBe(403);
    expect(r.json).toEqual({ error: { code: 'FORBIDDEN', message: '无权执行该操作' } });
    expect(r.text).not.toContain(M1.token);
    expect((await submit(M1, {})).res.status).toBe(403);
    expect(await rowsFor('device_id', D14)).toHaveLength(0);
  });

  it('不存在的修改/删除入口与未知路径返回统一 404', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${svc.baseUrl}/v1/inspection-records`, { method, headers: headers(I1) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '资源不存在' } });
    }
    const res = await fetch(`${svc.baseUrl}/v1/${encodeURIComponent(I1.token)}`, { headers: headers(I1) });
    expect(res.status).toBe(404);
  });
});

describe('健康检查与接口描述', () => {
  it('/healthz 无需令牌返回 200 ok', async () => {
    const res = await fetch(`${svc.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('/openapi.json 无需令牌即可获取；可据此发现提交入口与结论取值并成功提交', async () => {
    const anon = await fetch(`${svc.baseUrl}/openapi.json`);
    const authed = await fetch(`${svc.baseUrl}/openapi.json`, { headers: headers(I1) });
    expect(anon.status).toBe(200);
    expect(authed.status).toBe(200);
    const doc = (await anon.json()) as Record<string, any>;
    expect(await authed.json()).toEqual(doc);
    expect(doc.openapi).toMatch(/^3\./);

    const [path, item] = Object.entries(doc.paths as Record<string, any>).find(([, v]) => v.post) ?? [];
    expect(path).toBe('/v1/inspection-records');
    const schemaDoc = item.post.requestBody.content['application/json'].schema;
    expect(schemaDoc.required).toEqual(expect.arrayContaining(['deviceId', 'storeId', 'conclusion']));
    const conclusion = schemaDoc.properties.conclusion.enum[0] as string;

    const D = mark('D-openapi');
    const res = await fetch(`${svc.baseUrl}${path}`, {
      method: 'POST',
      headers: headers(I1, { 'content-type': 'application/json' }),
      body: JSON.stringify({ deviceId: D, storeId: S1, conclusion }),
    });
    expect(res.status).toBe(201);
    expect(await rowsFor('device_id', D)).toHaveLength(1);
  });
});

describe('配置错误', () => {
  it('令牌配置无效时启动失败（非零退出），输出不含配置内容', async () => {
    const holder = mark('bad-holder');
    const bad = JSON.stringify([{ sha256: I1.sha256, holder, role: 'inspector' }, { sha256: 'zz', holder, role: 'admin' }]);
    const { output, exited } = runService({
      ...serviceEnv,
      PORT: String(await freePort()),
      AIDH_SECRET_INSPECTION_ACCESS_TOKENS: bad,
    });
    expect(await exited).not.toBe(0);
    const out = output();
    expect(out).toContain('AIDH_SECRET_INSPECTION_ACCESS_TOKENS');
    expect(out).not.toContain(holder);
    expect(out).not.toContain(I1.sha256);
    expect(out).not.toContain(dbEnv.AIDH_DEP_INSPECTION_DB_PASSWORD as string);
  });
});

describe('AC-08 日志中不出现凭据与记录内容', () => {
  it('IQA-014 记录中的巡检员等于配置中的持有人标识，响应不含令牌', async () => {
    const D13 = mark('D13');
    const r = await submit(I1, { deviceId: D13, storeId: S1, conclusion: 'NORMAL' });
    expect(r.res.status).toBe(201);
    expect(r.json?.inspectorId).toBe(I1.holder);
    for (const t of [I1, I2, M1]) {
      expect(r.text).not.toContain(t.token);
      expect(r.text).not.toContain(t.sha256);
    }
  });

  it('服务全部输出中，令牌、摘要、持有人标识、设备/门店/备注标记、记录标识均零命中', async () => {
    // Record ids are content too: collect them all before searching.
    const ids = await withOwner(async (c) =>
      (await c.query<{ record_id: string }>(`SELECT record_id FROM ${c.escapeIdentifier(schema)}.inspection_record`)).rows.map(
        (r) => r.record_id,
      ),
    );
    expect(ids.length).toBeGreaterThan(0);
    // Stop the service first so shutdown logs are included in the search.
    expect(await svc.stop()).toBe(0);
    const all = capturedOutput.join('');
    expect(all).toContain('request completed');
    expect(all).toContain('migration completed');
    const needles = [...sensitive, ...ids, I1.holder, I2.holder, M1.holder, X.holder, dbEnv.AIDH_DEP_INSPECTION_DB_PASSWORD as string];
    const hits = needles.filter((n) => all.includes(n));
    expect(hits).toEqual([]);
  });
});
