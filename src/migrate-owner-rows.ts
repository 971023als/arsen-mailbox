export async function migrateOwnerRows(
  db: D1Database,
  owner: string,
  id: string,
  epoch: number,
  keyHash: string,
  codeHashes: string[],
) {
  await db.batch([
    db
      .prepare("INSERT INTO v2_assertion SELECT 'forbidden' WHERE EXISTS(SELECT 1 FROM spaces WHERE legacy_owner_id=?)")
      .bind(owner),
    db
      .prepare(
        "INSERT INTO v2_assertion SELECT 'key_epoch_invalid' WHERE EXISTS(SELECT 1 FROM mailbox_meta WHERE key='epoch_floor' AND value>?)",
      )
      .bind(epoch),
    db
      .prepare(
        "INSERT INTO spaces(id,key_hash,key_epoch,created_at,last_seen_at,legacy_owner_id) VALUES(?,?,?,unixepoch(),unixepoch(),?)",
      )
      .bind(id, keyHash, epoch, owner),
    db.prepare("UPDATE rooms SET owner_id=? WHERE owner_id=?").bind(id, owner),
    // The colon is outside cleanName's alphabet, so a legacy participant cannot own this replacement name.
    db
      .prepare(
        "UPDATE participants SET name='이전 참가자: ' || name WHERE name='공간 주인' AND is_owner=0" +
          " AND room_id IN (SELECT id FROM rooms WHERE owner_id=?)",
      )
      .bind(id),
    db
      .prepare(
        "INSERT INTO participants(id,room_id,name,kind,is_owner,key_hash,key_epoch,created_at)" +
          " SELECT lower(hex(randomblob(9))),r.id,'공간 주인'" +
          ",'human',1,lower(hex(randomblob(32))),?,unixepoch() FROM rooms r WHERE r.owner_id=?",
      )
      .bind(epoch, id),
    db
      .prepare(
        "INSERT INTO rate_hits(bucket,subject,window_start,count) SELECT 'space_posts',?,unixepoch()/86400*86400,count(*)" +
          " FROM messages m JOIN rooms r ON r.id=m.room_id WHERE r.owner_id=? AND m.created_at>=unixepoch()/86400*86400",
      )
      .bind(id, id),
    ...codeHashes.map((codeHash) =>
      db
        .prepare("INSERT INTO recovery_codes(space_id,code_hash,key_epoch,created_at) VALUES(?,?,?,unixepoch())")
        .bind(id, codeHash, epoch),
    ),
    db
      .prepare(
        "INSERT INTO mailbox_meta(key,value) VALUES('epoch_floor',?) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)",
      )
      .bind(epoch),
  ]);
}
