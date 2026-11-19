import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveWriterRole, type DbConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createWriterPool } from '../../src/db/pool.js';
import { createPgRepository } from '../../src/inspections/repository.js';
import { createLogger } from '../../src/logger.js';
import { dropTestSchema, ownerClientConfig, uniqueSchema, withOwner } from '../support/db.js';

const schema = uniqueSchema();
let db: DbConfig;
let writerRole: string;
let logLines: string[];
let pool: pg.Pool;

function testLogger() {
  return createLogger({
    level: 'debug',
    destination: new Writable({
      write(chunk, _e, cb) {
        logLines.push(String(chunk));
        cb();
      },
    }),
  });
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  logLines = [];
  const cfg = ownerClientConfig();
  db = {
    host: cfg.host as string,
    port: cfg.port as number,
    database: cfg.database as string,
    user: cfg.user as string,
    password: cfg.password as string,
    sslMode: (process.env.AIDH_DEP_INSPECTION_DB_SSLMODE as DbConfig['sslMode'] | undefined) ?? 'disable',
  };
  writerRole = deriveWriterRole(db.database, schema);
  // Concurrent first-time startups must serialize on the advisory lock and all succeed.
  await Promise.all([1, 2, 3].map(() => runMigrations({ db, schema, writerRole, logger: testLogger() })));
  pool = createWriterPool({ db, writerRole, max: 2, logger: testLogger() });
});

afterAll(async () => {
  await pool?.end();
  await dropTestSchema(schema, writerRole);
});

describe('startup migration', () => {
  it('records the migration once and is idempotent on re-run', async () => {
    await runMigrations({ db, schema, writerRole, logger: testLogger() });
    const versions = await withOwner((c) =>
      c.query(`SELECT version FROM ${c.escapeIdentifier(schema)}.schema_migration ORDER BY version`),
    );
    expect(versions.rows).toEqual([{ version: '001_initial' }]);
  });

  it('creates the append-only trigger and descending device index', async () => {
    const res = await withOwner((c) =>
      c.query(
        `SELECT tgname FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace
         WHERE n.nspname = $1 AND r.relname = 'inspection_record' AND NOT t.tgisinternal ORDER BY tgname`,
        [schema],
      ),
    );
    expect(res.rows.map((r) => r.tgname)).toContain('inspection_record_immutable');
    const idx = await withOwner((c) =>
      c.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'inspection_record'`, [schema]),
    );
    expect(idx.rows.map((r) => r.indexdef).join('\n')).toMatch(/device_id, submitted_at DESC, seq DESC/);
  });

  it('logs no connection details or secrets', () => {
    const all = logLines.join('');
    expect(all).not.toContain(db.password);
    expect(all).not.toContain(db.host);
    expect(all).toContain('"msg":"migration completed"');
  });
});

describe('writer role pool', () => {
  it('runs request sessions as the derived writer role', async () => {
    const res = await pool.query('SELECT current_user AS u, current_setting($1) AS t', ['statement_timeout']);
    expect(res.rows[0]).toEqual({ u: writerRole, t: '5s' });
  });

  it('inserts a record and returns it with a millisecond UTC timestamp', async () => {
    const repo = createPgRepository(pool, schema);
    const recordId = randomUUID();
    const before = Date.now();
    const rec = await repo.insert({
      recordId,
      deviceId: 'IT-DEV-1',
      storeId: 'IT-STORE-1',
      conclusion: 'ABNORMAL',
      note: null,
      inspectorId: 'it.holder',
    });
    expect(rec).toEqual({
      recordId,
      deviceId: 'IT-DEV-1',
      storeId: 'IT-STORE-1',
      conclusion: 'ABNORMAL',
      note: null,
      inspectorId: 'it.holder',
      submittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    expect(Math.abs(Date.parse(rec.submittedAt) - before)).toBeLessThan(60_000);
  });

  it('cannot update, delete, truncate, alter, disable triggers or read migration history', async () => {
    const s = `"${schema}"`;
    const t = `${s}.inspection_record`;
    await expectSqlState(pool.query(`UPDATE ${t} SET note = 'x'`), '42501');
    await expectSqlState(pool.query(`DELETE FROM ${t}`), '42501');
    await expectSqlState(pool.query(`TRUNCATE ${t}`), '42501');
    await expectSqlState(pool.query(`ALTER TABLE ${t} ADD COLUMN x int`), '42501');
    await expectSqlState(pool.query(`ALTER TABLE ${t} DISABLE TRIGGER inspection_record_immutable`), '42501');
    await expectSqlState(pool.query(`SELECT * FROM ${s}.schema_migration`), '42501');
    await expectSqlState(pool.query(`CREATE TABLE ${s}.other (id int)`), '42501');
  });
});

describe('append-only trigger (owner)', () => {
  it('rejects UPDATE, DELETE and TRUNCATE even for the owner', async () => {
    await withOwner(async (c) => {
      const t = `${c.escapeIdentifier(schema)}.inspection_record`;
      await expectSqlState(c.query(`UPDATE ${t} SET note = 'changed'`), 'P0001');
      await expectSqlState(c.query(`DELETE FROM ${t}`), 'P0001');
      await expectSqlState(c.query(`TRUNCATE ${t}`), 'P0001');
      const count = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
      expect(count.rows[0].n).toBeGreaterThanOrEqual(1);
    });
  });

  it('enforces column constraints in the database', async () => {
    const repo = createPgRepository(pool, schema);
    const base = { deviceId: 'D', storeId: 'S', conclusion: 'NORMAL' as const, note: null, inspectorId: 'h' };
    await expectSqlState(repo.insert({ ...base, recordId: randomUUID(), conclusion: 'normal' as 'NORMAL' }), '23514');
    await expectSqlState(repo.insert({ ...base, recordId: randomUUID(), deviceId: 'd'.repeat(129) }), '23514');
    const id = randomUUID();
    await repo.insert({ ...base, recordId: id });
    await expectSqlState(repo.insert({ ...base, recordId: id }), '23505');
  });
});
