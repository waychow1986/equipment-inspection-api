import { randomBytes } from 'node:crypto';
import pg from 'pg';

export const DB_ENV_NAMES = [
  'AIDH_DEP_INSPECTION_DB_ADDRESS',
  'AIDH_DEP_INSPECTION_DB_DATABASE',
  'AIDH_DEP_INSPECTION_DB_USERNAME',
  'AIDH_DEP_INSPECTION_DB_PASSWORD',
] as const;

/** Integration/functional tests require the real dev database; missing variables are a failure, not a skip. */
export function requireDbEnv(): Record<string, string> {
  const missing = DB_ENV_NAMES.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(`real database required; missing environment variables: ${missing.join(', ')}`);
  }
  const env: Record<string, string> = {};
  for (const name of [...DB_ENV_NAMES, 'AIDH_DEP_INSPECTION_DB_SSLMODE', 'AIDH_DEP_INSPECTION_DB_AUTH_MODE']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

export function ownerClientConfig(): pg.ClientConfig {
  const env = requireDbEnv();
  const address = env.AIDH_DEP_INSPECTION_DB_ADDRESS as string;
  const idx = address.lastIndexOf(':');
  const sslMode = env.AIDH_DEP_INSPECTION_DB_SSLMODE ?? 'disable';
  return {
    host: address.slice(0, idx),
    port: Number(address.slice(idx + 1)),
    database: env.AIDH_DEP_INSPECTION_DB_DATABASE,
    user: env.AIDH_DEP_INSPECTION_DB_USERNAME,
    password: env.AIDH_DEP_INSPECTION_DB_PASSWORD,
    ssl: sslMode === 'disable' ? false : sslMode === 'require' ? { rejectUnauthorized: false } : true,
  };
}

export function uniqueSchema(): string {
  return `inspection_t_${randomBytes(5).toString('hex')}`;
}

export async function withOwner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(ownerClientConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Drops the per-run schema and its writer role. */
export async function dropTestSchema(schema: string, writerRole: string): Promise<void> {
  await withOwner(async (client) => {
    await client.query(`DROP SCHEMA IF EXISTS ${client.escapeIdentifier(schema)} CASCADE`);
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [writerRole]);
    if (exists.rowCount) {
      await client.query(`DROP OWNED BY ${client.escapeIdentifier(writerRole)}`);
      await client.query(`DROP ROLE IF EXISTS ${client.escapeIdentifier(writerRole)}`);
    }
  });
}
