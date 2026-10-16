CREATE TABLE IF NOT EXISTS pd_agent_contexts (
  tenant_id text NOT NULL,
  context_id text NOT NULL,
  principal_id text NOT NULL,
  pi_conversation_id text,
  provider_session_id text,
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  active_task_id text,
  active_turn_no integer,
  fence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, context_id),
  UNIQUE (tenant_id, pi_conversation_id),
  FOREIGN KEY (tenant_id, context_id, principal_id)
    REFERENCES pd_contexts (tenant_id, context_id, principal_id) ON DELETE CASCADE
);

ALTER TABLE pd_agent_contexts ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE pd_agent_contexts ADD COLUMN IF NOT EXISTS close_task_id text;
ALTER TABLE pd_agent_contexts ADD COLUMN IF NOT EXISTS knowledge_base_id text;
ALTER TABLE pd_agent_contexts ADD COLUMN IF NOT EXISTS reason text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'pd_agent_contexts'::regclass AND conname = 'pd_agent_contexts_closure_complete_check'
  ) THEN
    ALTER TABLE pd_agent_contexts ADD CONSTRAINT pd_agent_contexts_closure_complete_check CHECK (
      (closed_at IS NULL AND close_task_id IS NULL AND knowledge_base_id IS NULL AND reason IS NULL)
      OR (closed_at IS NOT NULL AND close_task_id IS NOT NULL AND knowledge_base_id IS NOT NULL AND reason IS NOT NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pd_agent_contexts_closed
  ON pd_agent_contexts (tenant_id, principal_id, closed_at) WHERE closed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS pd_agent_tasks (
  tenant_id text NOT NULL,
  task_id text NOT NULL CHECK (left(task_id, 4) = 'agt_'),
  principal_id text NOT NULL,
  context_id text NOT NULL,
  current_turn_no integer NOT NULL DEFAULT 1 CHECK (current_turn_no > 0),
  state text NOT NULL CHECK (state IN ('submitted', 'working', 'input_required', 'cancel_requested', 'completed', 'failed', 'canceled')),
  answer_text text,
  clarification_text text,
  error_code text,
  error_message text,
  fence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES pd_principals (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, context_id, principal_id)
    REFERENCES pd_contexts (tenant_id, context_id, principal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pd_agent_turns (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  turn_no integer NOT NULL CHECK (turn_no > 0),
  sequence_no bigint NOT NULL,
  principal_id text NOT NULL,
  context_id text NOT NULL,
  message_id text NOT NULL,
  payload_hash char(64) NOT NULL,
  input_text text NOT NULL,
  submission_key text NOT NULL,
  pi_submission_id text,
  pi_generation_task_id text,
  state text NOT NULL CHECK (state IN ('queued', 'working', 'input_required', 'completed', 'failed', 'canceled')),
  model_requests integer NOT NULL DEFAULT 0 CHECK (model_requests >= 0),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  deadline_at timestamptz NOT NULL,
  answer_text text,
  clarification_text text,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, turn_no),
  UNIQUE (tenant_id, principal_id, message_id),
  UNIQUE (tenant_id, submission_key),
  UNIQUE (tenant_id, sequence_no, context_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES pd_agent_tasks (tenant_id, task_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, context_id, principal_id)
    REFERENCES pd_contexts (tenant_id, context_id, principal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pd_agent_actions (
  tenant_id text NOT NULL,
  action_id text NOT NULL,
  task_id text NOT NULL,
  turn_no integer NOT NULL,
  principal_id text NOT NULL,
  context_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('knowledge_base.create', 'knowledge_base.list', 'document.save', 'document.search', 'document.get', 'document.list', 'document.update', 'document.delete')),
  payload_hash char(64) NOT NULL,
  request_id text NOT NULL,
  request jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('intent', 'admitted', 'dispatching', 'working', 'completed', 'failed', 'canceled')),
  child_task_id text,
  result jsonb,
  fence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, action_id),
  UNIQUE (tenant_id, task_id, turn_no, operation, payload_hash),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, task_id, turn_no) REFERENCES pd_agent_turns (tenant_id, task_id, turn_no) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, context_id, principal_id)
    REFERENCES pd_contexts (tenant_id, context_id, principal_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, child_task_id) REFERENCES pd_tasks (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS pd_agent_turns_queue
  ON pd_agent_turns (tenant_id, context_id, sequence_no) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS pd_agent_tasks_principal_context
  ON pd_agent_tasks (tenant_id, principal_id, context_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pd_agent_actions_live
  ON pd_agent_actions (tenant_id, task_id, state) WHERE state IN ('intent', 'admitted', 'dispatching', 'working');
