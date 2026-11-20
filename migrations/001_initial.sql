-- Inspection records are append-only (FR-021): no UPDATE/DELETE/TRUNCATE, even for the owner.
CREATE TABLE {{schema}}.inspection_record (
  seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_id    uuid        NOT NULL UNIQUE,
  device_id    text        NOT NULL CHECK (char_length(device_id) BETWEEN 1 AND 128),
  store_id     text        NOT NULL CHECK (char_length(store_id) BETWEEN 1 AND 128),
  conclusion   text        NOT NULL CHECK (conclusion IN ('NORMAL', 'ABNORMAL')),
  note         text        NULL CHECK (note IS NULL OR char_length(note) <= 2000),
  inspector_id text        NOT NULL CHECK (char_length(inspector_id) BETWEEN 1 AND 128),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX inspection_record_device_idx
  ON {{schema}}.inspection_record (device_id, submitted_at DESC, seq DESC);

CREATE FUNCTION {{schema}}.inspection_record_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inspection_record is append-only' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER inspection_record_immutable
  BEFORE UPDATE OR DELETE ON {{schema}}.inspection_record
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.inspection_record_reject_change();

CREATE TRIGGER inspection_record_no_truncate
  BEFORE TRUNCATE ON {{schema}}.inspection_record
  FOR EACH STATEMENT EXECUTE FUNCTION {{schema}}.inspection_record_reject_change();
