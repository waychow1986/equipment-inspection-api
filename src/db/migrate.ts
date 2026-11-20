import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import type { Logger } from 'pino';
import type { DbConfig } from '../config.js';
import { ownerClientConfig } from './pool.js';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const LOCK_NAMESPACE = 72_034_117;
const MIGRATION_FILE_RE = /^(\d{3}_[a-z0-9_]+)\.sql$/;

export interface MigrateOptions {
  db: DbConfig;
  schema: string;
  writerRole: string;
  logger: Logger;
  retry?: { timeoutMs: number; intervalMs: number };
}

export class MigrationError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

async function connectWithRetry(options: MigrateOptions): Promise<pg.Client> {
  const { timeoutMs, intervalMs } = options.retry ?? { timeoutMs: 60_000, intervalMs: 2_000 };
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    const client = new pg.Client(ownerClientConfig(options.db));
    client.on('error', () => undefined);
    try {
      await client.connect();
      if (attempt > 0) options.logger.warn({ event: 'db_connect_recovered' }, 'database connection recovered');
      return client;
    } catch (err) {
      await client.end().catch(() => undefined);
      attempt += 1;
      if (Date.now() + intervalMs > deadline) {
        options.logger.error({ event: 'db_unreachable', err }, 'database unreachable');
        throw err;
      }
      options.logger.warn({ event: 'db_connect_retry', err }, 'database connection failed, retrying');
      await sleep(intervalMs);
    }
  }
}

async function listMigrations(): Promise<{ version: string; file: URL }[]> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((n) => MIGRATION_FILE_RE.test(n)).sort();
  return names.map((n) => ({ version: (MIGRATION_FILE_RE.exec(n) as RegExpExecArray)[1] as string, file: new URL(n, MIGRATIONS_DIR) }));
}

async function applyMigrations(client: pg.Client, schemaIdent: string, logger: Logger): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdent}`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${schemaIdent}.schema_migration (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const applied = new Set(
    (await client.query<{ version: string }>(`SELECT version FROM ${schemaIdent}.schema_migration`)).rows.map((r) => r.version),
  );
  for (const migration of await listMigrations()) {
    if (applied.has(migration.version)) continue;
    const sql = (await readFile(migration.file, 'utf8')).replaceAll('{{schema}}', schemaIdent);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(`INSERT INTO ${schemaIdent}.schema_migration (version) VALUES ($1)`, [migration.version]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error({ event: 'migration_failed', err }, 'migration failed');
      throw err;
    }
  }
}

async function ensureWriterRole(client: pg.Client, schemaIdent: string, writerRole: string, logger: Logger) {
  const role = client.escapeIdentifier(writerRole);
  try {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [writerRole]);
    if (!exists.rowCount) await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT ${role} TO CURRENT_USER`);
    await client.query(`REVOKE ALL ON ${schemaIdent}.inspection_record, ${schemaIdent}.schema_migration FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schemaIdent} TO ${role}`);
    await client.query(`GRANT SELECT, INSERT ON ${schemaIdent}.inspection_record TO ${role}`);
    const seq = await client.query<{ seq: string | null }>('SELECT pg_get_serial_sequence($1, $2) AS seq', [
      `${schemaIdent}.inspection_record`,
      'seq',
    ]);
    const sequence = seq.rows[0]?.seq;
    if (sequence) await client.query(`GRANT USAGE ON SEQUENCE ${sequence} TO ${role}`);
  } catch (err) {
    logger.error({ event: 'writer_role_unavailable', errCode: sqlState(err) }, '写入角色不可用');
    throw new MigrationError('writer role unavailable', sqlState(err));
  }
}

/** Runs forward-only migrations and the writer-role grants under an advisory lock (TD-010, TD-013). */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  const { schema, writerRole, logger } = options;
  const client = await connectWithRetry(options);
  const schemaIdent = client.escapeIdentifier(schema);
  try {
    await client.query('SELECT pg_advisory_lock($1, hashtext($2))', [LOCK_NAMESPACE, schema]);
    try {
      await applyMigrations(client, schemaIdent, logger);
      await ensureWriterRole(client, schemaIdent, writerRole, logger);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [LOCK_NAMESPACE, schema]).catch(() => undefined);
    }
    logger.info({ event: 'migration_completed' }, 'migration completed');
  } finally {
    await client.end().catch(() => undefined);
  }
}
