-- ARSEN mailbox: read-only check before reopening participant access.
--   npx wrangler d1 execute DB --config wrangler.self-host.jsonc --remote --file scripts/restore-status.sql
-- Expect active_participants = 0 and send_tickets = 0 after after-restore.sql. Reopen with
-- KEY_EPOCH = (epoch_floor + 1) or higher. owner_id values must match the ids in OWNER_KEY_SHA256
-- ("o_default" for a plain <hash> entry, "o_<id>" for "<id>:<hash>").
SELECT owner_id, COUNT(*) AS rooms FROM rooms GROUP BY owner_id;
SELECT (SELECT COUNT(*) FROM participants WHERE revoked = 0) AS active_participants, (SELECT COUNT(*) FROM send_tickets) AS send_tickets, (SELECT value FROM mailbox_meta WHERE key = 'epoch_floor') AS epoch_floor;
