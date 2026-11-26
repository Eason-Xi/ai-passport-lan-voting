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
async function checkTimedPoll(page) {
  const create = page.locator("#poll-form"), edit = page.locator("#deadline-form");
  const start = create.getByRole("button", {name:"发起投票"});
  const phase = page.locator("#phase");
  await create.getByLabel("投票题目").fill("计时投票");
  await create.getByLabel("截止方式").selectOption("custom");
  await create.getByLabel("截止时间（北京时间）").fill("2020-01-01T08:00");
  await start.click();
  await page.getByRole("status").getByText(/晚于主持电脑/).waitFor();
  await create.getByLabel("截止方式").selectOption("30");
  await start.click();
  await phase.getByText("正在收票").waitFor();
  await page.locator("#time-left").getByText(/剩余 00:00:/).waitFor();
  const active = (await (await fetch(base + "/api/state")).json()).poll;
  assert(active.remaining_ms > 0 && active.remaining_ms <= 30000);
  await page.locator("#edit-deadline summary").click();
  await edit.getByLabel("截止方式").selectOption("manual");
  await edit.getByRole("button", {name:"保存截止设置"}).click();
  await page.locator("#time-left").getByText("手动截止").waitFor();
  await page.locator("#edit-deadline summary").click();
  await edit.getByLabel("截止方式").selectOption("custom");
  // 浏览器使用美国时区，输入始终按北京时间解析。
  const now = (await (await fetch(base + "/api/state")).json()).server_now_ms;
  const deadline = Math.ceil((now + 6500) / 1000) * 1000;
  const input = new Date(deadline + 8 * 3600000).toISOString().slice(0, 19);
  await edit.getByLabel("截止时间（北京时间）").fill(input.endsWith(":00") ? input.slice(0, 16) : input);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "截止时间输入框横向溢出");
  await edit.getByRole("button", {name:"保存截止设置"}).click();
  await page.locator("#time-left").getByText(/剩余/).waitFor();
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
  assert(await page.getByRole("button", { name: "发起投票" }).isDisabled());
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
          "固件配网页选网、自动模式、更正入场码、多会场选择和成功提示（无线接口使用测试数据）",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "浏览器完整流程通过：十端六选项、定时截止和跨时区输入、桌面及手机布局，控制台错误 0。",
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
