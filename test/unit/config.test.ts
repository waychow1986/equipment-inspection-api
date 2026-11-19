import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, deriveWriterRole, loadConfig } from '../../src/config.js';

const tokens = JSON.stringify([
  { sha256: createHash('sha256').update('t'.repeat(40)).digest('hex'), holder: 'a', role: 'inspector' },
]);

const baseEnv = {
  AIDH_DEP_INSPECTION_DB_ADDRESS: 'db.internal:5432',
  AIDH_DEP_INSPECTION_DB_DATABASE: 'inspection',
  AIDH_DEP_INSPECTION_DB_USERNAME: 'owner',
  AIDH_DEP_INSPECTION_DB_PASSWORD: 'pw-value-123',
  AIDH_SECRET_INSPECTION_ACCESS_TOKENS: tokens,
};

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  it('reads injected dependency variables with defaults', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.db).toEqual({
      host: 'db.internal',
      port: 5432,
      database: 'inspection',
      user: 'owner',
      password: 'pw-value-123',
      sslMode: 'disable',
    });
    expect(cfg.schema).toBe('inspection');
    expect(cfg.writerRole).toBe('inspection_inspection_writer');
    expect(cfg.port).toBe(8080);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.poolMax).toBe(10);
    expect(cfg.tokens.size).toBe(1);
  });

  it('honours optional overrides', () => {
    const cfg = loadConfig({
      ...baseEnv,
      AIDH_DEP_INSPECTION_DB_SSLMODE: 'verify-full',
      AIDH_DEP_INSPECTION_DB_AUTH_MODE: 'credential',
      INSPECTION_DB_SCHEMA: 'inspection_t_abc',
      PORT: '9090',
      LOG_LEVEL: 'warn',
      DB_POOL_MAX: '3',
    });
    expect(cfg.db.sslMode).toBe('verify-full');
    expect(cfg.schema).toBe('inspection_t_abc');
    expect(cfg.writerRole).toBe('inspection_inspection_t_abc_writer');
    expect(cfg.port).toBe(9090);
    expect(cfg.logLevel).toBe('warn');
    expect(cfg.poolMax).toBe(3);
  });

  it.each([
    ['AIDH_DEP_INSPECTION_DB_ADDRESS', undefined],
    ['AIDH_DEP_INSPECTION_DB_ADDRESS', 'no-port'],
    ['AIDH_DEP_INSPECTION_DB_DATABASE', ''],
    ['AIDH_DEP_INSPECTION_DB_USERNAME', undefined],
    ['AIDH_DEP_INSPECTION_DB_PASSWORD', undefined],
    ['AIDH_DEP_INSPECTION_DB_SSLMODE', 'prefer'],
    ['AIDH_DEP_INSPECTION_DB_AUTH_MODE', 'platform-identity'],
    ['INSPECTION_DB_SCHEMA', 'Bad-Schema;drop'],
    ['PORT', '70000'],
    ['LOG_LEVEL', 'verbose'],
    ['DB_POOL_MAX', '0'],
  ])('rejects invalid %s and names only the variable', (variable, value) => {
    const e = configError({ ...baseEnv, [variable]: value });
    expect(e.variable).toBe(variable);
    expect(e.message).not.toContain('pw-value-123');
    if (value) expect(e.message).not.toContain(value);
  });

  it('reports token config problems with entry index and reason, never the value', () => {
    const e = configError({ ...baseEnv, AIDH_SECRET_INSPECTION_ACCESS_TOKENS: '[{"sha256":"zz","holder":"h","role":"inspector"}]' });
    expect(e.variable).toBe('AIDH_SECRET_INSPECTION_ACCESS_TOKENS');
    expect(e.reason).toBe('INVALID_SHA256');
    expect(e.entryIndex).toBe(0);
    expect(e.message).not.toContain('zz');
    expect(configError({ ...baseEnv, AIDH_SECRET_INSPECTION_ACCESS_TOKENS: undefined }).reason).toBe('MISSING');
  });
});

describe('deriveWriterRole', () => {
  it('lowercases and replaces unsupported characters', () => {
    expect(deriveWriterRole('Inspection-DB', 'inspection')).toBe('inspection_db_inspection_writer');
  });

  it('rejects names that would exceed the identifier limit', () => {
    expect(() => deriveWriterRole('d'.repeat(60), 'inspection')).toThrow(ConfigError);
  });
});
