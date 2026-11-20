ALTER TABLE spaces ADD COLUMN room_limit INTEGER NOT NULL DEFAULT 5 CHECK(room_limit BETWEEN 1 AND 30);
ALTER TABLE spaces ADD COLUMN participant_limit INTEGER NOT NULL DEFAULT 8 CHECK(participant_limit BETWEEN 1 AND 50);
ALTER TABLE spaces ADD COLUMN retention_days INTEGER DEFAULT 30 CHECK(retention_days IS NULL OR retention_days IN (7,30,90));
ALTER TABLE spaces ADD COLUMN retention_rev INTEGER NOT NULL DEFAULT 0;

CREATE TABLE retention_assertion (
  failure TEXT NOT NULL CONSTRAINT v2_policy_changed CHECK(failure!='policy_changed')
);

-- The previous Worker deletes everything past 30 days. Keep live 90-day/permanent
-- messages safe during a Worker-only rollback, while preserving explicit room/space deletion.
CREATE TABLE explicit_room_deletion (room_id TEXT PRIMARY KEY);
DROP TRIGGER delete_room_contents;
CREATE TRIGGER delete_room_contents BEFORE DELETE ON rooms BEGIN
  INSERT INTO explicit_room_deletion(room_id) VALUES(OLD.id);
  DELETE FROM send_tickets WHERE participant_id IN (SELECT id FROM participants WHERE room_id=OLD.id);
  DELETE FROM messages WHERE room_id=OLD.id;
  DELETE FROM participants WHERE room_id=OLD.id;
  DELETE FROM explicit_room_deletion WHERE room_id=OLD.id;
END;

CREATE TRIGGER keep_long_retention_on_rollback BEFORE DELETE ON messages
WHEN OLD.created_at<=unixepoch()-30*86400
  AND NOT EXISTS(SELECT 1 FROM explicit_room_deletion d WHERE d.room_id=OLD.room_id)
  AND EXISTS(SELECT 1 FROM rooms r JOIN spaces s ON s.id=r.owner_id WHERE r.id=OLD.room_id
    AND (s.retention_days IS NULL OR OLD.created_at>unixepoch()-s.retention_days*86400))
BEGIN
  SELECT RAISE(IGNORE);
END;
