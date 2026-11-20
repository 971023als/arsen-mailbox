// Offline operator CLI for wrangler's LOCAL D1 only. No credentials are accepted on the command line.
import { hash, token, localDB, privateWrite } from "./local-operator.mjs";
import { migrateOwnerRows } from "./migrate-owner-rows.ts";

async function migrate() {
  const [owner, output, state, ...extra] = process.argv.slice(2);
  if (extra.length || !/^o_[a-z0-9_-]{1,32}$/.test(owner || "")) throw Error("usage");
  const platform = await localDB(state);
  try {
    const { DB: db, KEY_EPOCH: raw } = platform.env;
    if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) throw Error("invalid epoch");
    const epoch = Number(raw);
    const id = token(9);
    const key = "ams_" + token(24);
    const codes = Array.from({ length: 10 }, () => "amr_" + token(24));
    if (await db.prepare("SELECT 1 FROM spaces WHERE legacy_owner_id=?").bind(owner).first())
      throw Error("already migrated");
    // Persist the credentials first, exclusively. A crash after DB commit must not strand the owner.
    await privateWrite(output, { space_id: id, key, recovery_codes: codes });
    await migrateOwnerRows(db, owner, id, epoch, hash(key), codes.map(hash));
    process.stdout.write("Local owner migration completed. Credentials saved privately.\n");
  } finally {
    await platform.dispose();
  }
}
migrate().catch(() => {
  process.stderr.write(
    "Local migration failed. Check arguments, local schema, owner, epoch and exclusive output path; verify the space before using any output.\n",
  );
  process.exitCode = 1;
});
