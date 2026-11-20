-- Review r2 (2026-11-18). Additive only.
-- key_epoch: participant keys are valid only under the Worker's current KEY_EPOCH, which lives outside D1,
-- so restoring D1 to an older point cannot revive a revoked key (raise KEY_EPOCH, then reissue).
ALTER TABLE participants ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 0;
-- indexes for the hourly sweep (tickets, rate windows, dangling reply references)
CREATE INDEX send_tickets_age ON send_tickets(created_at);
CREATE INDEX rate_hits_age ON rate_hits(window_start);
CREATE INDEX messages_reply ON messages(reply_to) WHERE reply_to IS NOT NULL;
