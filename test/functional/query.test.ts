/* eslint-disable @typescript-eslint/no-explicit-any -- black-box tests walk arbitrary JSON responses */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveWriterRole } from '../../src/config.js';
import { dropTestSchema, requireDbEnv, uniqueSchema, withOwner } from '../support/db.js';
import { capturedOutput, freePort, makeToken, startService, tokenList, type RunningService } from '../support/service.js';

const schema = uniqueSchema();
const runTag = randomBytes(4).toString('hex');
const dbEnv = requireDbEnv();
const writerRole = deriveWriterRole(dbEnv.AIDH_DEP_INSPECTION_DB_DATABASE as string, schema);

const I1 = makeToken('inspector', `i1.${runTag}`);
const I2 = makeToken('inspector', `i2.${runTag}`);
const M1 = makeToken('manager', `m1.${runTag}`);
const X = makeToken('inspector', `x.${runTag}`); // never configured → invalid token
const I3 = makeToken('inspector', `i3.${runTag}`); // added later (FR-028)

/** Every content value the tests send; the IQA-019 zero-hit search uses this list. */
const sensitive: string[] = [
  ...[I1, I2, M1, X, I3].flatMap((t) => [t.token, t.sha256, t.holder]),
];
function mark(prefix: string): string {
  const v = `${prefix}-${runTag}-${randomBytes(3).toString('hex')}`;
  sensitive.push(v);
  return v;
}

const S1 = mark('S1');
const S2 = mark('S2');
const DEVICE_KEYS = [
  'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'D17',
] as const;
type DeviceKey = (typeof DEVICE_KEYS)[number];
const D = Object.fromEntries(DEVICE_KEYS.map((k) => [k, mark(k)])) as Record<DeviceKey, string>;
const RESTART_KEYS: DeviceKey[] = ['D1', 'D2', 'D3', 'D4', 'D5'];
const R1 = mark('R1');

type Tok = { token: string };
let svc: RunningService;
let serviceEnv: Record<string, string>;
/** Responses of the first query of D1～D5 after IQA-001～005, compared after restart (IQA-018). */
const beforeRestart: Record<string, unknown> = {};

function headers(token?: Tok, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (token) h.authorization = `Bearer ${token.token}`;
  return h;
}

