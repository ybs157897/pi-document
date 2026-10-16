CREATE TABLE IF NOT EXISTS pd_task_retries (
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  source_task_id text NOT NULL,
  request_id text NOT NULL,
  retry_task_id text NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  source_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id, source_task_id, request_id),
  UNIQUE (tenant_id, retry_task_id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES pd_principals (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, source_task_id) REFERENCES pd_tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, retry_task_id) REFERENCES pd_tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_id, version)
    REFERENCES pd_document_versions (tenant_id, document_id, version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pd_task_retries_document
  ON pd_task_retries (tenant_id, document_id, version, retry_task_id);
