// Feed to ego-browser nodejs with fixtureFile and avatarFile in the preceding scope.
// Uses a fresh loopback Worker/D1 and synthetic accounts only.
const assert = (await import("node:assert/strict")).default;
const fs = await import("node:fs/promises");
const fixture = JSON.parse(await fs.readFile(fixtureFile, "utf8"));
assert.match(fixture.base, /^http:\/\/127\.0\.0\.1:\d+$/);
const task = await taskSpace("Mailbox v2.2 integration");
const owner = task.page("p1");
const btn = (name) => `loc=role:button[name='${name}']`;
const wait = (page, selector) => page.waitForSelector(selector, { state: "visible", timeout: 12000 });
const waitText = (page, text) => page.waitForFunction((value) => document.body.innerText.includes(value), text, {timeout: 45000});
const close = (page) => page.click('loc=role:button[name="창 닫기"]');
const roleFilter = '[aria-modal="true"] [aria-label="참가자 역할 필터"]';
console.log({ spaceId: task.spaceId });

async function setup(page, width) {
  await page.cdp("Network.enable");
  await page.cdp("Network.setBlockedURLs", { urls: ["https://*"] });
  await page.cdp("Emulation.setDeviceMetricsOverride", {width, height: 850, deviceScaleFactor:1, mobile:false});
}
async function api(path, method = "GET", key, body, status = 200) {
  const headers = { "content-type": "application/json" };
  if (key?.startsWith("amk_")) headers["x-mailbox-key"] = key;
  else if (key) headers.authorization = "Bearer " + key;
  const r = await fetch(fixture.base + path, { method, headers, redirect: "error",
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(r.status, status, method + " " + path.split("?")[0]);
  return r.json();
}
const signup = await api("/api/spaces", "POST", undefined, {invite:fixture.invite,turnstile:"XXXX.DUMMY.TOKEN.XXXX"});
const owned = (path, method = "GET", body, status) => api(path, method, signup.key, body, status);
const {room_id: room} = await owned("/api/rooms", "POST", {name:"권한 검증 방"});
const path = "/api/rooms/" + room;
const member = (name, kind, ai_type) => owned(path + "/participants", "POST", { name, kind, ai_type });
const llm = await member("클로드1","assistant","claude");
const assistant = await member("부이1","assistant","other");
const human = await member("게스트1","human","human");
await owned(path+"/messages","POST",{text:"클로드1 → 부이1: 합성 질문입니다."});

await setup(owner,360);
await owner.goto(fixture.base + "/app/" + room + "/");
await owner.fill("#app-unlock-input",signup.key);
await owner.click(btn("내 공간 열기"));
await waitText(owner,"합성 질문입니다.");
assert.ok(await owner.evaluate(()=>location.pathname.startsWith("/app/") && !location.hash));
await waitText(owner,"앞 답변 대기");

await owner.click(btn("참가자 시트 열기"));
await wait(owner,roleFilter);
await owner.selectOption(roleFilter,"llm");
assert.ok(await owner.evaluate(()=>document.querySelectorAll('[aria-modal="true"] .member-row').length===1));
await owner.click("loc=role:button[name*='클로드1']");
await wait(owner,"#member-avatar-file");
await owner.selectOption("#detail-member-interval","custom");
await owner.fill("#detail-member-interval-custom","17");
await owner.fill("#detail-member-device","Windows PC");
await owner.fill("#detail-member-role-note","정리 <강조> & 검토");
await owner.setInputFiles("#member-avatar-file",[avatarFile]);
await owner.evaluate(()=>document.querySelector("#member-avatar-file").form.requestSubmit());
await owner.waitForFunction(()=>!document.querySelector('[aria-modal="true"]'),undefined,{timeout:12000});
assert.ok((await owned(path + "/participants")).participants.find((p)=>p.participant_id===llm.participant_id).avatar_rev);
await owner.click(btn("참가자 시트 열기"));
await owner.selectOption(roleFilter,"llm");
await owner.waitForFunction(()=>Array.from(document.querySelectorAll('[aria-modal="true"] .member-row img')).some(i=>i.src.startsWith("blob:")&&i.naturalWidth===96),undefined,{timeout:14000});
await owner.click("loc=role:button[name*='클로드1']");
await owner.evaluate(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{
  writeText:async text=>{window.__v22Clipboard=text;},
}}));
await owner.click(btn("깨우기 문구 복사"));
assert.ok(await owner.evaluate(()=>window.__v22Clipboard.includes("클로드1")&&!/am[ksr]_/.test(window.__v22Clipboard)));
await close(owner);
await owner.click(btn("참가자 시트 열기"));
await owner.selectOption(roleFilter,"assistant");
await owner.click("loc=role:button[name*='부이1']");
await wait(owner,"#member-ai-type");
await owner.selectOption("#member-ai-type","hark");
await waitText(owner,"하크에는 연결 주소 대신");
await owner.selectOption("#member-ai-type","vooy");
await owner.fill("#detail-member-device","Mac Pro");
await owner.fill("#detail-member-role-note","다음 점검");
await owner.evaluate(()=>document.querySelector("#member-ai-type").form.requestSubmit());
await owner.waitForFunction(()=>!document.querySelector('[aria-modal="true"]'),undefined,{timeout:12000});
assert.ok((await owned(path+"/participants")).participants.some(p=>p.participant_id===assistant.participant_id &&
  p.ai_type==="vooy"&&p.device_label==="Mac Pro"&&p.role_note==="다음 점검"));

