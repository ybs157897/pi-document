CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE pd_documents ADD COLUMN IF NOT EXISTS active_generation_id text;
ALTER TABLE pd_documents ADD COLUMN IF NOT EXISTS active_profile_id text;
ALTER TABLE pd_documents ADD COLUMN IF NOT EXISTS active_profile_version text;
ALTER TABLE pd_documents ADD COLUMN IF NOT EXISTS active_dimensions integer;

CREATE TABLE IF NOT EXISTS pd_vector_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  dimensions integer NOT NULL CHECK (dimensions > 0),
  configured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pd_index_generations (
  tenant_id text NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL,
  generation_id text NOT NULL,
  profile_id text NOT NULL,
  profile_version text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  source_sha256 char(64) NOT NULL,
  state text NOT NULL CHECK (state IN ('staging', 'ready', 'failed', 'canceled')),
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  PRIMARY KEY (tenant_id, document_id, version, generation_id),
  UNIQUE (tenant_id, document_id, version, profile_id, profile_version),
  FOREIGN KEY (tenant_id, document_id, version)
    REFERENCES pd_document_versions (tenant_id, document_id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pd_indexed_chunks (
  tenant_id text NOT NULL,
  knowledge_base_id text NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL,
  generation_id text NOT NULL,
  chunk_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  text_content text NOT NULL,
  locator jsonb NOT NULL,
  lexical_tokens text[] NOT NULL,
  lexical_tsv tsvector NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  embedding vector(__VECTOR_DIMENSIONS__) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, generation_id, chunk_id),
  UNIQUE (tenant_id, generation_id, ordinal),
  CHECK (vector_dims(embedding) = dimensions),
  FOREIGN KEY (tenant_id, knowledge_base_id)
    REFERENCES pd_knowledge_bases (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_id, version, generation_id)
    REFERENCES pd_index_generations (tenant_id, document_id, version, generation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pd_indexed_chunks_lexical_gin
  ON pd_indexed_chunks USING gin (lexical_tsv);
CREATE INDEX IF NOT EXISTS pd_indexed_chunks_vector_hnsw
  ON pd_indexed_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS pd_index_generations_active_lookup
  ON pd_index_generations (tenant_id, document_id, version, state);
