-- Applied by server/schema.ts. All writes are SQLite transactions.
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS records_owner_kind ON records(owner_id,kind);
CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, task_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS changes_owner ON changes(owner_id,seq);
CREATE TABLE IF NOT EXISTS requests(owner_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner_id,request_id));
CREATE TABLE IF NOT EXISTS links(owner_id TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(owner_id,source,target,kind));
CREATE TABLE IF NOT EXISTS positions(owner_id TEXT NOT NULL, task_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, PRIMARY KEY(owner_id,task_id));
