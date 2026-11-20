import { hash, token, localDB, privateWrite } from "./local-operator.mjs";

async function createInvite() {
  const [output, state, ...extra] = process.argv.slice(2);
  if (extra.length) throw Error("usage");
  const platform = await localDB(state);
  try {
    const code = "ami_" + token(24);
    const expires = Math.floor(Date.now() / 1000) + 86400;
    await privateWrite(output, { invite: code, expires_at: expires });
    await platform.env.DB.prepare(
      "INSERT INTO invite_codes(code_hash,created_at,max_uses,expires_at) VALUES(?,unixepoch(),1,?)",
    )
      .bind(hash(code), expires)
      .run();
    process.stdout.write("One local invite saved privately; expires in 24 hours.\n");
  } finally {
    await platform.dispose();
  }
}
createInvite().catch(() => {
  process.stderr.write(
    "Local invite creation failed. Check local schema and exclusive output in a private directory.\n",
  );
  process.exitCode = 1;
});
