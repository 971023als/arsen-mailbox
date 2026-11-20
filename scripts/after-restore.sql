-- ARSEN mailbox: run right after a D1 Time Travel restore, while participant access is closed
-- (KEY_EPOCH = "closed" deployed). Needs no public address: it goes through the Cloudflare API.
--   npx wrangler d1 execute DB --config wrangler.self-host.jsonc --remote --file scripts/after-restore.sql
-- Revokes every participant key the restore may have brought back and deletes every send ticket.
-- Rooms, messages and owner mapping are untouched. The owner then reissues only confirmed participants.
UPDATE participants SET revoked = 1, key_hash = 'revoked-restore-' || id || '-' || lower(hex(randomblob(16))) WHERE revoked = 0;
DELETE FROM send_tickets;
SELECT (SELECT COUNT(*) FROM participants WHERE revoked = 0) AS active_participants, (SELECT COUNT(*) FROM send_tickets) AS send_tickets;
