CREATE TABLE IF NOT EXISTS pd_embedding_cache (
  tenant_id text NOT NULL,
  profile_id text NOT NULL,
  profile_version text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  content_hash char(64) NOT NULL,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, profile_id, profile_version, content_hash),
  CHECK (vector_dims(embedding) = dimensions)
);