const question = (await owned(path+"/messages?since=0")).messages[0];
await api(path+"/messages","POST",llm.key,{text:"첫 비서 답입니다.",reply_to:question.id});
await waitText(owner,"첫 비서 답입니다.");
await waitText(owner,"정리 <강조> & 검토");
await waitText(owner,"답변 완료");
await owner.click(btn("부이1 답 옮기기"));
await owner.click(btn("① 질문 문맥 복사하기"));
assert.ok(await owner.evaluate(()=>window.__v22Clipboard.includes("합성 질문")&&window.__v22Clipboard.includes("첫 비서 답")));
await owner.fill("#relay-answer-text","사람이 받아 옮긴 후속 답입니다.");
await owner.click(btn("③ 선택한 AI 이름으로 올리기"));
await waitText(owner,"사람이 받아 옮긴 후속 답");
const state = await owned(path+"/messages?since=0");
assert.equal(state.questions.filter((q)=>q.question_id===question.id&&q.reply_id!==null).length,2);
assert.equal((await owned(path+"/participants")).participants.find((p)=>p.participant_id===assistant.participant_id).last_read_at,null);

const guest = await task.newPage();
await setup(guest,1440);
await guest.goto(human.human_link);
await waitText(guest,"사람이 받아 옮긴 후속 답");
assert.ok(await guest.evaluate(()=>!location.hash && document.querySelector("#guest-room-heading").innerText==="권한 검증 방"));
await guest.click(btn("참가자 시트 열기"));
await guest.selectOption(roleFilter,"llm");
assert.ok(await guest.evaluate(()=>!document.querySelector('[aria-modal="true"] button.member-row')));
await guest.waitForFunction(()=>Array.from(document.querySelectorAll('[aria-modal="true"] .member-row img')).some(i=>i.src.startsWith("blob:")&&i.naturalWidth===96),undefined,{timeout:14000});
await close(guest);
assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth===innerWidth));
assert.ok(await guest.evaluate(()=>document.documentElement.scrollWidth===innerWidth));
console.log("PASS mobile owner and desktop guest: exact room, question/ordered reply, role filter, raster permissions, wake copy, relay");

