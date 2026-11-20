// Feed to ego-browser nodejs with fixtureFile and optional spaceId.
const { readFile } = await import("node:fs/promises");
const { base, invite } = JSON.parse(await readFile(fixtureFile, "utf8"));
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error("Expected a local test server");
const task = await taskSpace(typeof spaceId === "undefined" ? "Mailbox Turnstile loader regression" : spaceId);
const page = task.page("p1");
console.log({ spaceId: task.spaceId });
const button = (name) => `loc=role:button[name='${name}']`;

await page.goto(base);
await page.waitForSelector("#hero-heading", { state: "visible" });
await page.evaluate(() => {
  // Cloudflare's invisible test key exercises the external loader on loopback.
  document.querySelector('meta[name="turnstile-sitekey"]').content = "1x00000000000000000000BB";
});
await page.click(button("내 공간 만들기"));
await page.fill("#signup-invite-code", invite);
await page.waitForFunction(
  () => document.querySelector('#signup-invite-code').closest("form").querySelector('[type="submit"]').disabled === false,
  undefined, { timeout: 15000 },
);
await page.click(button("첫 화면"));
await page.click(button("이미 있어요 (열쇠·복구)"));
await page.fill("#recover-code-input", "amr_" + "a".repeat(32));
await page.waitForFunction(
  () => document.querySelector('#recover-code-input').closest("form").querySelector('[type="submit"]').disabled === false,
  undefined, { timeout: 15000 },
);
console.log("PASS external Turnstile loader enables signup and recovery on loopback with Cloudflare's test key");
