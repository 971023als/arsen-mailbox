#!/usr/bin/env node
// Creates a new owner (방장) key locally. The key goes only into a new 0600 file; stdout gets its SHA-256,
// which is what the Worker stores (`wrangler secret put OWNER_KEY_SHA256`). The key itself is never printed.
import { createHash, randomBytes } from "node:crypto";
import { openSync, writeSync, closeSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/new-owner-key.mjs <new-file>");
  process.exit(2);
}
const key = "amo_" + randomBytes(24).toString("base64url");
let fd;
try {
  fd = openSync(out, "wx", 0o600); // never overwrites
} catch {
  console.error("refused: output file already exists or cannot be created");
  process.exit(2);
}
writeSync(fd, key + "\n");
closeSync(fd);
console.log(createHash("sha256").update(key).digest("hex"));
