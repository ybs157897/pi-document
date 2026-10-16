CREATE TABLE IF NOT EXISTS pd_audit_log (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  task_id text NOT NULL,
  operation text NOT NULL,
  request_id text,
  previous_state text,
  state text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS pd_audit_tenant_time ON pd_audit_log (tenant_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION pd_audit_task_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  old_state text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_state := to_jsonb(OLD)->>'state';
    IF old_state IS NOT DISTINCT FROM row_data->>'state' THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO pd_audit_log (tenant_id, principal_id, task_id, operation, request_id, previous_state, state)
  VALUES (row_data->>'tenant_id', row_data->>'principal_id', COALESCE(row_data->>'id', row_data->>'task_id'),
    COALESCE(row_data->>'operation', 'agent.message'), row_data->>'request_id', old_state, row_data->>'state');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pd_tasks_audit_state ON pd_tasks;
CREATE TRIGGER pd_tasks_audit_state AFTER INSERT OR UPDATE ON pd_tasks
  FOR EACH ROW EXECUTE FUNCTION pd_audit_task_state();
DO $$ BEGIN
  IF to_regclass('pd_agent_tasks') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS pd_agent_tasks_audit_state ON pd_agent_tasks';
    EXECUTE 'CREATE TRIGGER pd_agent_tasks_audit_state AFTER INSERT OR UPDATE ON pd_agent_tasks FOR EACH ROW EXECUTE FUNCTION pd_audit_task_state()';
  END IF;
END $$;