async function call(method: 'GET' | 'POST', url: string, token?: Tok, body?: unknown) {
  const res = await fetch(`${svc.baseUrl}${url}`, {
    method,
    headers: headers(token, body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { res, text, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

const submit = (token: Tok | undefined, body: unknown) => call('POST', '/v1/inspection-records', token, body);
const queryRaw = (token: Tok | undefined, qs: string) => call('GET', `/v1/inspection-records${qs}`, token);
const query = (token: Tok | undefined, deviceId: string) => queryRaw(token, `?deviceId=${encodeURIComponent(deviceId)}`);

/** M1 query that must succeed; returns the records list. */
async function records(deviceId: string): Promise<Record<string, any>[]> {
  const r = await query(M1, deviceId);
  expect(r.res.status).toBe(200);
  expect(r.res.headers.get('content-type')).toMatch(/^application\/json/);
  expect(r.json?.deviceId).toBe(deviceId);
  for (const t of [I1, I2, M1, X, I3]) expect(r.text).not.toContain(t.token);
  return r.json?.records as Record<string, any>[];
}

async function accepted(token: Tok, body: Record<string, unknown>): Promise<Record<string, any>> {
  const r = await submit(token, body);
  expect(r.res.status).toBe(201);
  return r.json as Record<string, any>;
}

const RECORD_KEYS = ['conclusion', 'deviceId', 'inspectorId', 'note', 'recordId', 'storeId', 'submittedAt'];

function restartWith(tokens: string): Promise<RunningService> {
  serviceEnv = { ...serviceEnv, AIDH_SECRET_INSPECTION_ACCESS_TOKENS: tokens };
  return startService(serviceEnv);
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
  if (svc) await svc.stop();
  await dropTestSchema(schema, writerRole);
});

describe('AC-01/AC-02 提交后管理人员按设备查询可见完整记录', () => {
  it('IQA-001 M1 查询 D1 得到 1 条与提交返回一致的记录', async () => {
    const created = await accepted(I1, { deviceId: D.D1, storeId: S1, conclusion: 'ABNORMAL', note: R1 });
    const list = await records(D.D1);
    expect(list).toEqual([created]);
    expect(list[0]).toMatchObject({ deviceId: D.D1, storeId: S1, conclusion: 'ABNORMAL', note: R1, inspectorId: I1.holder });
  });

  it('IQA-002 未填备注的记录查询结果中备注为 null', async () => {
    await accepted(I1, { deviceId: D.D2, storeId: S1, conclusion: 'NORMAL' });
    const list = await records(D.D2);
    expect(list).toHaveLength(1);
    expect(list[0]?.note).toBeNull();
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(RECORD_KEYS);
  });

  it('IQA-003 查询结果中巡检员为提交者、提交时间由服务端决定', async () => {
    const t0 = Date.now();
    await accepted(I1, {
      deviceId: D.D3,
      storeId: S1,
      conclusion: 'NORMAL',
      inspectorId: I2.holder,
      submittedAt: '2000-01-01T00:00:00.000Z',
    });
    const t1 = Date.now();
    const list = await records(D.D3);
    expect(list).toHaveLength(1);
    expect(list[0]?.inspectorId).toBe(I1.holder);
    const at = Date.parse(list[0]?.submittedAt as string);
    // allow 1 s clock skew between test host and database
    expect(at).toBeGreaterThanOrEqual(t0 - 1000);
    expect(at).toBeLessThanOrEqual(t1 + 1000);
  });

  it('IQA-004 两名巡检员先后提交，查询返回 2 条完整记录，从新到旧', async () => {
    const a = await accepted(I1, { deviceId: D.D4, storeId: S1, conclusion: 'NORMAL' });
    const b = await accepted(I2, { deviceId: D.D4, storeId: S1, conclusion: 'ABNORMAL' });
    const list = await records(D.D4);
    expect(list).toEqual([b, a]);
    for (const rec of list) expect(Object.keys(rec).sort()).toEqual(RECORD_KEYS);
    expect(list[0]).toMatchObject({ inspectorId: I2.holder, conclusion: 'ABNORMAL' });
    expect(list[1]).toMatchObject({ inspectorId: I1.holder, conclusion: 'NORMAL' });
  });
});

describe('AC-03 重复提交追加新记录，已有记录不被改变', () => {
  it('IQA-005 三次提交（后两次相同）得到 3 条不同标识的记录，第一条保持不变', async () => {
    await accepted(I1, { deviceId: D.D5, storeId: S1, conclusion: 'ABNORMAL', note: mark('N-iqa005') });
    const firstQuery = await records(D.D5);
    expect(firstQuery).toHaveLength(1);
    const same = { deviceId: D.D5, storeId: S1, conclusion: 'NORMAL' };
    await accepted(I1, same);
    await accepted(I1, same);
    const finalQuery = await records(D.D5);
    expect(finalQuery).toHaveLength(3);
    expect(new Set(finalQuery.map((r) => r.recordId)).size).toBe(3);
    expect(finalQuery[2]).toEqual(firstQuery[0]);
  });
});

describe('AC-04/AC-05 只按设备标识查询', () => {
  it('IQA-006 只提供设备标识即可查询，结果只含该设备的全部记录', async () => {
    const d6 = [
      await accepted(I1, { deviceId: D.D6, storeId: S1, conclusion: 'NORMAL' }),
      await accepted(I2, { deviceId: D.D6, storeId: S2, conclusion: 'ABNORMAL' }),
    ];
    const d7 = await accepted(I1, { deviceId: D.D7, storeId: S1, conclusion: 'NORMAL' });
    const list = await records(D.D6);
    expect(list).toEqual([...d6].reverse());
    expect(list.every((r) => r.deviceId === D.D6)).toBe(true);
    expect(list.map((r) => r.recordId)).not.toContain(d7.recordId);
  });

  it('IQA-007 从未提交过的设备查询成功，记录列表为空', async () => {
    const r = await query(M1, D.D8);
    expect(r.res.status).toBe(200);
    expect(r.json).toEqual({ deviceId: D.D8, records: [] });
  });

  it('IQA-016 不同门店的设备都能查询并各自返回记录', async () => {
    const a = await records(D.D1);
    const b = [await accepted(I1, { deviceId: D.D15, storeId: S2, conclusion: 'NORMAL' })];
    expect(a).toHaveLength(1);
    expect(a[0]?.storeId).toBe(S1);
    expect(await records(D.D15)).toEqual(b);
  });

  it('IQA-009/010/011/015 被拒绝的提交在查询中不可见（空列表）', async () => {
    expect((await submit(I1, { deviceId: D.D9, storeId: S1, note: mark('N-iqa009') })).res.status).toBe(400);
    expect((await submit(I1, { deviceId: D.D10, conclusion: 'NORMAL' })).res.status).toBe(400);
    expect((await submit(I1, { deviceId: D.D11, storeId: S1, conclusion: '良好' })).res.status).toBe(400);
    expect((await submit(undefined, { deviceId: D.D12, storeId: S1, conclusion: 'NORMAL' })).res.status).toBe(401);
    expect((await submit(X, { deviceId: D.D12, storeId: S1, conclusion: 'NORMAL' })).res.status).toBe(401);
    expect((await submit(M1, { deviceId: D.D14, storeId: S1, conclusion: 'NORMAL' })).res.status).toBe(403);
    for (const d of [D.D9, D.D10, D.D11, D.D12, D.D14]) expect(await records(d as string)).toEqual([]);
  });

  it('IQA-017 未指定设备、空白设备或重复设备参数的查询被拒绝并指明 deviceId', async () => {
    for (const [qs, reason] of [
      ['', 'REQUIRED'],
      [`?storeId=${encodeURIComponent(S1)}`, 'REQUIRED'],
      ['?deviceId=', 'REQUIRED'],
      ['?deviceId=%20%20', 'REQUIRED'],
      [`?deviceId=${encodeURIComponent(D.D1 as string)}&deviceId=${encodeURIComponent(D.D2 as string)}`, 'MULTIPLE_VALUES'],
      [`?deviceId=${'d'.repeat(129)}`, 'TOO_LONG'],
    ] as const) {
      const r = await queryRaw(M1, qs);
      expect(r.res.status).toBe(400);
      expect(r.json).toEqual({
        error: { code: 'VALIDATION_FAILED', message: '输入不符合要求', fields: [{ field: 'deviceId', reason }] },
      });
      expect(r.text).not.toContain('records');
      expect(r.text).not.toContain(S1);
      expect(r.text).not.toContain(D.D1);
    }
  });
});

describe('查询的身份与权限', () => {
  it('IQA-012 不带令牌、无效令牌查询均为 401，不含记录与令牌', async () => {
    for (const token of [undefined, X]) {
      const r = await query(token, D.D1 as string);
      expect(r.res.status).toBe(401);
      expect(r.res.headers.get('www-authenticate')).toBe('Bearer');
      expect(r.json).toEqual({ error: { code: 'UNAUTHENTICATED', message: '未识别身份' } });
      expect(r.text).not.toContain(X.token);
      expect(r.text).not.toContain(D.D1);
    }
    // 401 precedes input validation
    expect((await queryRaw(X, '')).res.status).toBe(401);
  });

  it('IQA-013 巡检员查询为 403，不含记录；403 先于输入校验', async () => {
    const r = await query(I1, D.D1 as string);
    expect(r.res.status).toBe(403);
    expect(r.json).toEqual({ error: { code: 'FORBIDDEN', message: '无权执行该操作' } });
    expect(r.text).not.toContain(D.D1);
    expect(r.text).not.toContain(I1.token);
    expect((await queryRaw(I1, '')).res.status).toBe(403);
  });

  it('IQA-014 查询结果中的巡检员等于配置的持有人标识，提交与查询响应都不含令牌', async () => {
    const s = await submit(I1, { deviceId: D.D13, storeId: S1, conclusion: 'NORMAL' });
    expect(s.res.status).toBe(201);
    const q = await query(M1, D.D13 as string);
    expect(q.res.status).toBe(200);
    expect(q.json?.records).toHaveLength(1);
    expect(q.json?.records[0].inspectorId).toBe(I1.holder);
    for (const text of [s.text, q.text]) {
      for (const t of [I1, M1]) {
        expect(text).not.toContain(t.token);
        expect(text).not.toContain(t.sha256);
      }
    }
  });
});

describe('接口描述可发现查询入口', () => {
  it('依据 /openapi.json 中带查询参数的 GET 操作即可完成查询', async () => {
    const doc = (await (await fetch(`${svc.baseUrl}/openapi.json`)).json()) as Record<string, any>;
    const found = Object.entries(doc.paths as Record<string, any>).find(([, v]) =>
      (v.get?.parameters ?? []).some((p: any) => p.in === 'query' && /device/i.test(p.name) && p.required),
    );
    expect(found).toBeDefined();
    const [path, item] = found as [string, any];
    expect(path).toBe('/v1/inspection-records');
    expect(item.get.summary).toContain('list inspection records by device');
    const param = item.get.parameters.find((p: any) => p.in === 'query').name as string;
    const r = await call('GET', `${path}?${param}=${encodeURIComponent(D.D4 as string)}`, M1);
    expect(r.res.status).toBe(200);
    expect(r.json?.records).toHaveLength(2);
  });
});

describe('AC-07 服务重启后历史记录完全一致', () => {
  it('IQA-018 重启前后 D1～D5 的查询结果（条数、标识与全部字段）完全一致', async () => {
    for (const k of RESTART_KEYS) {
      const r = await query(M1, D[k]);
      expect(r.res.status).toBe(200);
      beforeRestart[k] = r.json;
    }
    expect(await svc.stop()).toBe(0);
    svc = await restartWith(serviceEnv.AIDH_SECRET_INSPECTION_ACCESS_TOKENS as string);
    for (const k of RESTART_KEYS) {
      const r = await query(M1, D[k]);
      expect(r.res.status).toBe(200);
      expect(r.json).toEqual(beforeRestart[k]);
    }
    expect((beforeRestart.D5 as any).records).toHaveLength(3);
  });
});

describe('令牌收回与新增（重新加载后生效）', () => {
  it('IQA-021 收回 I2 后其提交与查询均为 401，I1 正常，I2 已有记录保持不变', async () => {
    const i2rec = await accepted(I2, { deviceId: D.D16, storeId: S1, conclusion: 'ABNORMAL' });
    const saved = await query(M1, D.D16 as string);
    expect(saved.json?.records).toEqual([i2rec]);

    // 运维从机密配置删除 I2 并让服务重新加载（重启进程读取新的配置）
    expect(await svc.stop()).toBe(0);
    svc = await restartWith(tokenList([I1, M1]));

    const i2Submit = await submit(I2, { deviceId: D.D17, storeId: S1, conclusion: 'NORMAL' });
    const i2Query = await query(I2, D.D16 as string);
    for (const r of [i2Submit, i2Query]) {
      expect(r.res.status).toBe(401);
      expect(r.json).toEqual({ error: { code: 'UNAUTHENTICATED', message: '未识别身份' } });
      // IQA-020: the failure never echoes the presented token
      expect(r.text).not.toContain(I2.token);
    }
    const i1rec = await accepted(I1, { deviceId: D.D17, storeId: S1, conclusion: 'NORMAL' });
    const after = await query(M1, D.D16 as string);
    expect(after.json).toEqual(saved.json);
    expect(await records(D.D17 as string)).toEqual([i1rec]);
  });

  it('FR-028 新增令牌并重新加载后即被识别', async () => {
    expect((await submit(I3, { deviceId: D.D17, storeId: S1, conclusion: 'NORMAL' })).res.status).toBe(401);
    expect(await svc.stop()).toBe(0);
    svc = await restartWith(tokenList([I1, M1, I3]));
    const rec = await accepted(I3, { deviceId: D.D17, storeId: S2, conclusion: 'ABNORMAL' });
    expect(rec.inspectorId).toBe(I3.holder);
    const list = await records(D.D17 as string);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(rec);
  });
});

describe('AC-08 全部日志零命中（IQA-019）', () => {
  it('服务全部输出（含多次重启与重新加载）中，令牌、摘要、持有人、设备/门店/备注标记、记录标识均零命中', async () => {
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
    expect(all.match(/service started/g)?.length).toBeGreaterThanOrEqual(4);
    const needles = [...sensitive, ...ids, dbEnv.AIDH_DEP_INSPECTION_DB_PASSWORD as string];
    expect(needles.filter((n) => all.includes(n))).toEqual([]);
    // the query string (where deviceId travels) is never logged
    expect(all).not.toContain('deviceId=');
  });
});
