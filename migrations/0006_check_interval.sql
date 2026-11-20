-- Check interval per participant (nullable: unset returns 10 minutes in API) and
-- one-time first-empty-read grace tracking (0 = grace open before 2nd read, 1 = 30s cooldown armed).
-- Existing rows are preserved untouched; already-checked rows arm cooldown immediately.
ALTER TABLE participants ADD COLUMN interval_minutes INTEGER CHECK(interval_minutes IS NULL OR interval_minutes >= 1);
ALTER TABLE participants ADD COLUMN cooldown_armed INTEGER NOT NULL DEFAULT 0;
UPDATE participants SET cooldown_armed = 1 WHERE first_read_at IS NOT NULL;
DROP TRIGGER IF EXISTS participant_reissued;
CREATE TRIGGER participant_reissued AFTER UPDATE OF key_hash ON participants
WHEN NEW.key_hash != OLD.key_hash AND NEW.revoked=0 BEGIN
  UPDATE participants SET issued_at_message_id=COALESCE((SELECT MAX(id) FROM messages WHERE room_id=NEW.room_id),0),
    first_read_at=NULL,last_read_at=NULL,cooldown_armed=0 WHERE id=NEW.id;
END;
