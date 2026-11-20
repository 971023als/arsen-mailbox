// Feed to ego-browser nodejs after declaring fixtureFile, captureDir and optionally spaceId.
const assert = (await import("node:assert/strict")).default;
const { readFile, writeFile } = await import("node:fs/promises");
const { base, invite } = JSON.parse(await readFile(fixtureFile, "utf8"));
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const task = await taskSpace(typeof spaceId === "undefined" ? "Mailbox C local integration" : spaceId);
const page = task.page("p1");
console.log({ spaceId: task.spaceId });

const button = (name) => `loc=role:button[name='${name}']`;
const click = async (name) => {
  try {
    await page.click(button(name));
  } catch (cause) {
    throw new Error(`Could not click ${name}`, { cause });
  }
};
const wait = (selector) => page.waitForSelector(selector, { state: "visible", timeout: 8000 });
const waitText = (text) => page.waitForFunction(
  (value) => document.body.innerText.includes(value), text, { timeout: 65000 },
);
const waitSheetClosed = () => page.waitForFunction(
  () => !document.querySelector('[aria-modal="true"]'), undefined, { timeout: 8000 },
);
const configure = async (target) => {
  await target.cdp("Network.enable");
  await target.cdp("Network.setBlockedURLs", { urls: ["https://*"] });
  await target.cdp("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
};
const shot = async (name, target = page) => {
  const metrics = await target.evaluate(() => ({
    width: innerWidth,
    overflow: document.documentElement.scrollWidth - innerWidth,
    nullText: document.body.innerText.split("\n").some((line) => line.trim() === "null"),
  }));
  assert.equal(metrics.width, 360);
  assert.equal(metrics.overflow, 0, name);
  assert.equal(metrics.nullText, false, name);
  await target.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const { data } = await target.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(`${captureDir}/${name}.png`, Buffer.from(data, "base64"));
};
async function api(path, method, key, body, status = 200, retried = false) {
  const headers = { "content-type": "application/json" };
  if (key?.startsWith("amk_")) headers["x-mailbox-key"] = key;
  else if (key) headers.authorization = "Bearer " + key;
  const response = await fetch(base + path, {
    method, headers, redirect: "error",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 429 && status === 200 && method === "GET" && !retried) {
    const retry = Number(response.headers.get("retry-after"));
    if (retry > 0 && retry <= 60) {
      await new Promise((resolve) => setTimeout(resolve, retry * 1000 + 150));
      return api(path, method, key, body, status, true);
    }
  }
  assert.equal(response.status, status, method + " " + path.replace(/\?.*$/, ""));
  return response.headers.get("content-type")?.includes("application/json") ? response.json() : response.text();
}
const issuedText = () => page.evaluate(() => document.querySelector(".sheet-body .key-box")?.textContent ?? "");
const readOwnerLink = () => page.evaluate(() => document.querySelector(".key-box")?.textContent ?? "");
const storeConfirm = async () => {
  await page.evaluate(() => Array.from(document.querySelectorAll("label"))
    .find((label) => label.textContent.includes("저장했어요"))?.scrollIntoView({ block: "center" }));
  await page.click('loc=role:checkbox[name*="저장했어요"]');
};
const openMembers = () => click("참가자 시트 열기");
const openSettings = async () => {
  if (await page.evaluate(() => document.querySelector('[aria-label="방 목록으로"]')?.getClientRects().length)) {
    await click("방 목록으로");
  }
  await click("설정 열기");
  await wait('[aria-modal="true"] .chat-settings-root');
  await page.evaluate(() => [...document.querySelectorAll('[aria-modal="true"] button')]
    .find((button) => button.textContent.trim() === "공간 열쇠·복구 설정 화면으로 이동")
    ?.scrollIntoView({ block: "center" }));
  await click("공간 열쇠·복구 설정 화면으로 이동");
  await wait("#settings-heading");
};
const findMember = (name) => `loc=role:button[name*='${name}']`;
const openMember = async (name) => {
  await openMembers();
  await wait(findMember(name));
  await page.click(findMember(name));
  await wait("#member-rename-input");
};

await configure(page);
await page.goto(base);
await click("밝게");
await shot("c01-home-360-light");
await click("내 공간 만들기");
await page.fill("#signup-invite-code", invite);
assert.ok(await page.evaluate(() => document.querySelector("form button[type=submit]").disabled));
await page.click('loc=role:checkbox[name="사람 확인 (로컬 테스트)"]');
await click("내 공간 만들기");
await wait(".key-box");
const oldOwner = new URL(await readOwnerLink()).hash.slice(3);
assert.equal(oldOwner.startsWith("ams_"), true);
const oldCode = await page.evaluate(() => document.querySelectorAll(".recovery-item")[0]?.lastElementChild.textContent);
assert.equal(await page.evaluate(() => document.querySelectorAll(".recovery-item").length), 10);
await storeConfirm();
await click("내 공간으로 들어가기");
await wait(button("새 방"));
await click("새 방");
await page.fill("#new-room-name", "통합 검증 방");
await click("방 만들기");
await wait("#composer-textarea");
const [{ room_id: room }] = (await api("/api/rooms", "GET", oldOwner)).rooms;
const path = "/api/rooms/" + room;
console.log("PASS browser enrollment and room creation");

await openMembers();
await click("참가자 넣기");
await wait("#add-member-name");
await shot("c02-add-360-light");
await page.fill("#add-member-name", "검증 비서");
await page.selectOption("#add-member-interval", "30");
await click("연결 문구 만들기");
await wait(".sheet-body .key-box");
const guide = await issuedText();
assert.ok(guide.includes("설정된 30분 간격"));
assert.equal(guide.includes("null"), false);
const oldAi = /amk_[\w-]{32}/.exec(guide)?.[0];
assert.ok(oldAi);
await click("검증 비서 안내 닫기");
await waitSheetClosed();
const member = (await api(path + "/participants", "GET", oldOwner)).participants.find((p) => p.name === "검증 비서");
assert.equal(member.status, "created");

await page.fill("#composer-textarea", "사용자가 보낸 첫 글입니다.");
await click("보내기");
await waitText("사용자가 보낸 첫 글입니다.");
const fromAi = await api(`/r/${room}/messages?since=0`, "GET", oldAi);
assert.equal(fromAi.messages[0].text, "사용자가 보낸 첫 글입니다.");
await api(`/r/${room}/send`, "POST", oldAi, { text: "비서가 직접 보낸 답입니다.", reply_to: fromAi.messages[0].id });
await waitText("비서가 직접 보낸 답입니다.");
await openMember("검증 비서");
await waitText("연결됨");
await shot("c03-connected-360-light");
await page.fill("#member-rename-input", "이름 바꾼 비서");
await click("참가자 변경 저장");
await waitSheetClosed();
assert.equal((await api(path + "/participants", "GET", oldOwner)).participants.find((p) => p.participant_id === member.participant_id).name, "이름 바꾼 비서");

const manualSeat = await api(path + "/participants", "POST", oldOwner, {
  name: "하크 검증 자리", kind: "assistant", ai_type: "hark",
});
await page.evaluate(() => window.dispatchEvent(new Event("online")));
await waitText("AI 답 옮기기");
await click("AI 답 옮기기");
await page.fill("#relay-answer-text", "사용자가 붙여 넣은 비서 답입니다.");
await click("③ 선택한 AI 이름으로 올리기");
await wait("article.msg-row .chip-relay");
assert.equal(await page.evaluate(() => document.querySelector("article.msg-row .chip-relay").textContent), "사용자가 대신 올림");
await shot("c04-chat-360-light");
await api(path + "/participants/" + manualSeat.participant_id + "/revoke", "POST", oldOwner);
await openSettings();
await click("어둡게");
await click("돌아가기");
await shot("c05-chat-360-dark");
console.log("PASS browser and AI protocol read, write, rename and relay");

await openMember("이름 바꾼 비서");
await click("열쇠 재발급");
await wait('input[name="reissue-delivery"][value="get"]');
await page.click('input[name="reissue-delivery"][value="get"]');
await click("옛 열쇠 끊고 새 문구 발급");
await wait(".sheet-body .key-box");
const getGuide = await issuedText();
assert.equal(getGuide.includes("/read?k="), true);
assert.equal(getGuide.includes("X-Mailbox-Key:"), false);
const newAi = /amk_[\w-]{32}/.exec(getGuide)?.[0];
assert.ok(newAi && newAi !== oldAi);
await click("이름 바꾼 비서 안내 닫기");
await waitSheetClosed();
await api(path + "/messages", "GET", oldAi, undefined, 403);
assert.equal((await api(path + "/participants", "GET", oldOwner)).participants.find((p) => p.participant_id === member.participant_id).status, "created");
const read = await api(`/r/${room}/read?k=${newAi}&since=0`, "GET", undefined);
const ticket = /amt_[\w-]+/.exec(read)?.[0];
assert.ok(ticket && read.includes("사용자가 붙여 넣은 비서 답입니다."));
await api(`/r/${room}/send?k=${newAi}&c=${ticket}&text=${encodeURIComponent("주소 방식으로 보낸 답입니다.")}`, "GET", undefined);
await waitText("주소 방식으로 보낸 답입니다.");
await openMember("이름 바꾼 비서");
await click("끊기 (열쇠 폐기)");
await click("한 번 더 누르면 즉시 끊기");
await waitSheetClosed();
await api(path + "/messages", "GET", newAi, undefined, 403);
console.log("PASS browser reissue, old-key rejection, GET ticket reply and revocation");

const human = await api(path + "/participants", "POST", oldOwner, { name: "검증 손님", kind: "human" });
const guest = await task.newPage();
await configure(guest);
await guest.goto(human.human_link);
await guest.waitForSelector(".chip-relay", { state: "visible", timeout: 8000 });
assert.ok(await guest.evaluate(() => !location.hash));
await guest.click('loc=role:button[name="참가자 시트 열기"]');
await guest.waitForSelector('[aria-label="참가자 역할 필터"]', { state: "visible", timeout: 8000 });
assert.ok(await guest.evaluate(() => !document.querySelector('[aria-modal="true"] button.member-row')));
await guest.click('loc=role:button[name="창 닫기"]');
assert.equal(await guest.evaluate(() => document.querySelector("#guest-room-heading").textContent), "통합 검증 방");
assert.equal(await guest.evaluate(() => document.querySelector("#guest-room-identity").textContent), "참가자: 검증 손님");
await guest.click('loc=role:button[name="채팅 설정"]');
await guest.click('[data-brightness-option="light"]');
await guest.click('loc=role:button[name="창 닫기"]');
await shot("c06-guest-360-light", guest);
await guest.fill("#composer-textarea", "초대받은 사람이 쓴 글입니다.");
await guest.click(button("보내기"));
await guest.waitForFunction(() => document.body.innerText.includes("초대받은 사람이 쓴 글입니다."));
await guest.close();

await openSettings();
assert.equal(await page.evaluate(() => document.querySelector("#settings-messages-today").textContent), "5 / 500");
await shot("c07-settings-360-dark");
const regenerate = async () => {
  await click("복구 코드 다시 만들기");
  await click("한 번 더 누르면 기존 복구 코드 무효화 및 10개 재발급");
};
await regenerate();
await page.waitForFunction(
  () => Boolean(document.querySelector(".recovery-item")) ||
    Array.from(document.querySelectorAll('[role="status"]')).some((el) => /약 \d+초 뒤/.test(el.textContent)),
  undefined,
  { timeout: 8000 },
);
const regenerationWait = await page.evaluate(() => {
  if (document.querySelector(".recovery-item")) return 0;
  const statuses = Array.from(document.querySelectorAll('[role="status"]')).map((el) => el.textContent).join(" ");
  return Number(/약 (\d+)초 뒤/.exec(statuses)?.[1] ?? 0);
});
if (regenerationWait > 0 && regenerationWait <= 60) {
  await new Promise((resolve) => setTimeout(resolve, regenerationWait * 1000 + 150));
  await regenerate();
}
await wait(".recovery-item");
assert.equal(await page.evaluate(() => document.querySelectorAll(".recovery-item").length), 10);
const newCode = await page.evaluate(() => document.querySelector(".recovery-item").lastElementChild.textContent);
await api("/api/spaces/recover", "POST", undefined, { code: oldCode, turnstile: "XXXX.DUMMY.TOKEN.XXXX" }, 403);
await page.goto(base);
await click("이미 있어요 (열쇠·복구)");
await page.fill("#recover-code-input", newCode);
await page.click('loc=role:checkbox[name="사람 확인 (로컬 테스트)"]');
await click("복구 코드로 새 열쇠 발급");
await wait(".key-box");
const owner = new URL(await readOwnerLink()).hash.slice(3);
assert.ok(owner !== oldOwner && owner.startsWith("ams_"));
await waitText("기존 참가자 열쇠 1개는 계속 유효합니다.");
await api("/api/me", "GET", oldOwner, undefined, 403);
await api("/api/spaces/recover", "POST", undefined, { code: newCode, turnstile: "XXXX.DUMMY.TOKEN.XXXX" }, 403);
await storeConfirm();
await click("내 공간으로 들어가기");
await openSettings();
await page.fill("#space-delete-confirm", "삭제");
await click("공간 영구 삭제");
await wait(button("내 공간 만들기"));
await api("/api/me", "GET", owner, undefined, 403);
await api(path + "/messages", "GET", human.key, undefined, 403);
console.log("PASS guest access, code regeneration, one-time recovery and deletion");
