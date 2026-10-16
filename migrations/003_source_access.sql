ALTER TABLE pd_documents DROP CONSTRAINT IF EXISTS pd_documents_source_type_check;
ALTER TABLE pd_documents ADD CONSTRAINT pd_documents_source_type_check
  CHECK (source_type IN ('text', 'upload', 'url'));

ALTER TABLE pd_document_versions ADD COLUMN IF NOT EXISTS source_uri text;
ALTER TABLE pd_document_versions ADD COLUMN IF NOT EXISTS fetched_at timestamptz;
ALTER TABLE pd_document_versions ADD COLUMN IF NOT EXISTS source_upload_id text;

CREATE TABLE IF NOT EXISTS pd_uploads (
  tenant_id text NOT NULL,
  upload_id text NOT NULL,
  principal_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  sha256 char(64) NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, upload_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES pd_principals (tenant_id, principal_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES pd_knowledge_bases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sha256)
    REFERENCES pd_blobs (tenant_id, sha256)
);

CREATE INDEX IF NOT EXISTS pd_uploads_expiry
  ON pd_uploads (expires_at);
