CREATE TABLE IF NOT EXISTS pd_principals (
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  scopes text[] NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id)
);

CREATE TABLE IF NOT EXISTS pd_knowledge_bases (
  tenant_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES pd_principals (tenant_id, principal_id)
);

CREATE TABLE IF NOT EXISTS pd_knowledge_base_members (
  tenant_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  principal_id text NOT NULL,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, knowledge_base_id, principal_id),
  FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES pd_knowledge_bases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES pd_principals (tenant_id, principal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pd_contexts (
  tenant_id text NOT NULL,
  context_id text NOT NULL,
  principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, context_id),
  UNIQUE (tenant_id, context_id, principal_id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES pd_principals (tenant_id, principal_id)
);

CREATE TABLE IF NOT EXISTS pd_tasks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  context_id text NOT NULL,
  operation text NOT NULL,
  request_id text NOT NULL,
  payload_hash char(64) NOT NULL,
  request jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('operation', 'ingestion')),
  parent_task_id text,
  state text NOT NULL CHECK (state IN ('submitted', 'working', 'completed', 'failed', 'canceled')),
  result jsonb,
  pi_task_id bigint,
  pi_conversation_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES pd_principals (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, context_id, principal_id)
    REFERENCES pd_contexts (tenant_id, context_id, principal_id),
  FOREIGN KEY (tenant_id, parent_task_id) REFERENCES pd_tasks (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS pd_tasks_business_idempotency
  ON pd_tasks (tenant_id, principal_id, operation, request_id)
  WHERE kind = 'operation';
CREATE INDEX IF NOT EXISTS pd_tasks_owner_context_created
  ON pd_tasks (tenant_id, principal_id, context_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pd_tasks_dispatch_state
  ON pd_tasks (state, created_at)
  WHERE state IN ('submitted', 'working');

CREATE TABLE IF NOT EXISTS pd_task_resources (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  PRIMARY KEY (tenant_id, task_id, knowledge_base_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES pd_tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES pd_knowledge_bases (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pd_outbox (
  event_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (task_id, event_type),
  FOREIGN KEY (tenant_id, task_id) REFERENCES pd_tasks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pd_outbox_pending
  ON pd_outbox (created_at)
  WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS pd_blobs (
  tenant_id text NOT NULL,
  sha256 char(64) NOT NULL,
  relative_path text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256),
  UNIQUE (relative_path)
);

CREATE TABLE IF NOT EXISTS pd_documents (
  tenant_id text NOT NULL,
  id text NOT NULL,
  knowledge_base_id text NOT NULL,
  title text NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_type text NOT NULL CHECK (source_type = 'text'),
  active_version integer NOT NULL CHECK (active_version > 0),
  revision bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_by text NOT NULL,
  created_by_task_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES pd_knowledge_bases (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES pd_principals (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, created_by_task_id) REFERENCES pd_tasks (tenant_id, id)
);
ALTER TABLE pd_documents ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS pd_documents_kb_id
  ON pd_documents (tenant_id, knowledge_base_id, id);

CREATE TABLE IF NOT EXISTS pd_document_versions (
  tenant_id text NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  sha256 char(64) NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id, version),
  FOREIGN KEY (tenant_id, document_id) REFERENCES pd_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, sha256) REFERENCES pd_blobs (tenant_id, sha256),
  FOREIGN KEY (tenant_id, created_by) REFERENCES pd_principals (tenant_id, principal_id)
);

CREATE TABLE IF NOT EXISTS pd_processing_receipts (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  stage text NOT NULL,
  input_hash char(64) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, stage, input_hash),
  FOREIGN KEY (tenant_id, task_id) REFERENCES pd_tasks (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pd_list_cursors (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('documents', 'knowledge_bases')),
  knowledge_base_id text,
  filter_hash char(64) NOT NULL,
  last_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES pd_principals (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES pd_knowledge_bases (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pd_list_cursors_expiry ON pd_list_cursors (expires_at);