if (typeof settingsChecks !== "undefined" && settingsChecks) {
  const openSettings = (page) => page.click(btn("채팅 설정"));
  const draft = "클로드1: 저장된 초안입니다.";
  await owner.fill("#composer-textarea",draft);
  await owner.evaluate(() => {
    window.__notify = { permissions:0, delivered:0, disposition:"denied" };
    Object.defineProperty(window,"Notification",{configurable:true,value:class {
      static permission="default";
      static requestPermission() {
        window.__notify.permissions++;
        this.permission=window.__notify.disposition;
        return Promise.resolve(this.permission);
      }
      constructor() { window.__notify.delivered++; }
      close() {}
    }});
  });
  await openSettings(owner);
  await wait(owner,"[data-skin-option]");
  assert.equal(await owner.evaluate(()=>window.__notify.permissions),0);
  for (const skin of ["arsen","sunlit","sky","workspace","forest"]) {
    for (const brightness of ["system","light","dark"]) {
      await owner.evaluate(({skin,brightness})=>{
        document.querySelector(`[data-skin-option="${skin}"]`).click();
        document.querySelector(`[data-brightness-option="${brightness}"]`).click();
      },{skin,brightness});
      assert.ok(await owner.evaluate(({skin,brightness})=>document.documentElement.dataset.chatSkin===skin &&
        (document.documentElement.dataset.theme??"system")===brightness &&
        innerWidth===document.documentElement.scrollWidth,{skin,brightness}));
    }
  }
  await owner.evaluate(()=>{
    document.querySelector('[data-font-option="19"]').click();
    document.querySelector('[data-leading-option="relaxed"]').click();
    document.querySelector('#chat-pref-compact').click();
    document.querySelector('[data-sendkey-option="ctrl_enter"]').click();
  });
  await owner.click("#chat-pref-browser-notify");
  await owner.waitForFunction(()=>window.__notify.permissions===1 && !document.querySelector("#chat-pref-browser-notify").checked,undefined,{timeout:10000});
  await owner.evaluate(()=>{window.__notify.disposition="granted"; Notification.permission="default";});
  await owner.click("#chat-pref-browser-notify");
  await owner.waitForFunction(()=>window.__notify.permissions===2 && document.querySelector("#chat-pref-browser-notify").checked,undefined,{timeout:10000});
  await owner.fill("#chat-owner-name-input","바뀐 방장");
  await owner.evaluate(()=>document.querySelector("#chat-owner-name-input").form.requestSubmit());
  await waitText(guest,"바뀐 방장");
  await close(owner);
  assert.ok(await owner.evaluate((text)=>document.querySelector("#composer-textarea").value===text &&
    document.activeElement.getAttribute("aria-label")==="채팅 설정",draft));
  await owner.evaluate(()=>{
    const input=document.querySelector("#composer-textarea");
    input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,isComposing:true,bubbles:true,cancelable:true}));
  });
  assert.equal((await owned(path+"/messages?since=0")).messages.length,3);
  await owner.press("#composer-textarea","Control+Enter");
  await waitText(owner,"저장된 초안입니다.");
  const newQuestion=(await owned(path+"/messages?since=0")).messages.at(-1);
  await api(path+"/messages","POST",llm.key,{text:"알림에서 본 새 답입니다.",reply_to:newQuestion.id});
  await waitText(owner,"알림에서 본 새 답");
  await owner.waitForFunction(()=>window.__notify.delivered===1,undefined,{timeout:12000});
  await api(path+"/messages","POST",llm.key,{text:"같은 질문에 한 번 더 보낸 답",reply_to:newQuestion.id});
  await waitText(owner,"같은 질문에 한 번 더 보낸 답");
  assert.equal(await owner.evaluate(()=>window.__notify.delivered),1);

  await openSettings(guest);
  await wait(guest,"[data-export-format]");
  assert.equal(await guest.evaluate(()=>Boolean(document.querySelector("#chat-owner-name-input"))),false);
  for (const format of ["md","csv","txt","json"]) {
    const pending = guest.waitForEvent("download",{timeout:12000});
    await guest.click(`[data-export-format="${format}"]`);
    const download = await pending;
    const filename = `${captureDir}/synthetic-export.${format}`;
    await download.saveAs(filename);
    const contents=await fs.readFile(filename,"utf8");
    assert.ok(contents.includes("바뀐 방장") && contents.includes("알림에서 본 새 답") && !/am[kors]_/.test(contents));
    if(format==="json") assert.equal(JSON.parse(contents).length,6);
  }
  await close(guest);
  await owner.goto(fixture.base+"/app/"+room+"/");
  await owner.fill("#app-unlock-input",signup.key);
  await owner.click(btn("내 공간 열기"));
  await waitText(owner,"알림에서 본 새 답");
  assert.ok(await owner.evaluate(()=>document.documentElement.dataset.chatSkin==="forest" &&
    document.documentElement.dataset.theme==="dark"));
  console.log("PASS 5×3 skins/brightness, owner display name, draft/focus, IME, real send, gated/deduplicated alerts, guest download in four formats and saved settings");
}
