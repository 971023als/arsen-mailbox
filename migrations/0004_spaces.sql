CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_ip_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
  plan TEXT NOT NULL DEFAULT 'beta',
  last_seen_at INTEGER NOT NULL,
  deleted_at INTEGER,
  legacy_owner_id TEXT UNIQUE
);
CREATE INDEX spaces_signup ON spaces(created_ip_hash,created_at);
CREATE INDEX spaces_cleanup ON spaces(status,deleted_at);
CREATE INDEX rooms_owner ON rooms(owner_id);
CREATE TABLE invite_codes (
  code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, max_uses INTEGER NOT NULL CHECK(max_uses>0),
  used INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, note TEXT
);
CREATE TABLE recovery_codes (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, used_at INTEGER,
  key_epoch INTEGER NOT NULL
);
CREATE INDEX recovery_space ON recovery_codes(space_id);
ALTER TABLE participants ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE participants ADD COLUMN ai_type TEXT;
ALTER TABLE participants ADD COLUMN delivery TEXT NOT NULL DEFAULT 'header';
ALTER TABLE participants ADD COLUMN last_seen_at INTEGER;
CREATE UNIQUE INDEX one_owner_per_room ON participants(room_id) WHERE is_owner=1;
ALTER TABLE messages ADD COLUMN relayed_for TEXT REFERENCES participants(id);
-- Every assertion inserts zero rows on success. A failed check rolls the entire D1 batch back.
CREATE TABLE v2_assertion (
  failure TEXT NOT NULL
    CONSTRAINT v2_forbidden CHECK(failure!='forbidden')
    CONSTRAINT v2_quota CHECK(failure!='quota')
    CONSTRAINT v2_not_found CHECK(failure!='not_found')
    CONSTRAINT v2_signup_closed CHECK(failure!='signup_closed')
    CONSTRAINT v2_key_epoch_invalid CHECK(failure!='key_epoch_invalid')
    CONSTRAINT v2_rate_limited CHECK(failure!='rate_limited')
);
CREATE TRIGGER delete_room_contents BEFORE DELETE ON rooms BEGIN
  DELETE FROM send_tickets WHERE participant_id IN (SELECT id FROM participants WHERE room_id=OLD.id);
  DELETE FROM messages WHERE room_id=OLD.id;
  DELETE FROM participants WHERE room_id=OLD.id;
END;
CREATE TRIGGER delete_space_rooms BEFORE DELETE ON spaces BEGIN
  DELETE FROM rooms WHERE owner_id=OLD.id;
END;
