"use strict";
const $ = (id) => document.getElementById(id);
let state = null,
  busy = false,
  coverage = [];
let stateAt = 0, refreshSequence = 0, editingPoll = null;
const beijingTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium", hourCycle: "h23",
});
function hostNow() {
  return state.server_now_ms + (performance.now() - stateAt);
}
function beijingInput(ms) {
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 19);
}
function deadlineFields(id) {
  const box = $(id);
  box.append($("deadline-template").content.cloneNode(true));
  const mode = box.querySelector("select"), at = box.querySelector("input");
  function selectMode() {
    at.disabled = mode.value !== "custom";
    at.required = !at.disabled;
    at.parentElement.hidden = at.disabled;
    if (!at.disabled && !at.value && state?.server_now_ms)
      at.value = beijingInput(hostNow() + 300000);
  }
  mode.onchange = selectMode;
  selectMode();
  return {
    mode,
    reset(deadline) {
      mode.value = deadline ? "custom" : "manual";
      at.value = deadline ? beijingInput(deadline) : "";
      selectMode();
    },
    value() {
      if (mode.value === "manual") return { deadline_at_ms: null };
      if (!state?.server_now_ms) throw Error("请重启新版主持服务后设置定时截止。");
      if (mode.value !== "custom") return { duration_seconds: Number(mode.value) };
      const deadline = Date.parse(at.value + "+08:00");
      if (!Number.isFinite(deadline) || deadline <= hostNow())
        throw Error("请选择晚于主持电脑当前时间的北京时间。");
      return { deadline_at_ms: deadline };
    },
  };
}
const newDeadline = deadlineFields("new-deadline"), activeDeadline = deadlineFields("active-deadline");
function renderDeadline(p) {
  const deadline = p.deadline_at_ms;
  let title = deadline ? "定时截止" : "手动截止";
  if (deadline && p.phase === "open") {
    const seconds = Math.max(0, Math.ceil((deadline - hostNow()) / 1000));
    const days = Math.floor(seconds / 86400);
    const clock = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, "0")).join(":");
    title = seconds ? `剩余 ${days ? days + " 天 " : ""}${clock}` : "正在确认截止";
  } else if (p.phase !== "open") {
    title = p.phase === "closed" ? "收票已截止" : "收票已结束";
  }
  $("time-left").textContent = title;
  $("deadline-time").textContent = deadline
    ? `${p.phase === "open" ? "截止" : "原定截止"}于 ${beijingTime.format(deadline)}（北京时间）` : "";
  const editor = $("edit-deadline");
  editor.hidden = p.phase !== "open" || !state.server_now_ms;
  if (editor.hidden || (editingPoll && editingPoll !== p.id)) editor.open = false;
  // 折叠时准备当前值，展开后保留主持人的输入，轮询不会覆盖正在编辑的选择。
  if (!editor.open) {
    editingPoll = p.id;
    activeDeadline.reset(deadline);
  }
}
$("deadline-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!editingPoll || state?.poll?.id !== editingPoll) return;
  try {
    if (await action("deadline", { poll_id: editingPoll, ...activeDeadline.value() })) {
      $("edit-deadline").open = false;
      if (state?.poll) activeDeadline.reset(state.poll.deadline_at_ms);
    }
  } catch (error) { notice(error.message); }
};
function notice(message = "") {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
function addOption(value = "") {
  if ($("options").children.length >= 6) return;
  const row = document.createElement("div");
  row.className = "option";
  const letter = document.createElement("span");
  letter.className = "option-letter";
  const input = document.createElement("input");
  input.required = true;
  input.maxLength = 24;
  input.value = value;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    row.remove();
    labelOptions();
  });
  row.append(letter, input, remove);
  $("options").append(row);
  labelOptions();
}
function labelOptions() {
  [...$("options").children].forEach((row, i) => {
    const label = String.fromCharCode(65 + i);
    row.firstChild.textContent = label;
    row.children[1].placeholder = `选项 ${label}`;
    row.children[1].setAttribute("aria-label", `选项 ${label}`);
    row.lastChild.disabled = $("options").children.length <= 2;
    row.lastChild.setAttribute("aria-label", `删除选项 ${label}`);
  });
  $("add-option").disabled = $("options").children.length >= 6;
}
async function action(name, body) {
  if (!state || busy) return;
  busy = true;
  updateButtons();
  try {
    const response = await fetch(`/api/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Host-Nonce": state.nonce,
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "操作未完成，请刷新后重试");
    notice();
    await refresh();
    return true;
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
    updateButtons();
  }
}
function updateButtons() {
  const p = state?.poll;
  $("start").disabled = busy || !state || (p && p.phase !== "published");
  $("close").disabled = busy || !p || p.phase !== "open";
  $("publish").disabled = busy || !p || p.phase === "published";
  $("save-deadline").disabled = busy || p?.phase !== "open";
  newDeadline.mode.disabled = !state || !state.server_now_ms;
  $("deadline-upgrade").hidden = !state || !!state.server_now_ms;
  $("form-note").textContent =
    p && p.phase !== "published"
      ? "请先公布当前题目结果，再发起新题。"
      : "发起后，题目将同步到所有在线投票器。";
}
function render() {
  const p = state.poll;
  $("join-code").textContent = state.join_code;
  $("online").textContent = state.devices.filter((d) => d.online).length;
  $("votes").textContent = p?.total || 0;
  const phases = {
    open: "正在收票",
    closed: "已截止",
    published: "结果已公布",
  };
  $("phase").textContent = p ? phases[p.phase] : "等待发起";
  $("live-badge").textContent = p ? phases[p.phase] : "等待开始";
  $("live-badge").classList.toggle("active", p?.phase === "open");
  $("empty").hidden = !!p;
  $("live-poll").hidden = !p;
  if (p) {
    renderDeadline(p);
    $("live-title").textContent = p.title;
    $("result-caption").textContent =
      p.phase === "published"
        ? "结果已同步至在线投票器；重连设备会自动补收。"
        : "票数仅主持人可见，公布后同步到投票器。";
    $("results").replaceChildren(
      ...p.options.map((option, i) => {
        const row = document.createElement("div");
        row.className = "result";
        const top = document.createElement("div");
        top.className = "result-top";
        const title = document.createElement("span");
        title.textContent = `${String.fromCharCode(65 + i)}  ${option}`;
        const count = document.createElement("b");
        const percent = p.total ? (p.counts[i] * 100) / p.total : 0;
        count.textContent = `${p.counts[i]} 票 · ${percent.toFixed(1)}%`;
        top.append(title, count);
        const track = document.createElement("div");
        track.className = "track";
        const bar = document.createElement("div");
        bar.className = "bar";
        bar.style.width = `${percent}%`;
        track.append(bar);
        row.append(top, track);
        return row;
      }),
    );
  }
  let discoveryText = "自动发现未开启，请使用下方手动地址";
  if (!("discovery_available" in state)) discoveryText = "重启新版主持服务即可启用自动发现";
  if (state.discovery_available) discoveryText = "自动发现已开启 · 主持台 " + state.host_id.slice(-8).toUpperCase();
  $("discovery-status").textContent = discoveryText;
  $("server-address").textContent =
    state.addresses.join("  或  ") ||
    `请查看电脑 Wi-Fi 的 IPv4 地址，填写 ws://电脑IP:${state.port}/ws`;
  $("device-count").textContent = `${state.devices.length} 台已登记`;
  $("device-list").replaceChildren(
    ...state.devices.map((d) => {
      const box = document.createElement("div");
      box.className = `device ${d.online ? "online" : ""}`;
      const title = document.createElement("strong");
      title.textContent = d.id.toUpperCase();
      const detail = document.createElement("p");
      detail.textContent = `${d.online ? "在线" : "离线"} · ${d.voted ? "已投票" : "未投票"}`;
      detail.className = d.voted ? "done" : "";
      box.append(title, detail);
      if (!d.online) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "text-button";
        remove.textContent = "移除登记";
        remove.onclick = () => action("forget", { device_id: d.id });
        box.append(remove);
      }
      return box;
    }),
  );
  if (!state.devices.length) {
    const text = document.createElement("p");
    text.className = "no-devices";
    text.textContent = "等待第一台投票器加入";
    $("device-list").append(text);
  }
  updateButtons();
}
async function refresh() {
  const sequence = ++refreshSequence;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw Error();
    const data = await response.json();
    if (sequence !== refreshSequence) return;
    state = data;
    stateAt = performance.now();
    $("dot").classList.add("on");
    $("connection").textContent = "主持服务已连接";
    render();
  } catch {
    if (sequence !== refreshSequence) return;
    $("dot").classList.remove("on");
    $("connection").textContent = "服务已断开 · 正在重连";
    state = null;
    updateButtons();
  }
}
$("add-option").onclick = () => addOption();
addOption();
addOption();
$("question").oninput = () => {
  $("question-count").textContent = `${[...$("question").value].length} / 60`;
};
$("poll-form").onsubmit = (event) => {
  event.preventDefault();
  const title = $("question").value.trim(),
    options = [...$("options").querySelectorAll("input")].map((i) =>
      i.value.trim(),
    );
  const unsupported = [
    ...new Set(
      [...title, ...options.join("")].filter(
        (c) =>
          !coverage.some(
            ([a, b]) => c.codePointAt(0) >= a && c.codePointAt(0) <= b,
          ),
      ),
    ),
  ];
  if (coverage.length && unsupported.length)
    return notice(
      `投票器字库暂不支持：${unsupported.slice(0, 12).join("")}，请换成常用汉字或英文。`,
    );
  try { action("create", { title, options, ...newDeadline.value() }); }
  catch (error) { notice(error.message); }
};
$("close").onclick = () => action("close", { poll_id: state?.poll?.id });
$("publish").onclick = () => action("publish", { poll_id: state?.poll?.id });
fetch("/font-coverage.json")
  .then((r) => r.json())
  .then((data) => {
    coverage = data.ranges;
  })
  .catch(() => notice("字库清单未加载，请刷新页面。"));
async function poll() {
  await refresh();
  setTimeout(poll, 1000);
}
poll();
