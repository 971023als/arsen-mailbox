import { createHash } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Test-only owner key (not a secret): the Worker is given only its SHA-256, exactly like production.
export const TEST_OWNER_KEY = "amo_test-only-owner-key-0000000000000000";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./src/wrangler.local.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_OWNER_KEY,
            OWNER_KEY_SHA256: createHash("sha256").update(TEST_OWNER_KEY).digest("hex"),
            PUBLIC_BASE_URL: "https://mailbox.example.test",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
