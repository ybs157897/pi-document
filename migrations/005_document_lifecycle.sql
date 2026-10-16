ALTER TABLE pd_tasks DROP CONSTRAINT IF EXISTS pd_tasks_kind_check;
ALTER TABLE pd_tasks ADD CONSTRAINT pd_tasks_kind_check CHECK (kind IN ('operation', 'ingestion', 'purge'));

ALTER TABLE pd_list_cursors ADD COLUMN IF NOT EXISTS snapshot_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS pd_task_document_resources (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  document_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, document_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES pd_tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_id) REFERENCES pd_documents (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pd_task_document_resources_document
  ON pd_task_document_resources (tenant_id, document_id, task_id);

CREATE TABLE IF NOT EXISTS pd_document_update_reservations (
  tenant_id text NOT NULL,
  document_id text NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version > 0),
  target_version integer NOT NULL CHECK (target_version = expected_version + 1),
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  reserved_task_id text NOT NULL,
  pending_title text,
  pending_tags jsonb,
  pending_source_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id, expected_version),
  UNIQUE (tenant_id, reserved_task_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES pd_documents (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reserved_task_id) REFERENCES pd_tasks (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pd_content_cursors (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL,
  filter_hash char(64) NOT NULL,
  next_offset integer NOT NULL CHECK (next_offset >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES pd_principals (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, document_id, version)
    REFERENCES pd_document_versions (tenant_id, document_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pd_content_cursors_expiry ON pd_content_cursors (expires_at);
