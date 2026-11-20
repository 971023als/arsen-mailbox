ALTER TABLE participants ADD COLUMN avatar_preset TEXT;
ALTER TABLE participants ADD COLUMN avatar_rev TEXT;
ALTER TABLE participants ADD COLUMN avatar_webp TEXT;
ALTER TABLE participants ADD COLUMN device_label TEXT;
ALTER TABLE participants ADD COLUMN role_note TEXT;

CREATE TRIGGER clear_revoked_avatar AFTER UPDATE OF revoked ON participants
WHEN NEW.revoked=1 AND OLD.revoked=0
BEGIN
  UPDATE participants SET avatar_preset=NULL,avatar_rev=NULL,avatar_webp=NULL WHERE id=NEW.id;
END;
