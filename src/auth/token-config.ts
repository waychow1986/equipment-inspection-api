import { createHash } from 'node:crypto';

export type Role = 'inspector' | 'manager';

export interface Principal {
  holder: string;
  role: Role;
}

export type TokenConfigReason =
  | 'MISSING'
  | 'INVALID_JSON'
  | 'NOT_ARRAY'
  | 'INVALID_ENTRY'
  | 'UNKNOWN_KEY'
  | 'INVALID_SHA256'
  | 'DUPLICATE_SHA256'
  | 'INVALID_HOLDER'
  | 'INVALID_ROLE';

/** Never carries the raw configuration value or a parser cause. */
export class TokenConfigError extends Error {
  readonly reason: TokenConfigReason;
  readonly entryIndex: number | undefined;

  constructor(reason: TokenConfigReason, entryIndex?: number) {
    super(entryIndex === undefined ? `token config invalid: ${reason}` : `token config invalid: ${reason} at entry ${entryIndex}`);
    this.name = 'TokenConfigError';
    this.reason = reason;
    this.entryIndex = entryIndex;
  }
}

export interface TokenTable {
  readonly size: number;
  lookup(token: string): Principal | undefined;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const ALLOWED_KEYS = new Set(['sha256', 'holder', 'role']);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function parseTokenConfig(raw: string | undefined): TokenTable {
  if (raw === undefined || raw.trim() === '') throw new TokenConfigError('MISSING');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TokenConfigError('INVALID_JSON');
  }
  if (!Array.isArray(parsed)) throw new TokenConfigError('NOT_ARRAY');

  const byDigest = new Map<string, Principal>();
  parsed.forEach((entry: unknown, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TokenConfigError('INVALID_ENTRY', index);
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((k) => !ALLOWED_KEYS.has(k))) throw new TokenConfigError('UNKNOWN_KEY', index);
    const { sha256, holder, role } = record;
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) throw new TokenConfigError('INVALID_SHA256', index);
    if (byDigest.has(sha256)) throw new TokenConfigError('DUPLICATE_SHA256', index);
    if (typeof holder !== 'string') throw new TokenConfigError('INVALID_HOLDER', index);
    const trimmedHolder = holder.trim();
    if (trimmedHolder.length === 0 || trimmedHolder.length > 128 || CONTROL_RE.test(trimmedHolder)) {
      throw new TokenConfigError('INVALID_HOLDER', index);
    }
    if (role !== 'inspector' && role !== 'manager') throw new TokenConfigError('INVALID_ROLE', index);
    byDigest.set(sha256, Object.freeze({ holder: trimmedHolder, role }));
  });

  return {
    size: byDigest.size,
    lookup(token: string) {
      return byDigest.get(sha256Hex(token));
    },
  };
}
