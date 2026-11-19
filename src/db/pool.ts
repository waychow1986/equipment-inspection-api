import pg from 'pg';
import type { Logger } from 'pino';
import type { DbConfig } from '../config.js';

export const STATEMENT_TIMEOUT_MS = 5000;
export const CONNECT_TIMEOUT_MS = 5000;

export function sslOption(mode: DbConfig['sslMode']): pg.ClientConfig['ssl'] {
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

export function ownerClientConfig(db: DbConfig): pg.ClientConfig {
  return {
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    password: db.password,
    ssl: sslOption(db.sslMode),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  };
}

/**
 * Request pool: every session switches to the writer role at connect time (TD-013),
 * so request SQL only has SELECT/INSERT on the record table.
 */
export function createWriterPool(options: { db: DbConfig; writerRole: string; max: number; logger: Logger }): pg.Pool {
  const pool = new pg.Pool({
    ...ownerClientConfig(options.db),
    max: options.max,
    idleTimeoutMillis: 30_000,
    options: `-c role=${options.writerRole} -c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
  });
  pool.on('error', (err) => {
    options.logger.error({ event: 'db_pool_error', err }, 'database connection error');
  });
  return pool;
}
