import { describe, expect, it } from 'vitest';
import { validateDeviceQuery, validateSubmission } from '../../src/inspections/validation.js';

const valid = { deviceId: 'ASSET-1', storeId: 'STORE-1', conclusion: 'NORMAL' };

describe('validateSubmission', () => {
  it('accepts a complete submission and trims identifiers', () => {
    expect(
      validateSubmission({ deviceId: '  ASSET-1 ', storeId: ' STORE-1', conclusion: 'ABNORMAL', note: ' 异响 ' }),
    ).toEqual({
      ok: true,
      value: { deviceId: 'ASSET-1', storeId: 'STORE-1', conclusion: 'ABNORMAL', note: '异响' },
    });
  });

  it('treats a missing, null or blank note as empty', () => {
    for (const note of [undefined, null, '   ']) {
      const r = validateSubmission({ ...valid, note });
      expect(r).toEqual({ ok: true, value: { ...valid, note: null } });
    }
  });

  it('ignores undeclared fields such as inspector and submittedAt', () => {
    const r = validateSubmission({ ...valid, inspectorId: 'someone', inspector: 'x', submittedAt: '2000-01-01' });
    expect(r).toEqual({ ok: true, value: { ...valid, note: null } });
  });

  it('reports each missing or blank required field', () => {
    expect(validateSubmission({ storeId: 'S', conclusion: 'NORMAL' })).toEqual({
      ok: false,
      fields: [{ field: 'deviceId', reason: 'REQUIRED' }],
    });
    expect(validateSubmission({ deviceId: 'D', storeId: 'S', note: 'n' })).toEqual({
      ok: false,
      fields: [{ field: 'conclusion', reason: 'REQUIRED' }],
    });
    expect(validateSubmission({ deviceId: ' ', conclusion: 'NORMAL' })).toEqual({
      ok: false,
      fields: [
        { field: 'deviceId', reason: 'REQUIRED' },
        { field: 'storeId', reason: 'REQUIRED' },
      ],
    });
  });

  it('only accepts NORMAL or ABNORMAL (case-sensitive)', () => {
    for (const conclusion of ['良好', 'normal', 'OK', '正常']) {
      expect(validateSubmission({ ...valid, conclusion })).toEqual({
        ok: false,
        fields: [{ field: 'conclusion', reason: 'INVALID_VALUE' }],
      });
    }
  });

  it('rejects non-string types', () => {
    expect(validateSubmission({ deviceId: 1, storeId: {}, conclusion: ['NORMAL'], note: 5 })).toEqual({
      ok: false,
      fields: [
        { field: 'deviceId', reason: 'INVALID_TYPE' },
        { field: 'storeId', reason: 'INVALID_TYPE' },
        { field: 'conclusion', reason: 'INVALID_TYPE' },
        { field: 'note', reason: 'INVALID_TYPE' },
      ],
    });
    expect(validateSubmission({ ...valid, deviceId: null })).toEqual({
      ok: false,
      fields: [{ field: 'deviceId', reason: 'INVALID_TYPE' }],
    });
  });

  it('enforces length limits after trimming', () => {
    expect(validateSubmission({ ...valid, deviceId: ` ${'d'.repeat(128)} ` }).ok).toBe(true);
    expect(
      validateSubmission({ ...valid, deviceId: 'd'.repeat(129), storeId: 's'.repeat(129), note: 'n'.repeat(2001) }),
    ).toEqual({
      ok: false,
      fields: [
        { field: 'deviceId', reason: 'TOO_LONG' },
        { field: 'storeId', reason: 'TOO_LONG' },
        { field: 'note', reason: 'TOO_LONG' },
      ],
    });
    expect(validateSubmission({ ...valid, note: 'n'.repeat(2000) }).ok).toBe(true);
  });

  it('rejects bodies that are not JSON objects', () => {
    for (const body of [undefined, null, 'text', 42, [valid]]) {
      expect(validateSubmission(body)).toEqual({ ok: false, fields: [{ field: 'body', reason: 'MALFORMED' }] });
    }
  });
});

describe('validateDeviceQuery', () => {
  it('accepts a single device id and trims it, ignoring other parameters', () => {
    expect(validateDeviceQuery({ deviceId: '  ASSET-1 ', storeId: 'STORE-1' })).toEqual({ ok: true, value: 'ASSET-1' });
    expect(validateDeviceQuery({ deviceId: 'd'.repeat(128) })).toEqual({ ok: true, value: 'd'.repeat(128) });
  });

  it.each([
    ['missing', {}, 'REQUIRED'],
    ['blank', { deviceId: '   ' }, 'REQUIRED'],
    ['empty', { deviceId: '' }, 'REQUIRED'],
    ['repeated', { deviceId: ['A', 'B'] }, 'MULTIPLE_VALUES'],
    ['too long', { deviceId: 'd'.repeat(129) }, 'TOO_LONG'],
  ])('rejects a %s device id', (_name, query, reason) => {
    expect(validateDeviceQuery(query)).toEqual({ ok: false, fields: [{ field: 'deviceId', reason }] });
  });

  it('rejects a missing query object', () => {
    expect(validateDeviceQuery(undefined)).toEqual({ ok: false, fields: [{ field: 'deviceId', reason: 'REQUIRED' }] });
  });
});
