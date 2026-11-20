ALTER TABLE messages ADD COLUMN question_route TEXT;

CREATE TABLE question_targets (
  question_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  step INTEGER,
  reply_id INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  PRIMARY KEY (question_id, participant_id),
  UNIQUE (question_id, step)
);
CREATE INDEX question_targets_participant ON question_targets(participant_id, question_id)
  WHERE reply_id IS NULL;

CREATE TRIGGER track_question_message AFTER INSERT ON messages
WHEN NEW.question_route IS NOT NULL OR NEW.reply_to IS NOT NULL
BEGIN
  INSERT INTO question_targets(question_id, participant_id, step)
  SELECT NEW.id, p.id, json_extract(target.value, '$.step')
  FROM json_each(NEW.question_route) target
  JOIN participants p ON p.id=json_extract(target.value, '$.id')
  WHERE p.room_id=NEW.room_id AND p.kind='assistant' AND p.revoked=0;

  UPDATE question_targets SET reply_id=NEW.id
  WHERE reply_id IS NULL AND participant_id=COALESCE(NEW.relayed_for, NEW.participant_id)
    AND NEW.reply_to IS NOT NULL
    AND (question_id=NEW.reply_to OR (step>1 AND NEW.reply_to=(
      SELECT prior.reply_id FROM question_targets prior
      WHERE prior.question_id=question_targets.question_id AND prior.step=question_targets.step-1
    )))
    AND EXISTS (SELECT 1 FROM messages q
      WHERE q.id=question_targets.question_id AND q.room_id=NEW.room_id AND q.created_at<=NEW.created_at)
    AND NOT EXISTS (SELECT 1 FROM question_targets prior
      WHERE prior.question_id=question_targets.question_id AND prior.step<question_targets.step AND prior.reply_id IS NULL);
END;
