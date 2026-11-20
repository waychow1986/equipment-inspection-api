export type Conclusion = 'NORMAL' | 'ABNORMAL';

export interface SubmissionInput {
  deviceId: string;
  storeId: string;
  conclusion: Conclusion;
  note: string | null;
}

export type FieldReason =
  | 'REQUIRED'
  | 'INVALID_TYPE'
  | 'INVALID_VALUE'
  | 'TOO_LONG'
  | 'MULTIPLE_VALUES'
  | 'MALFORMED'
  | 'TOO_LARGE';

export interface FieldError {
  field: string;
  reason: FieldReason;
}

export type ValidationResult = { ok: true; value: SubmissionInput } | { ok: false; fields: FieldError[] };

export const LIMITS = { deviceId: 128, storeId: 128, note: 2000 } as const;
const CONCLUSIONS: readonly string[] = ['NORMAL', 'ABNORMAL'];

/** Counts Unicode code points, matching PostgreSQL char_length. */
function charLength(value: string): number {
  return Array.from(value).length;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number | undefined,
  fields: FieldError[],
): string | undefined {
  const raw = body[field];
  if (raw === undefined) {
    fields.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  if (typeof raw !== 'string') {
    fields.push({ field, reason: 'INVALID_TYPE' });
    return undefined;
  }
  const value = raw.trim();
  if (value === '') {
    fields.push({ field, reason: 'REQUIRED' });
    return undefined;
  }
  if (maxLength !== undefined && charLength(value) > maxLength) {
    fields.push({ field, reason: 'TOO_LONG' });
    return undefined;
  }
  return value;
}

/** Validates the `deviceId` query parameter (INT-002); other query parameters are ignored. */
export function validateDeviceQuery(query: unknown): { ok: true; value: string } | { ok: false; fields: FieldError[] } {
  const raw = isPlainObject(query) ? query.deviceId : undefined;
  if (Array.isArray(raw)) return { ok: false, fields: [{ field: 'deviceId', reason: 'MULTIPLE_VALUES' }] };
  const fields: FieldError[] = [];
  const value = requiredString({ deviceId: raw }, 'deviceId', LIMITS.deviceId, fields);
  return value === undefined ? { ok: false, fields } : { ok: true, value };
}

export function validateSubmission(body: unknown): ValidationResult {
  if (!isPlainObject(body)) return { ok: false, fields: [{ field: 'body', reason: 'MALFORMED' }] };

  const fields: FieldError[] = [];
  const deviceId = requiredString(body, 'deviceId', LIMITS.deviceId, fields);
  const storeId = requiredString(body, 'storeId', LIMITS.storeId, fields);
  const conclusion = requiredString(body, 'conclusion', undefined, fields);
  if (conclusion !== undefined && !CONCLUSIONS.includes(conclusion)) {
    fields.push({ field: 'conclusion', reason: 'INVALID_VALUE' });
  }

  let note: string | null = null;
  const rawNote = body.note;
  if (rawNote !== undefined && rawNote !== null) {
    if (typeof rawNote !== 'string') {
      fields.push({ field: 'note', reason: 'INVALID_TYPE' });
    } else {
      const trimmed = rawNote.trim();
      if (charLength(trimmed) > LIMITS.note) fields.push({ field: 'note', reason: 'TOO_LONG' });
      else note = trimmed === '' ? null : trimmed;
    }
  }

  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: {
      deviceId: deviceId as string,
      storeId: storeId as string,
      conclusion: conclusion as Conclusion,
      note,
    },
  };
}
