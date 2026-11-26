"use strict";
const $ = (id) => document.getElementById(id);
let state = null,
  busy = false,
  coverage = [];
let stateAt = 0, refreshSequence = 0, editingPoll = null;
const beijingTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium", hourCycle: "h23",
});
const voteModes = {
  single: {guide: "适合从几个方案中选出一个。"},
  approval: {guide: "赞成票超过赞成与反对票之和的一半即通过，弃权单独统计。",
    options: ["赞成", "反对", "弃权"]},
  rating: {guide: "每人选一个分值，主持台汇总平均分。",
    options: ["1 分", "2 分", "3 分", "4 分", "5 分"]},
  quiz: {guide: "设置一个正确答案，主持台汇总答对人数和正确率。"},
};
function modeResult(poll) {
  const stats = poll.mode_summary;
  if (!stats) return "";
  if (poll.mode === "approval") {
    if (stats.approval_pct === null) return "表决 · 暂无赞成或反对票";
    const prefix = stats.passed ? "" : "未";
    const status = poll.phase === "open" ? `当前${prefix}达到通过线` : `${prefix}通过`;
    return `表决 · 赞成率 ${stats.approval_pct.toFixed(1)}%（不计弃权） · ${status}`;
  }
  if (poll.mode === "rating") {
    return stats.average === null ? "评分 · 暂无评分" : `评分 · 平均 ${stats.average.toFixed(2)} 分`;
  }
  if (poll.mode === "quiz") {
    const answer = `正确答案 ${String.fromCharCode(65 + poll.correct_choice)} · ${poll.options[poll.correct_choice]}`;
    if (stats.correct_pct === null) return `${answer} · 暂无作答`;
    return `${answer} · 答对 ${stats.correct_count} 人 · 正确率 ${stats.correct_pct.toFixed(1)}%`;
  }
  return "";
}
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
function notice(message = "", success = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("success", success);
  $("notice").hidden = !message;
}
let historyHead, historyBefore = null, historyRequest = 0;
function historyEntry(report) {
  const entry = document.createElement("details");
  entry.className = "history-entry";
  entry.dataset.id = report.id;
  const summary = document.createElement("summary");
  const title = document.createElement("strong");
  title.textContent = report.title;
  const meta = document.createElement("small");
  const when = report.ended_at_ms === null ? `发起于 ${beijingTime.format(report.started_at_ms)}`
    : `结束于 ${beijingTime.format(report.ended_at_ms)}`;
  meta.textContent = `${when} · ${report.question_count} 题 · ${report.participants} 人参与 · ${report.total_votes} 票`;
  summary.append(title, meta);
  const body = document.createElement("div");
  body.className = "history-body";
  entry.append(summary, body);
  entry.ontoggle = async () => {
    if (!entry.open || entry.dataset.loaded) return;
    entry.dataset.loaded = "loading";
    body.textContent = "正在读取统计…";
    try {
      const response = await fetch(`/api/history/${report.id}`, {cache:"no-store"});
      if (!response.ok) throw Error();
      const detail = await response.json();
      body.replaceChildren();
      const times = document.createElement("p");
      times.className = "help";
      const end = detail.ended_at_ms === null ? "旧版未记录结束时间" : "结束于 " + beijingTime.format(detail.ended_at_ms);
      times.textContent = `北京时间 · 发起于 ${beijingTime.format(detail.started_at_ms)} · ${end}`;
      const download = document.createElement("a");
      download.href = `/api/history/${report.id}/csv`;
      download.download = "";
      download.textContent = "下载统计 CSV";
      body.append(times, download);
      detail.questions.forEach((question, index) => {
        const heading = document.createElement("h3");
        heading.textContent = `${index + 1}. ${question.title}（${question.total} 票）`;
        const list = document.createElement("ul");
        question.options.forEach((option, i) => {
          const row = document.createElement("li");
          const name = document.createElement("span"), tally = document.createElement("b");
          name.textContent = `${String.fromCharCode(65+i)}  ${option}`;
          if (question.mode === "quiz" && question.correct_choice === i) row.dataset.correct = "";
          const percent = question.total ? question.counts[i] * 100 / question.total : 0;
          tally.textContent = `${question.counts[i]} 票 · ${percent.toFixed(1)}%`;
          row.append(name, tally);
          list.append(row);
        });
        body.append(heading);
        const result = modeResult(question);
        if (result) {
          const summary = document.createElement("p");
          summary.className = "mode-result";
          summary.textContent = result;
          body.append(summary);
        }
        body.append(list);
      });
      entry.dataset.loaded = "yes";
    } catch {
      delete entry.dataset.loaded;
      body.textContent = "统计暂时无法读取，请收起后重新打开。";
    }
  };
  return entry;
}

