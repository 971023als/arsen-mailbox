declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    TEST_OWNER_KEY: string;
    OWNER_KEY_SHA256: string;
    PUBLIC_BASE_URL: string;
  }
}
