-- Review r3 (2026-11-18). Highest KEY_EPOCH ever used for issuing a participant key. A Worker whose KEY_EPOCH
-- is lower than this refuses every participant credential operation (e.g. after a rollback to an old setting).
-- A D1 restore may lower this row; that is fine, because the restore procedure raises KEY_EPOCH anyway.
CREATE TABLE mailbox_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
