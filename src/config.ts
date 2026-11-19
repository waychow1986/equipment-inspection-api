import { parseTokenConfig, TokenConfigError, type TokenTable } from './auth/token-config.js';

export type SslMode = 'disable' | 'require' | 'verify-full';

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: SslMode;
}

export interface AppConfig {
  db: DbConfig;
  schema: string;
  writerRole: string;
  port: number;
  logLevel: string;
  poolMax: number;
  tokens: TokenTable;
}

/** Names only the offending variable (and token entry index/reason); never its value. */
export class ConfigError extends Error {
  readonly variable: string;
  readonly entryIndex: number | undefined;
  readonly reason: string | undefined;

  constructor(variable: string, reason?: string, entryIndex?: number) {
    super(`configuration invalid: ${variable}${reason ? ` (${reason})` : ''}`);
    this.name = 'ConfigError';
    this.variable = variable;
    this.reason = reason;
    this.entryIndex = entryIndex;
  }
}

export const ENV = {
  address: 'AIDH_DEP_INSPECTION_DB_ADDRESS',
  database: 'AIDH_DEP_INSPECTION_DB_DATABASE',
  username: 'AIDH_DEP_INSPECTION_DB_USERNAME',
  password: 'AIDH_DEP_INSPECTION_DB_PASSWORD',
  sslMode: 'AIDH_DEP_INSPECTION_DB_SSLMODE',
  authMode: 'AIDH_DEP_INSPECTION_DB_AUTH_MODE',
  tokens: 'AIDH_SECRET_INSPECTION_ACCESS_TOKENS',
  schema: 'INSPECTION_DB_SCHEMA',
  port: 'PORT',
  logLevel: 'LOG_LEVEL',
  poolMax: 'DB_POOL_MAX',
} as const;

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const SSL_MODES = new Set<SslMode>(['disable', 'require', 'verify-full']);

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new ConfigError(name, 'MISSING');
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(name, 'INVALID');
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(name, 'INVALID');
  return n;
}

export function deriveWriterRole(database: string, schema: string): string {
  const role = `${database}_${schema}_writer`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!IDENTIFIER_RE.test(role)) throw new ConfigError(ENV.database, 'WRITER_ROLE_NAME_INVALID');
  return role;
}

export function loadConfig(env: Env): AppConfig {
  const address = required(env, ENV.address).trim();
  const match = /^(.+):(\d{1,5})$/.exec(address);
  if (!match) throw new ConfigError(ENV.address, 'INVALID');
  const dbPort = Number(match[2]);
  if (dbPort < 1 || dbPort > 65535) throw new ConfigError(ENV.address, 'INVALID');
  const host = (match[1] as string).replace(/^\[(.*)\]$/, '$1');

  const database = required(env, ENV.database).trim();
  const user = required(env, ENV.username).trim();
  const password = required(env, ENV.password);

  const sslMode = (optional(env, ENV.sslMode) ?? 'disable') as SslMode;
  if (!SSL_MODES.has(sslMode)) throw new ConfigError(ENV.sslMode, 'UNSUPPORTED');
  const authMode = optional(env, ENV.authMode) ?? 'credential';
  if (authMode !== 'credential') throw new ConfigError(ENV.authMode, 'UNSUPPORTED');

  const schema = optional(env, ENV.schema) ?? 'inspection';
  if (!IDENTIFIER_RE.test(schema)) throw new ConfigError(ENV.schema, 'INVALID');

  const port = integer(env, ENV.port, 8080, 1, 65535);
  const logLevel = optional(env, ENV.logLevel) ?? 'info';
  if (!LOG_LEVELS.has(logLevel)) throw new ConfigError(ENV.logLevel, 'INVALID');
  const poolMax = integer(env, ENV.poolMax, 10, 1, 100);

  let tokens: TokenTable;
  try {
    tokens = parseTokenConfig(env[ENV.tokens]);
  } catch (err) {
    if (err instanceof TokenConfigError) throw new ConfigError(ENV.tokens, err.reason, err.entryIndex);
    throw new ConfigError(ENV.tokens, 'INVALID');
  }

  return {
    db: { host, port: dbPort, database, user, password, sslMode },
    schema,
    writerRole: deriveWriterRole(database, schema),
    port,
    logLevel,
    poolMax,
    tokens,
  };
}
