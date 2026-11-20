import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Conclusion, SubmissionInput } from './validation.js';

export interface NewInspectionRecord extends SubmissionInput {
  recordId: string;
  inspectorId: string;
}

export interface InspectionRecord extends NewInspectionRecord {
  submittedAt: string;
}

export interface InspectionRepository {
  insert(record: NewInspectionRecord): Promise<InspectionRecord>;
  /** All records of one device, newest first; ties on submission time: later insertion first. */
  listByDevice(deviceId: string): Promise<InspectionRecord[]>;
}

export function newRecordId(): string {
  return randomUUID();
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface Row {
  record_id: string;
  device_id: string;
  store_id: string;
  conclusion: Conclusion;
  note: string | null;
  inspector_id: string;
  submitted_at: string;
}

const SELECT_COLUMNS = `record_id, device_id, store_id, conclusion, note, inspector_id,
  to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at`;

function toRecord(row: Row): InspectionRecord {
  return {
    recordId: row.record_id,
    deviceId: row.device_id,
    storeId: row.store_id,
    conclusion: row.conclusion,
    note: row.note,
    inspectorId: row.inspector_id,
    submittedAt: row.submitted_at,
  };
}

export function createPgRepository(pool: Pool, schema: string): InspectionRepository {
  const table = `${quoteIdent(schema)}.inspection_record`;
  const insertSql = `INSERT INTO ${table} (record_id, device_id, store_id, conclusion, note, inspector_id)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SELECT_COLUMNS}`;
  const listSql = `SELECT ${SELECT_COLUMNS} FROM ${table}
    WHERE device_id = $1 ORDER BY submitted_at DESC, seq DESC`;
  return {
    async insert(record) {
      const result = await pool.query<Row>({
        name: `insert_inspection_record_${schema}`,
        text: insertSql,
        values: [record.recordId, record.deviceId, record.storeId, record.conclusion, record.note, record.inspectorId],
      });
      const row = result.rows[0];
      if (!row) throw new Error('insert returned no row');
      return toRecord(row);
    },
    async listByDevice(deviceId) {
      const result = await pool.query<Row>({
        name: `list_inspection_records_${schema}`,
        text: listSql,
        values: [deviceId],
      });
      return result.rows.map(toRecord);
    },
  };
}
