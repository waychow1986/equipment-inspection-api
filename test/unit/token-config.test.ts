import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseTokenConfig, TokenConfigError } from '../../src/auth/token-config.js';

const token = () => randomBytes(32).toString('base64url');
const digest = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

function expectConfigError(raw: string | undefined, reason: string, entryIndex?: number): TokenConfigError {
  try {
    parseTokenConfig(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(TokenConfigError);
    const e = err as TokenConfigError;
    expect(e.reason).toBe(reason);
    expect(e.entryIndex).toBe(entryIndex);
    if (raw) {
      expect(e.message).not.toContain(raw);
      expect(JSON.stringify(e)).not.toContain(raw);
    }
    return e;
  }
  throw new Error('expected TokenConfigError');
}

describe('parseTokenConfig', () => {
  it('builds a lookup table keyed by SHA-256 digest of the token', () => {
    const inspector = token();
    const manager = token();
    const table = parseTokenConfig(
      JSON.stringify([
        { sha256: digest(inspector), holder: ' zhang.san ', role: 'inspector' },
        { sha256: digest(manager), holder: 'wang.wu', role: 'manager' },
      ]),
    );
    expect(table.size).toBe(2);
    expect(table.lookup(inspector)).toEqual({ holder: 'zhang.san', role: 'inspector' });
    expect(table.lookup(manager)).toEqual({ holder: 'wang.wu', role: 'manager' });
    expect(table.lookup(token())).toBeUndefined();
    expect(table.lookup(digest(inspector))).toBeUndefined();
  });

  it('accepts an empty list', () => {
    expect(parseTokenConfig('[]').size).toBe(0);
  });

  it('allows the same holder to have several tokens', () => {
    const a = token();
    const b = token();
    const table = parseTokenConfig(
      JSON.stringify([
        { sha256: digest(a), holder: 'li.si', role: 'inspector' },
        { sha256: digest(b), holder: 'li.si', role: 'manager' },
      ]),
    );
    expect(table.lookup(a)?.role).toBe('inspector');
    expect(table.lookup(b)?.role).toBe('manager');
  });

  it('rejects a missing or blank value', () => {
    expectConfigError(undefined, 'MISSING');
    expectConfigError('   ', 'MISSING');
  });

  it('rejects invalid JSON without echoing the value or parser message', () => {
    const secretish = `{"sha256": "${token()}"`;
    const e = expectConfigError(secretish, 'INVALID_JSON');
    expect(e.cause).toBeUndefined();
  });

  it('rejects non-array JSON', () => {
    expectConfigError('{"a":1}', 'NOT_ARRAY');
  });

  it('rejects entries that are not objects', () => {
    expectConfigError(JSON.stringify(['abc']), 'INVALID_ENTRY', 0);
  });

  it('rejects malformed digests', () => {
    const t = token();
    expectConfigError(JSON.stringify([{ sha256: t, holder: 'a', role: 'inspector' }]), 'INVALID_SHA256', 0);
    expectConfigError(
      JSON.stringify([{ sha256: digest(t).toUpperCase(), holder: 'a', role: 'inspector' }]),
      'INVALID_SHA256',
      0,
    );
  });

  it('rejects duplicate digests', () => {
    const t = token();
    expectConfigError(
      JSON.stringify([
        { sha256: digest(t), holder: 'a', role: 'inspector' },
        { sha256: digest(t), holder: 'b', role: 'manager' },
      ]),
      'DUPLICATE_SHA256',
      1,
    );
  });

  it('rejects unknown keys such as a plaintext token', () => {
    const t = token();
    expectConfigError(
      JSON.stringify([{ sha256: digest(t), holder: 'a', role: 'inspector', token: t }]),
      'UNKNOWN_KEY',
      0,
    );
  });

  it('rejects invalid roles and holders', () => {
    const t = token();
    expectConfigError(JSON.stringify([{ sha256: digest(t), holder: 'a', role: 'admin' }]), 'INVALID_ROLE', 0);
    expectConfigError(JSON.stringify([{ sha256: digest(t), holder: '  ', role: 'manager' }]), 'INVALID_HOLDER', 0);
    expectConfigError(JSON.stringify([{ sha256: digest(t), role: 'manager' }]), 'INVALID_HOLDER', 0);
    expectConfigError(
      JSON.stringify([{ sha256: digest(t), holder: 'a\nb', role: 'manager' }]),
      'INVALID_HOLDER',
      0,
    );
    expectConfigError(
      JSON.stringify([{ sha256: digest(t), holder: 'x'.repeat(129), role: 'manager' }]),
      'INVALID_HOLDER',
      0,
    );
  });
});
