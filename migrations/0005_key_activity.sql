ALTER TABLE participants RENAME COLUMN last_seen_at TO last_read_at;
ALTER TABLE participants ADD COLUMN first_read_at INTEGER;
ALTER TABLE participants ADD COLUMN issued_at_message_id INTEGER NOT NULL DEFAULT 0;
-- Old rows have no issuance boundary. Use the last known room id conservatively.
UPDATE participants SET first_read_at=last_read_at,
    issued_at_message_id=COALESCE((SELECT MAX(id) FROM messages WHERE room_id=participants.room_id),0);
CREATE TRIGGER participant_issued AFTER INSERT ON participants BEGIN
  UPDATE participants SET issued_at_message_id=COALESCE((SELECT MAX(id) FROM messages WHERE room_id=NEW.room_id),0)
  WHERE id=NEW.id;
END;
CREATE TRIGGER participant_reissued AFTER UPDATE OF key_hash ON participants
WHEN NEW.key_hash != OLD.key_hash AND NEW.revoked=0 BEGIN
  UPDATE participants SET issued_at_message_id=COALESCE((SELECT MAX(id) FROM messages WHERE room_id=NEW.room_id),0),
    first_read_at=NULL,last_read_at=NULL WHERE id=NEW.id;
END;
