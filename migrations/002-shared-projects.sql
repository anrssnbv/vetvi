-- Additive: original namespaces, records and receipts remain intact.
CREATE TABLE shared_project_scopes(project_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, creator_id TEXT NOT NULL, personal INTEGER NOT NULL CHECK(personal IN (0,1)));
CREATE TABLE task_outbox(event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, version INTEGER NOT NULL, actor_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
CREATE INDEX task_outbox_pending ON task_outbox(state,created_at);
CREATE TABLE bridge_sessions(token_hash TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE project_intents(actor_id TEXT NOT NULL, request_id TEXT NOT NULL, external_id TEXT NOT NULL, payload_hash TEXT NOT NULL, PRIMARY KEY(actor_id,request_id));
CREATE TABLE completion_receipts(action_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL);