async function loadHistory(before = null) {
  const serial = ++historyRequest;
  const list = $("history-list");
  $("history-more").disabled = true;
  $("history-retry").hidden = true;
  try {
    const response = await fetch("/api/history" + (before ? `?before=${before}` : ""), {cache:"no-store"});
    if (!response.ok) throw Error();
    const page = await response.json();
    if (serial !== historyRequest) return;
    const existing = new Map([...list.children].map(row => [row.dataset.id, row]));
    const rows = page.reports.map(report => existing.get(report.id) || historyEntry(report));
    if (before) list.append(...rows);
    else list.replaceChildren(...rows);
    historyBefore = page.next_before;
    $("history-more").hidden = historyBefore === null;
    $("history-status").textContent = list.childElementCount ? "" : "尚无已结束的投票。收票结束后，统计会自动保存在这里。";
  } catch {
    if (serial !== historyRequest) return;
    $("history-status").textContent = "暂时无法读取投票历史。";
    $("history-retry").hidden = false;
  } finally {
    if (serial === historyRequest) $("history-more").disabled = false;
  }
}
$("history-more").onclick = () => loadHistory(historyBefore);
$("history-retry").onclick = () => loadHistory();
$("current-report").onclick = async event => {
  event.preventDefault();
  const id = state?.poll?.id;
  const findEntry = () => [...$("history-list").children].find(entry => entry.dataset.id === id);
  if (!findEntry()) await loadHistory();
  const entry = findEntry();
  if (entry) entry.open = true;
  (entry || $("history")).scrollIntoView({block:"start"});
};

