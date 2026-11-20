-- ARSEN mailbox (Cloudflare D1). Keys are never stored: only SHA-256 hex of each key.
CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE participants (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'assistant')),
    key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    UNIQUE (room_id, name)
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    participant_id TEXT NOT NULL REFERENCES participants(id),
    body TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reply_to INTEGER
);
CREATE INDEX messages_room ON messages(room_id, id);
CREATE INDEX messages_age ON messages(created_at);
CREATE INDEX messages_dup ON messages(participant_id, body_hash, created_at);
CREATE TABLE send_tickets (
    ticket_hash TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    created_at INTEGER NOT NULL
);
CREATE INDEX send_tickets_owner ON send_tickets(participant_id, created_at);
CREATE TABLE rate_hits (
    bucket TEXT NOT NULL,
    subject TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (bucket, subject, window_start)
);
