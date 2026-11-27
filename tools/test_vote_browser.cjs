// 实际浏览器操作主持台，并用十个真实 WebSocket 客户端参加同一场投票。
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "build", "browser");
fs.mkdirSync(output, { recursive: true });
const session = fs.mkdtempSync(path.join(output, "session-"));
const log = fs.openSync(path.join(session, "server.log"), "w");
const server = spawn(
  path.join(root, ".venv/bin/python"),
  [
    "-c",
    "import sys; from pathlib import Path; from aiohttp import web; from host.server import VotingService; " +
      "web.run_app(VotingService(Path(sys.argv[1]), 18765, discovery_port=0).app(), host='127.0.0.1', port=18765)",
    path.join(session, "votes.sqlite3"),
  ],
  { cwd: root, stdio: ["ignore", log, log] },
);
const base = "http://127.0.0.1:18765";
const clients = [];
const errors = [];
let browser;
async function checkBatch(page) {
  await page.setViewportSize({width:1440,height:1100});
  const form = page.locator("#poll-form"), cards = form.locator(".draft-question");
  await form.getByLabel("截止方式").selectOption("duration");
  await form.getByLabel("分钟", {exact:true}).fill("1");
  await form.getByLabel("秒", {exact:true}).fill("17");
  await cards.nth(0).getByLabel("投票题目").fill("集合地点");
  await cards.nth(0).getByLabel("选项 A",{exact:true}).fill("学校");
  await cards.nth(0).getByLabel("选项 B",{exact:true}).fill("广场");
  const add = form.getByRole("button",{name:"添加题目"});
  await add.click();
  await cards.nth(1).getByLabel("投票题目").fill("先去哪里");
  await cards.nth(1).getByLabel("选项 A",{exact:true}).fill("公园");
  await cards.nth(1).getByLabel("选项 B",{exact:true}).fill("车站");
  await add.click();
  await cards.nth(2).getByRole("button",{name:"移除本题"}).click();
  assert.equal(await cards.count(),2);
  await add.click();
  await cards.nth(2).getByLabel("投票题目").fill("是否骑车");
  await cards.nth(2).getByLabel("选项 A",{exact:true}).fill("是");
  await cards.nth(2).getByLabel("选项 B",{exact:true}).fill("是");
  const start = form.getByRole("button",{name:"一次发起 3 题"});
  await start.click();
  await page.getByRole("status").getByText(/第 3 题有重复选项/).waitFor();
  await cards.nth(2).getByLabel("选项 B",{exact:true}).fill("否");
  await start.click();
  await page.locator("#live-title").getByText("集合地点",{exact:true}).waitFor();
  await page.getByRole("status").getByText(/推送至 10 台在线投票器/).waitFor();
  const state = await (await fetch(base+"/api/state")).json();
  const polls = state.batch.polls;
  assert.equal(polls.length,3);
  assert(polls.every(p=>p.phase==="open" && p.deadline_at_ms===polls[0].deadline_at_ms));
  assert(polls[0].remaining_ms > 67000 && polls[0].remaining_ms <= 77000);
  clients[0].send(JSON.stringify({v:1,type:"vote",poll_id:polls[0].id,choice:0}));
  await page.waitForFunction(()=>document.getElementById("votes").textContent==="1");
  clients[0].send(JSON.stringify({v:1,type:"vote",poll_id:polls[1].id,choice:1}));
  clients[1].send(JSON.stringify({v:1,type:"vote",poll_id:polls[0].id,choice:1}));
  await page.waitForFunction(()=>document.getElementById("votes").textContent==="3");
  await page.getByText(/已答 2 \/ 3 题/).waitFor();
  await page.getByLabel("查看题目").selectOption(polls[1].id);
  await page.locator("#live-title").getByText("先去哪里",{exact:true}).waitFor();
  await page.locator("#result-caption").getByText(/本题已收 1 票/).waitFor();
  await page.screenshot({path:path.join(output,"batch-live.png"),fullPage:true});
  const append = page.locator("#append-form");
  await append.getByText(/排在第 4 题/).waitFor();
  const title = append.getByLabel("追加题目");
  assert.equal(await title.inputValue(), "");
  await title.fill("临时加一站吗");
  await append.getByLabel("选项 A",{exact:true}).fill("是");
  await append.getByLabel("选项 B",{exact:true}).fill("是");
  await append.getByRole("button",{name:"追加并推送"}).click();
  await page.getByRole("status").getByText(/追加题目有重复选项/).waitFor();
  await page.getByRole("button",{name:"准备下一场投票"}).click();
  assert.equal(await cards.nth(0).getByLabel("投票题目").inputValue(), "集合地点");
  await page.getByRole("button",{name:"返回本场追加题目"}).click();
  assert.equal(await title.inputValue(), "临时加一站吗");
  await append.getByLabel("选项 B",{exact:true}).fill("否");
  const submittedIds = [];
  await page.route("**/api/append_question", async route => {
    submittedIds.push(route.request().postDataJSON().question_id);
    const response = await route.fetch();
    // 第一次请求已经落库，但浏览器没有收到完整回执。
    if (submittedIds.length === 1) await route.fulfill({status:200, contentType:"application/json", body:""});
    else await route.fulfill({response});
  });
  await append.getByRole("button",{name:"追加并推送"}).click();
  await page.getByRole("status").getByText(/未收到主持服务的确认/).waitFor();
  assert.equal(await title.inputValue(), "临时加一站吗");
  await append.getByRole("button",{name:"追加并推送"}).click();
  await page.getByRole("status").getByText(/新题已追加，已同步至 10 台/).waitFor();
  await page.unroute("**/api/append_question");
  assert.equal(submittedIds.length,2);
  assert.equal(submittedIds[0],submittedIds[1]);
  await append.getByText(/排在第 5 题/).waitFor();
  await page.waitForFunction(() => document.querySelector("#append-question textarea").value === "");
  assert.equal(await page.locator("#live-question option").count(),4);
  assert.equal(await page.locator("#live-question").inputValue(),polls[1].id);
  const updated = (await (await fetch(base+"/api/state")).json()).batch.polls;
  assert.equal(updated[3].title,"临时加一站吗");
  assert.equal(updated[3].deadline_at_ms,polls[0].deadline_at_ms);
  assert.deepEqual(updated.map(p=>p.total),[2,1,0,0]);
  await page.getByLabel("查看题目").selectOption(updated[3].id);
  await page.locator("#live-title").getByText("临时加一站吗",{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,"append-live.png"),fullPage:true});
  await page.getByLabel("查看题目").selectOption(polls[1].id);
  await page.locator("#edit-deadline summary").click();
  await page.locator("#deadline-form").getByLabel("截止方式").selectOption("manual");
  await page.locator("#save-deadline").click();
  await page.locator("#time-left").getByText("手动截止",{exact:true}).waitFor();
  assert((await (await fetch(base+"/api/state")).json()).batch.polls.every(p=>!("deadline_at_ms" in p)));
  await page.getByRole("button",{name:"整组截止收票"}).click();
  await page.waitForFunction(()=>document.getElementById("phase").textContent==="已截止");
  await page.getByRole("link",{name:"本场统计已保存，查看统计"}).click();
  const history = page.locator("#history");
  const entry = history.locator("details").filter({has:page.locator("summary strong",{hasText:"集合地点"})});
  await entry.getByText(/2 人参与 · 3 票/).waitFor();
  await entry.getByRole("heading",{name:"2. 先去哪里（1 票）",exact:true}).waitFor();
  await entry.getByRole("heading",{name:"3. 是否骑车（0 票）",exact:true}).waitFor();
  await entry.getByRole("heading",{name:"4. 临时加一站吗（0 票）",exact:true}).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await entry.getByRole("link",{name:"下载统计 CSV"}).click();
  const csvFile = await downloadPromise;
  assert.equal(csvFile.suggestedFilename(),`vote-${polls[0].id}.csv`);
  const csvBody = fs.readFileSync(await csvFile.path(), "utf8");
  assert(csvBody.includes("先去哪里,1,B,车站,1,100.0%"));
  await page.getByRole("button",{name:"公布整组结果"}).click();
  await page.waitForFunction(()=>document.getElementById("phase").textContent==="结果已公布");
  const shown = page.waitForResponse(r => r.url() === base+"/api/show_result" && r.request().method()==="POST");
  await page.getByRole("button",{name:"在投票器上展示本题"}).click();
  assert((await shown).ok());
  assert.equal((await (await fetch(base+"/api/state")).json()).batch.shown_result,polls[1].id);
  await page.reload();
  await page.locator("#history summary").filter({hasText:"集合地点"}).first().click();
  await page.locator("#history").getByRole("heading",{name:"1. 集合地点（2 票）"}).waitFor();
  assert.equal(await page.locator("#history-list .history-entry").count(),3);
  await page.getByLabel("查看题目").selectOption(polls[2].id);
  await page.locator("#result-caption").getByText(/本题已收 0 票/).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"批量投票手机页面横向溢出");
}
async function checkTimedPoll(page) {
  const create = page.locator("#poll-form"), edit = page.locator("#deadline-form");
  const start = create.getByRole("button", {name:"发起投票"});
  const phase = page.locator("#phase");
  await create.getByLabel("投票题目").fill("计时投票");
  await create.getByLabel("截止方式").selectOption("custom");
  await create.getByLabel("截止时间（北京时间）").fill("2020-01-01T08:00");
  await start.click();
  await page.getByRole("status").getByText(/晚于主持电脑/).waitFor();
  await create.getByLabel("截止方式").selectOption("duration");
  await start.click();
  await page.getByRole("status").getByText(/大于 0 秒/).waitFor();
  await create.getByLabel("截止方式").selectOption("30");
  await start.click();
  await phase.getByText("正在收票").waitFor();
  await page.locator("#time-left").getByText(/剩余 00:00:/).waitFor();
  const active = (await (await fetch(base + "/api/state")).json()).poll;
  assert(active.remaining_ms > 0 && active.remaining_ms <= 30000);
  const deadlineToggle = page.locator("#edit-deadline summary");
  await deadlineToggle.getByText("调整截止时间", {exact:true}).click();
  await edit.getByLabel("截止方式").selectOption("manual");
  await edit.getByRole("button", {name:"保存截止设置"}).click();
  await page.locator("#time-left").getByText("手动截止").waitFor();
  clients[0].send(JSON.stringify({v:1,type:"vote",poll_id:active.id,choice:0}));
  await page.waitForFunction(() => document.getElementById("votes").textContent === "1");
  await deadlineToggle.getByText("设置截止时间", {exact:true}).click();
  await edit.getByLabel("截止方式").selectOption("duration");
  await edit.getByLabel("秒", {exact:true}).fill("23");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "自定义时长输入框横向溢出");
  await edit.getByRole("button", {name:"保存截止设置"}).click();
  await page.locator("#time-left").getByText(/剩余/).waitFor();
  const added = (await (await fetch(base + "/api/state")).json()).poll;
  assert.equal(added.id, active.id);
  assert.equal(added.total, 1);
  assert(added.remaining_ms > 15000 && added.remaining_ms <= 23000);
  await deadlineToggle.getByText("调整截止时间", {exact:true}).click();
  await edit.getByLabel("截止方式").selectOption("custom");
  // 浏览器使用美国时区，输入始终按北京时间解析。
  const now = (await (await fetch(base + "/api/state")).json()).server_now_ms;
  const deadline = Math.ceil((now + 6500) / 1000) * 1000;
  const input = new Date(deadline + 8 * 3600000).toISOString().slice(0, 19);
  await edit.getByLabel("截止时间（北京时间）").fill(input.endsWith(":00") ? input.slice(0, 16) : input);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "截止时间输入框横向溢出");
  await edit.getByRole("button", {name:"保存截止设置"}).click();
  await page.locator("#deadline-time").getByText(input.slice(11), {exact:false}).waitFor();
  const saved = (await (await fetch(base + "/api/state")).json()).poll;
  assert.equal(saved.deadline_at_ms, deadline);
  assert((await page.locator("#deadline-time").innerText()).includes(input.slice(11)));
  await page.screenshot({path:path.join(output, "timed-poll.png"), fullPage:true});
  await page.reload();
  try {
    await page.waitForFunction(() => document.getElementById("phase").textContent === "已截止", null, {timeout:15000});
  } catch (error) {
    const last = await (await fetch(base + "/api/state")).json();
    throw Error(`界面阶段 ${await phase.innerText()}，主持台阶段 ${last.poll.phase}，距截止 ${deadline-last.server_now_ms} 毫秒，浏览器错误 ${errors.join("、")}`, {cause:error});
  }
  assert(await page.locator("#close").isDisabled());
  assert(!(await page.locator("#edit-deadline").isVisible()));
  assert(await page.locator("#publish").isEnabled());
  await page.locator("#publish").click();
  await phase.getByText("结果已公布").waitFor();
}
async function checkVoteModes(page) {
  const form = page.locator("#poll-form");
  const cards = form.locator(".draft-question");
  const first = cards.nth(0);
  await first.getByLabel("投票题目").fill("活动地点");
  await first.getByLabel("选项 A",{exact:true}).fill("公园");
  await first.getByLabel("选项 B",{exact:true}).fill("学校");
  await first.getByLabel("投票模式").selectOption("approval");
  await first.getByLabel("投票模式").selectOption("single");
  assert.equal(await first.getByLabel("选项 A",{exact:true}).inputValue(), "公园");
  const add = form.getByRole("button",{name:"添加题目"});
  await add.click();
  const approval = cards.nth(1);
  await approval.getByLabel("投票题目").fill("是否通过活动方案");
  await approval.getByLabel("投票模式").selectOption("approval");
  await add.click();
  const rating = cards.nth(2);
  await rating.getByLabel("投票题目").fill("给活动打几分");
  await rating.getByLabel("投票模式").selectOption("rating");
  await page.screenshot({path:path.join(output,"vote-modes-editor.png"),fullPage:true});
  await form.getByRole("button",{name:"一次发起 3 题"}).click();
  const append = page.locator("#append-form");
  await append.getByLabel("追加题目").fill("哪个季节更冷");
  await append.getByLabel("投票模式").selectOption("quiz");
  await append.getByLabel("选项 A",{exact:true}).fill("冬天");
  await append.getByLabel("选项 B",{exact:true}).fill("夏天");
  await append.getByLabel("正确答案").selectOption({index:1});
  await append.getByRole("button",{name:"追加并推送"}).click();
  await page.getByRole("status").getByText(/新题已追加/).waitFor();
  await page.waitForFunction(() => document.querySelector("#live-question").options.length === 4);
  const {batch:{polls}} = await (await fetch(base+"/api/state")).json();
  assert.deepEqual(polls.map(p=>p.mode),["single","approval","rating","quiz"]);
  assert.deepEqual(polls[1].options,["赞成","反对","弃权"]);
  assert.deepEqual(polls[2].options,["1 分","2 分","3 分","4 分","5 分"]);
  assert.equal(polls[3].correct_choice,0);
  const choices = [0,0,4,0];
  for (const [index, question] of polls.entries()) {
    clients[0].send(JSON.stringify({v:1,type:"vote",poll_id:question.id,choice:choices[index]}));
    await page.waitForFunction(total => Number(document.querySelector("#votes").textContent) === total, index+1);
  }
  const result = page.locator("#live-result-summary");
  await page.getByLabel("查看题目").selectOption(polls[1].id);
  await result.getByText(/赞成率\s*100\.0%/).waitFor();
  await page.getByLabel("查看题目").selectOption(polls[2].id);
  await result.getByText(/平均\s*5\.00\s*分/).waitFor();
  await page.getByLabel("查看题目").selectOption(polls[3].id);
  await result.getByText(/答对\s*1\s*人/).waitFor();
  await page.getByRole("button",{name:"整组截止收票"}).click();
  await page.getByRole("link",{name:"本场统计已保存，查看统计"}).click();
  const latest = page.locator("#history-list details").first();
  await latest.getByRole("heading",{name:"4. 哪个季节更冷（1 票）",exact:true}).waitFor();
  await latest.getByText(/答对\s*1\s*人/).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"选择模式和查看统计时手机页面横向溢出");
  await page.getByRole("button",{name:"公布整组结果"}).click();
  await page.locator("#phase").getByText("结果已公布").waitFor();
}
async function checkDeviceLimit(page) {
  const field = page.getByRole("spinbutton", {name:"设备上限"});
  await field.waitFor();
  assert.equal(await field.inputValue(), "10");
  await field.fill("64");
  await page.waitForResponse(r => r.url() === base + "/api/state" && r.ok());
  assert.equal(await field.inputValue(), "64");
  await page.getByRole("button", {name:"保存上限"}).click();
  await page.locator("#online-limit").getByText("/ 64 台", {exact:true}).waitFor();
  await page.locator("#device-count").getByText("已登记 10 / 64 台", {exact:true}).waitFor();
  await page.locator("#btn-stage").click();
  await page.locator("#stage-device-limit").getByText("/ 64", {exact:true}).waitFor();
  await page.locator("#stage-exit").click();
  await page.reload();
  await field.waitFor();
  assert.equal(await field.inputValue(), "64");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

async function checkQuestionLibrary(page) {
  const open = page.getByRole("button", {name:"题库", exact:true});
  const library = page.getByRole("dialog", {name:/题库/});
  const form = page.locator("#library-form");
  const drafts = page.locator("#questions .draft-question");
  const create = page.locator("#poll-form");
  await open.click();
  await library.getByText(/还没有保存的题目/).waitFor();
  await library.getByRole("button", {name:"新建题目", exact:true}).click();
  await form.getByLabel("投票题目").fill("哪种水果适合分享");
  await form.getByLabel("投票模式").selectOption("quiz");
  await form.getByLabel("选项 A", {exact:true}).fill("苹果");
  await form.getByLabel("选项 B", {exact:true}).fill("香蕉");
  await form.getByLabel("正确答案").selectOption({index:1});
  await form.getByRole("button", {name:"保存题目"}).click();
  await library.getByText("题目已保存", {exact:true}).waitFor();
  await page.reload();
  await open.click();
  await library.getByRole("button", {name:"编辑题目"}).click();
  assert.equal(await form.getByLabel("投票模式").inputValue(), "quiz");
  await form.getByLabel("投票题目").fill("哪种常见水果颜色偏黄");
  await form.getByLabel("正确答案").selectOption({index:2});
  await form.getByRole("button", {name:"保存题目"}).click();
  await library.getByRole("heading", {name:"哪种常见水果颜色偏黄"}).waitFor();
  await library.getByRole("button", {name:"关闭题库"}).click();
  await drafts.nth(0).getByLabel("投票题目").fill("临时安排");
  await drafts.nth(0).getByLabel("选项 A", {exact:true}).fill("赞成");
  await drafts.nth(0).getByLabel("选项 B", {exact:true}).fill("反对");
  await drafts.nth(0).getByRole("button", {name:"存入题库"}).click();
  await form.getByRole("button", {name:"保存题目"}).click();
  await library.getByRole("heading", {name:"临时安排"}).waitFor();
  const quiz = library.locator("article").filter({hasText:"哪种常见水果颜色偏黄"});
  await quiz.getByRole("button", {name:"选用题目"}).click();
  assert.equal(await drafts.nth(0).getByLabel("投票题目").inputValue(), "临时安排");
  assert.equal(await drafts.nth(1).getByLabel("投票题目").inputValue(), "哪种常见水果颜色偏黄");
  await create.getByRole("button", {name:"一次发起 2 题"}).click();
  await page.locator("#phase").getByText("正在收票", {exact:true}).waitFor();
  const append = page.locator("#append-form");
  await append.getByLabel("追加题目").fill("已有追加草稿");
  await open.click();
  page.once("dialog", dialog => dialog.dismiss());
  await quiz.getByRole("button", {name:"选用题目"}).click();
  await library.getByRole("button", {name:"关闭题库"}).click();
  assert.equal(await append.getByLabel("追加题目").inputValue(), "已有追加草稿");
  await append.getByLabel("追加题目").fill("");
  await open.click();
  await quiz.getByRole("button", {name:"选用题目"}).click();
  assert.equal(await append.getByLabel("追加题目").inputValue(), "哪种常见水果颜色偏黄");
  await append.getByRole("button", {name:"追加并推送"}).click();
  await page.waitForFunction(() => document.querySelector("#live-question").options.length === 3);
  const {batch} = await (await fetch(base+"/api/state")).json();
  assert.deepEqual(batch.polls.map(p=>p.correct_choice), [null, 1, 1]);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

async function checkHistoryDelete(page) {
  const history = page.locator("#history-list");
  const earlier = history.locator("details").filter({hasText:"周末团建，你更想去哪里？"});
  const dialog = page.getByRole("dialog", {name:"删除投票记录"});
  await earlier.locator("summary").click();
  const remove = earlier.getByRole("button", {name:"删除记录"});
  await remove.click();
  await dialog.getByText(/周末团建，你更想去哪里？/).waitFor();
  await dialog.getByRole("button", {name:"取消"}).click();
  assert(await earlier.isVisible());

  const observer = await browser.newPage();
  try {
    await observer.goto(base);
    const copy = observer.locator("#history-list details").filter({hasText:"周末团建，你更想去哪里？"});
    await copy.waitFor();
    const previous = (await (await fetch(base+"/api/state")).json()).history_count;
    await remove.click();
    await dialog.getByRole("button", {name:"确认删除"}).click();
    await earlier.waitFor({state:"detached"});
    await copy.waitFor({state:"detached"});
    const after = await (await fetch(base+"/api/state")).json();
    assert.equal(after.history_count, previous-1);
    assert.equal(after.poll.phase, "open");
  } finally {
    await observer.close();
  }
  await page.getByRole("button", {name:"整组截止收票"}).click();
  await page.getByRole("link", {name:"本场统计已保存，查看统计"}).click();
  const current = history.locator("details").filter({hasText:"临时安排"});
  await current.getByRole("button", {name:"删除记录"}).click();
  await dialog.getByRole("button", {name:"确认删除"}).click();
  await current.waitFor({state:"detached"});
  await page.getByRole("button", {name:"公布整组结果"}).click();
  await page.locator("#phase").getByText("结果已公布", {exact:true}).waitFor();
  await page.reload();
  await history.locator("details").first().waitFor();
  assert.equal(await earlier.count(), 0);
  assert.equal(await current.count(), 0);
}

async function checkPhoneSetup() {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  phone.on("pageerror", e => errors.push(e.message));
  phone.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const html = fs.readFileSync(path.join(root, "main/vote_setup.html"), "utf8");
  const room = "00000000abcdef12";
  let state = {status:0, busy:false, hosts:[], message:""};
  const posts = [];
  await phone.route("http://192.168.4.1/**", async route => {
    const u = new URL(route.request().url());
    if (u.pathname === "/") return route.fulfill({ contentType:"text/html; charset=utf-8", body:html });
    if (u.pathname === "/networks") return route.fulfill({ json:{scanning:false,
      networks:[{ssid:"现场测试",open:false},{ssid:"开放测试",open:true}]} });
    if (u.pathname === "/status") return route.fulfill({json:state});
    if (u.pathname === "/config") {
      const data = route.request().postDataJSON();
      posts.push(data);
      if (data.host_id || data.server) state = {status:2, busy:true, hosts:[], message:"已入场"};
      else if (posts.length === 1) state = {status:9, busy:false, hosts:[], message:"入场码错误，请重新填写"};
      else state = {status:8, busy:false, hosts:[room,"00000000abcd0001"], message:"发现多个主持台，请选择会场"};
      return route.fulfill({status:202, body:"正在连接"});
    }
    return route.fulfill({status:204});
  });
  await phone.goto("http://192.168.4.1/");
  await phone.getByLabel("现场 Wi-Fi").selectOption({label:"现场测试"});
  assert(await phone.getByLabel("Wi-Fi 密码").isVisible());
  assert(!(await phone.getByLabel("电脑地址").isVisible()));
  await phone.getByLabel("Wi-Fi 密码").fill("testpass");
  await phone.getByLabel("主持台六位入场码").fill("123456");
  await phone.screenshot({path:path.join(output,"phone-onboarding.png"),fullPage:true});
  await phone.getByRole("button",{name:"连接并入场"}).click();
  await phone.getByText("入场码错误，请重新填写").waitFor();
  assert.deepEqual(posts[0], {ssid:"现场测试",password:"testpass",code:"123456",server:""});
  await phone.getByLabel("现场 Wi-Fi").selectOption({label:"开放测试（开放）"});
  assert(!(await phone.getByLabel("Wi-Fi 密码").isVisible()));
  await phone.getByLabel("主持台六位入场码").fill("123457");
  await phone.getByRole("button",{name:"连接并入场"}).click();
  await phone.getByRole("button",{name:"主持台 ABCDEF12"}).waitFor();
  assert.equal(posts[1].password, "");
  // 频道切换后重新打开页面，选择会场只需点编号，无须重填 Wi-Fi。
  await phone.reload();
  await phone.getByRole("button",{name:"主持台 ABCDEF12"}).click();
  await phone.getByText(/入场成功。手机可以/).waitFor();
  assert.deepEqual(posts[2], {host_id:room});
  state = {status:0, busy:false, hosts:[], message:""};
  await phone.reload();
  await phone.getByLabel("现场 Wi-Fi").selectOption("manual");
  await phone.getByLabel("Wi-Fi 名称").fill("隐藏测试");
  await phone.getByLabel("主持台六位入场码").fill("123457");
  await phone.getByText("手动指定主持电脑").click();
  await phone.getByLabel("电脑地址").fill("192.168.1.20:9988");
  await phone.getByRole("button",{name:"连接并入场"}).click();
  await phone.getByText(/入场成功。手机可以/).waitFor();
  assert.deepEqual(posts[3], {ssid:"隐藏测试",password:"",code:"123457",server:"ws://192.168.1.20:9988/ws"});
  assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await phone.close();
}
async function run() {
  let state;
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(base + "/api/state");
      state = await response.json();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert(state, "主持服务未启动");
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
    timezoneId: "America/Los_Angeles",
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(base);
  await page.getByText("主持服务已连接", { exact: true }).waitFor();
  await page.getByText("自动发现已开启 · 主持台 " + state.host_id.slice(-8).toUpperCase(), {exact:true}).waitFor();
  await page.screenshot({
    path: path.join(output, "desktop-empty.png"),
    fullPage: true,
  });
  await page.getByLabel("投票题目").fill("周末团建，你更想去哪里？");
  const choices = [
    "森林公园",
    "历史博物馆",
    "海边露营",
    "城市骑行",
    "手工体验",
    "留在家里",
  ];
  for (let i = 2; i < 6; i++)
    await page.getByRole("button", { name: "添加选项" }).click();
  for (let i = 0; i < 6; i++)
    await page
      .getByRole("textbox", {
        name: `选项 ${String.fromCharCode(65 + i)}`,
        exact: true,
      })
      .fill(choices[i]);
  assert(await page.getByRole("button", { name: "添加选项" }).isDisabled());
  await page.getByRole("button", { name: "发起投票" }).click();
  await page
    .locator("#live-title")
    .getByText("周末团建，你更想去哪里？", { exact: true })
    .waitFor();
  await page.getByRole("heading",{name:"向本场追加题目"}).waitFor();
  assert(await page.locator("#start").isDisabled());
  assert(await page.getByRole("button",{name:"追加并推送"}).isEnabled());
  for (let i = 0; i < 10; i++) {
    const ws = new WebSocket("ws://127.0.0.1:18765/ws");
    clients.push(ws);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("设备入场超时")), 5000);
      ws.addEventListener(
        "open",
        () =>
          ws.send(
            JSON.stringify({
              v: 1,
              type: "hello",
              device_id: `aabbcc00000${i}`,
              code: state.join_code,
            }),
          ),
        { once: true },
      );
      ws.addEventListener(
        "message",
        (e) => {
          const data = JSON.parse(e.data);
          assert.equal(data.type, "state");
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  state = await (await fetch(base + "/api/state")).json();
  clients.forEach((ws, i) =>
    ws.send(
      JSON.stringify({
        v: 1,
        type: "vote",
        poll_id: state.poll.id,
        choice: i % 6,
      }),
    ),
  );
  await page.waitForFunction(
    () => document.getElementById("votes").textContent === "10",
  );
  await page.waitForFunction(
    () => document.getElementById("online").textContent === "10",
  );
  assert.equal(await page.locator(".result").count(), 6);
  await page.screenshot({
    path: path.join(output, "desktop-live.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "截止收票", exact: true }).click();
  await page.waitForFunction(
    () => document.getElementById("phase").textContent === "已截止",
  );
  assert(await page.getByRole("button", { name: "发起投票" }).isDisabled());
  await page.getByRole("button", { name: "公布结果", exact: true }).click();
  await page.waitForFunction(
    () => document.getElementById("phase").textContent === "结果已公布",
  );
  await page.screenshot({
    path: path.join(output, "desktop-results.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(output, "mobile-results.png"),
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "手机页面横向溢出",
  );
  await page.getByLabel("投票题目").fill("😀");
  await page.getByRole("button", { name: "发起投票" }).click();
  await page
    .getByRole("status")
    .getByText(/字库暂不支持/)
    .waitFor();
  assert.equal(
    (await (await fetch(base + "/api/state")).json()).poll.id,
    state.poll.id,
  );
  await checkTimedPoll(page);
  await checkBatch(page);
  await checkVoteModes(page);
  await checkDeviceLimit(page);
  await checkQuestionLibrary(page);
  await checkHistoryDelete(page);
  await checkPhoneSetup();
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        passed: true,
        clients: 10,
        options: 6,
        desktop: [1440, 1100],
        mobile: [390, 844],
        consoleErrors: errors,
        checks: [
          "发题",
          "十端计票",
          "截止",
          "公布",
          "禁止重复发题",
          "未支持字形提示",
          "移动端无横向溢出",
          "定时发题、取消与更改截止时间、跨时区输入、刷新后自动截止与手动公布",
          "批量增删题目、整批校验、按人进度、逐题计票、整组截止和结果展示",
          "收票中追加题目并推送、保留草稿和正在查看的题目、追加题进入本场历史",
          "逐题切换四种投票模式，混合发题、追加测验、查看实时统计和归档",
          "直接设置设备上限，主持台和投屏同步更新，刷新后保留设置",
          "本地题库新建、编辑、刷新后保留、从草稿保存、选用到批量与临时加题",
          "投票历史删除确认、取消、另一窗口同步、刷新后保持删除和当前结果仍可公布",
          "发题后十个在线连接收到推送，截止即保存逐题统计，刷新可重看并下载 CSV",
          "固件配网页选网、自动模式、更正入场码、多会场选择和成功提示（无线接口使用测试数据）",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "浏览器验收通过，覆盖在线推送、批量投票、定时截止、历史回看和 CSV 下载，以及桌面和手机布局。控制台错误 0。",
  );
}
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    clients.forEach((ws) => ws.close());
    if (browser) await browser.close();
    server.kill("SIGTERM");
    fs.closeSync(log);
  });