let optionSerial = 0;
function addOption(card) {
  const options = card.querySelector(".options");
  if (options.children.length >= 6) return;
  const row = document.createElement("div");
  row.className = "option";
  row.dataset.choice = String(++optionSerial);
  const letter = document.createElement("span");
  letter.className = "option-letter";
  const input = document.createElement("input");
  input.required = true;
  input.maxLength = 24;
  input.oninput = () => updateCorrectOptions(card);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    row.remove();
    labelOptions(card);
  });
  row.append(letter, input, remove);
  options.append(row);
  labelOptions(card);
}
function labelOptions(card) {
  const rows = card.querySelector(".options").children;
  [...rows].forEach((row, i) => {
    const label = String.fromCharCode(65 + i);
    row.firstChild.textContent = label;
    row.children[1].placeholder = `选项 ${label}`;
    row.children[1].setAttribute("aria-label", `选项 ${label}`);
    row.lastChild.disabled = rows.length <= 2;
    row.lastChild.setAttribute("aria-label", `删除选项 ${label}`);
  });
  card.querySelector(".add-option").disabled = rows.length >= 6;
  updateCorrectOptions(card);
}
function updateCorrectOptions(card) {
  const select = card.querySelector(".correct-choice");
  const selected = select.value;
  select.replaceChildren(new Option("请选择正确选项", ""));
  [...card.querySelectorAll(".options .option")].forEach((row, i) => {
    const value = row.querySelector("input").value.trim();
    const item = new Option(`${String.fromCharCode(65 + i)} · ${value || "待填写"}`, row.dataset.choice);
    item.disabled = !value;
    select.add(item);
    if (selected === item.value && !item.disabled) select.value = selected;
  });
}
function updateQuestionMode(card) {
  const mode = card.querySelector(".mode-select").value;
  const config = voteModes[mode];
  const fixed = card.querySelector(".fixed-options");
  const custom = card.querySelector(".custom-options");
  card.querySelector(".mode-guide").textContent = config.guide;
  fixed.hidden = !config.options;
  custom.hidden = !!config.options;
  custom.querySelectorAll("input").forEach(input => { input.disabled = custom.hidden; });
  const items = (config.options || []).map(label => {
    const item = document.createElement("li");
    item.textContent = label;
    return item;
  });
  fixed.querySelector("ul").replaceChildren(...items);
  const answer = card.querySelector(".correct-choice");
  answer.parentElement.hidden = mode !== "quiz";
  answer.disabled = mode !== "quiz";
  answer.required = mode === "quiz";
}
let questionSerial = 0;
function makeQuestionCard() {
  const card = $("question-template").content.firstElementChild.cloneNode(true);
  const title = card.querySelector("textarea"), label = card.querySelector(".question-label");
  title.id = "question-" + (++questionSerial);
  label.htmlFor = title.id;
  title.oninput = () => { label.querySelector("span").textContent = `${[...title.value].length} / 60`; };
  card.querySelector(".add-option").onclick = () => addOption(card);
  const mode = card.querySelector(".mode-select");
  const guide = card.querySelector(".mode-guide");
  guide.id = title.id + "-mode-guide";
  mode.setAttribute("aria-describedby", guide.id);
  mode.onchange = () => updateQuestionMode(card);
  addOption(card);
  addOption(card);
  updateQuestionMode(card);
  return card;
}
function addQuestion() {
  const card = makeQuestionCard();
  card.querySelector(".remove-question").onclick = () => {
    if ($("questions").children.length <= 1) return;
    card.remove();
    numberQuestions();
  };
  $("questions").append(card);
  numberQuestions();
  return card.querySelector("textarea");
}
function numberQuestions() {
  [...$("questions").children].forEach((card, i) => {
    card.querySelector("legend").textContent = `第 ${i + 1} 题`;
  });
  updateButtons();
}
let editorRound = null, appendBatch = null, appendAttempt = null, preparingNext = false;
function resetAppend(batchId) {
  const card = makeQuestionCard();
  card.querySelector(".remove-question").remove();
  card.querySelector(".question-label").firstChild.textContent = "追加题目";
  $("append-question").replaceChildren(card);
  appendBatch = batchId;
  appendAttempt = null;
}

function updateEditor() {
  const poll = state?.poll;
  const active = state?.supports_append && poll?.phase === "open";
  const count = state?.batch?.polls.length || 1;
  const full = count >= (state?.max_batch_polls || 1);
  if (state) {
    if (editorRound !== (poll?.id ?? null)) {
      preparingNext = false;
      editorRound = poll?.id ?? null;
    }
    if (active && appendBatch !== poll.id &&
        ![...$("append-question").querySelectorAll("input,textarea")].some(input => input.value.trim())) {
      resetAppend(poll.id);
    }
    const appending = active && !preparingNext;
    $("poll-form").hidden = !!appending;
    $("append-form").hidden = !appending;
    $("editor-title").textContent = appending ? "向本场追加题目" : active ? "准备下一场投票" : "新建投票";
    $("editor-mode").hidden = !active;
    $("editor-mode").textContent = appending ? "准备下一场投票" : "返回本场追加题目";
    if (active) {
      const stale = appendBatch !== poll.id;
      $("use-append-draft").hidden = !stale;
      $("append-note").textContent = stale ? "这份草稿属于上一场。请核对后再用于当前场次。"
        : full ? `本场已达到 ${state.max_batch_polls} 题上限。`
        : `新题将排在第 ${count + 1} 题，沿用本场截止时间。答完前题的投票器会立即收到新题。`;
    }
  }
  $("editor-mode").disabled = busy;
  $("use-append-draft").disabled = busy || !active;
  const retry = appendAttempt && state?.batch?.polls.some(q => q.id === appendAttempt.id);
  $("append-submit").disabled = busy || !active || appendBatch !== poll?.id || (full && !retry);
  const card = $("append-question").firstElementChild;
  if (card) card.disabled = busy;
}

