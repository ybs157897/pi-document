CREATE TABLE IF NOT EXISTS pd_task_page_cursors (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  filter_hash char(64) NOT NULL,
  snapshot_at timestamptz NOT NULL,
  last_created_at timestamptz NOT NULL,
  last_task_id text NOT NULL,
  visibility_hash char(32) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES pd_principals (tenant_id, principal_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pd_task_page_cursors_expiry ON pd_task_page_cursors (expires_at);
CREATE INDEX IF NOT EXISTS pd_tasks_owner_page ON pd_tasks (tenant_id, principal_id, created_at, id);