$("editor-mode").onclick = () => { preparingNext = !preparingNext; updateButtons(); };
$("use-append-draft").onclick = () => {
  if (state?.poll?.phase !== "open") return;
  appendBatch = state.poll.id;
  appendAttempt = null;
  updateButtons();
};
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
    const result = await response.json().catch(() => { throw Error("未收到主持服务的确认，请保留当前内容后重试。"); });
    if (!response.ok) throw Error(result.error || "操作未完成，请刷新后重试");
    if ((name === "create" || name === "create_batch") && Number.isInteger(result.pushed_to)) {
      notice(result.pushed_to ? `已发起，题目已推送至 ${result.pushed_to} 台在线投票器，可立即作答。`
        : "已发起，当前没有在线投票器。设备入场后会自动收到题目。", true);
    } else if (name === "append_question") {
      notice(`新题已追加，已同步至 ${result.pushed_to} 台在线投票器。`, true);
    } else notice();
    await refresh();
    return true;
  } catch (error) {
    notice(error instanceof TypeError ? "暂时无法连接主持服务，请保留当前内容后重试。" : error.message);
  } finally {
    busy = false;
    updateButtons();
  }
}
function updateButtons() {
  updateEditor();
  document.querySelectorAll(".question-mode").forEach(control => {
    control.hidden = !state?.supports_modes;
  });
  const p = state?.poll;
  const size = $("questions").children.length;
  $("add-question").disabled = !state || busy || size >= (state.max_batch_polls || 1);
  $("add-question").textContent = state?.max_batch_polls && size >= state.max_batch_polls
    ? `已达 ${state.max_batch_polls} 题上限` : "＋ 添加题目";
  $("start").textContent = size > 1 ? `一次发起 ${size} 题` : "发起投票";
  $("batch-deadline-note").hidden = size <= 1;
  $("batch-deadline-note").textContent = `所选截止时间适用于这 ${size} 道题。`;
  $("start").disabled = busy || !state || (p && p.phase !== "published");
  $("close").disabled = busy || !p || p.phase !== "open";
  $("publish").disabled = busy || !p || p.phase === "published";
  $("save-deadline").disabled = busy || p?.phase !== "open";
  $("show-result").disabled = busy || !state?.batch || p?.phase !== "published";
  newDeadline.mode.disabled = !state || !state.server_now_ms;
  $("deadline-upgrade").hidden = !state || !!state.server_now_ms;
  $("form-note").textContent =
    p && p.phase !== "published"
      ? "发起下一场前，请先公布本场结果。"
      : "发起后将推送到在线投票器，收票期间可继续追加题目。";
}
function render() {
  if (state.latest_report !== historyHead) {
    historyHead = state.latest_report;
    loadHistory();
  }
  const batch = state.batch?.polls;
  const picker = $("live-question");
  $("batch-picker").hidden = !batch;
  if (batch && (picker.dataset.batch !== state.batch.id || picker.options.length !== batch.length)) {
    const selected = picker.value;
    picker.replaceChildren(...batch.map((q, i) => new Option(`第 ${i+1} 题 · ${q.title}`, q.id)));
    if (batch.some(q => q.id === selected)) picker.value = selected;
    picker.dataset.batch = state.batch.id;
  }
  const p = batch?.find(q => q.id === picker.value) || state.poll;
  $("current-report").hidden = !p || p.phase === "open" || state.latest_report !== state.poll.id;
  $("join-code").textContent = state.join_code;
  $("online").textContent = state.devices.filter((d) => d.online).length;
  $("votes-label").textContent = batch ? "本组已收票" : "本题已收票";
  $("votes").textContent = batch ? batch.reduce((sum, q) => sum + q.total, 0) : p?.total || 0;
  $("close").textContent = batch ? "整组截止收票" : "截止收票";
  $("publish").textContent = batch ? "公布整组结果" : "公布结果";
  $("edit-deadline").querySelector("summary").textContent = batch ? "调整整组截止时间" : "调整截止时间";
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
  $("show-result").hidden = !batch || p?.phase !== "published";
  if (p) {
    renderDeadline(state.poll);
    $("live-title").textContent = p.title;
    $("result-caption").textContent =
      p.phase === "published"
        ? "结果已同步至在线投票器；重连设备会自动补收。"
        : "票数仅主持人可见，公布后同步到投票器。";
    if (batch) $("result-caption").textContent = `本题已收 ${p.total} 票 · ${$("result-caption").textContent}`;
    const result = modeResult(p);
    $("live-result-summary").hidden = !result;
    $("live-result-summary").textContent = result;
    $("results").replaceChildren(
      ...p.options.map((option, i) => {
        const row = document.createElement("div");
        row.className = "result";
        if (p.mode === "quiz" && p.correct_choice === i) row.dataset.correct = "";
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
      const progress = batch ? `已答 ${d.answered} / ${batch.length} 题` : d.voted ? "已投票" : "未投票";
      detail.textContent = `${d.online ? "在线" : "离线"} · ${progress}`;
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
$("add-question").onclick = () => addQuestion().focus();
$("live-question").onchange = () => { if (state) render(); };
$("show-result").onclick = () => {
  if (state?.batch) action("show_result", {batch_id:state.batch.id, poll_id:$("live-question").value});
};
function readDraft(card, label) {
  const mode = card.querySelector(".mode-select").value;
  if (mode !== "single" && !state?.supports_modes) throw Error("请连接支持投票模式切换的主持服务。");
  const custom = [...card.querySelectorAll(".options .option")];
  const q = {
    title: card.querySelector("textarea").value.trim(),
    options: voteModes[mode].options || custom.map(row => row.querySelector("input").value.trim()),
  };
  if (state?.supports_modes) q.mode = mode;
  if (!q.title || q.options.some(option => !option)) throw Error(`请补全${label}的题目和选项。`);
  if (new Set(q.options).size !== q.options.length) throw Error(`${label}有重复选项。`);
  if (coverage.length) {
    const missing = [...new Set([...(q.title + q.options.join(""))].filter(c =>
      !coverage.some(([a, b]) => c.codePointAt(0) >= a && c.codePointAt(0) <= b)))];
    if (missing.length) throw Error(`${label}的投票器字库暂不支持：${missing.slice(0, 12).join("")}。`);
  }
  if (mode === "quiz") {
    const answer = card.querySelector(".correct-choice").value;
    q.correct_choice = custom.findIndex(row => row.dataset.choice === answer);
    if (q.correct_choice < 0) throw Error(`请选择${label}的正确答案。`);
  }
  return q;
}
addQuestion();
$("poll-form").onsubmit = (event) => {
  event.preventDefault();
  try {
    const questions = [...$("questions").children].map((card, i) => readDraft(card, `第 ${i + 1} 题`));
    const settings = {...newDeadline.value(), previous_id: state?.poll?.id ?? null};
    if (questions.length === 1) action("create", {...questions[0], ...settings});
    else if (questions.length <= (state?.max_batch_polls || 1)) action("create_batch", {questions, ...settings});
    else notice("请连接支持批量发题的主持台。");
  }
  catch (error) { notice(error.message); }
};
$("append-form").onsubmit = async event => {
  event.preventDefault();
  if ($("append-submit").disabled || appendBatch !== state?.poll?.id) return;
  try {
    const question = readDraft($("append-question").firstElementChild, "追加题目");
    const key = JSON.stringify([appendBatch, question]);
    if (appendAttempt?.key !== key) {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      appendAttempt = {key, id: Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")};
    }
    const target = appendBatch;
    if (await action("append_question", {batch_id: target, question_id: appendAttempt.id, ...question}) && appendBatch === target) {
      resetAppend(target);
      updateButtons();
    }
  } catch (error) { notice(error.message); }
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
