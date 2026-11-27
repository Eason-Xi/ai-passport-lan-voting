"use strict";
const $ = (id) => document.getElementById(id);

let state = null;
let busy = false;
let coverage = [];
let stateAt = 0;
let refreshSequence = 0;
let editingPoll = null;
let editingAliasDevice = null;
let deviceLimitDirty = false;
let renderedDevices = null;
let stageOpen = false;
let stageLight = false;
let stageMaskCounts = true;
let lastPollId = null;
let lastPollPhase = null;
let trackedDurationMs = 0;
let trackedDeadlineMs = null;
let toastTimer = null;

const PHASES = {
  open: "正在收票",
  closed: "已截止",
  published: "结果已公布",
};

const PHASE_HINTS = {
  open: "在线投票器正在作答中",
  closed: "已停止接收新票，待公布结果",
  published: "最终结果已同步至全部投票器",
};

const voteModes = {
  single: { guide: "适合从几个方案中选出一个。" },
  approval: {
    guide: "赞成票超过赞成与反对票之和的一半即通过，弃权单独统计。",
    options: ["赞成", "反对", "弃权"],
  },
  rating: {
    guide: "每人选一个分值，主持台汇总平均分。",
    options: ["1 分", "2 分", "3 分", "4 分", "5 分"],
  },
  quiz: { guide: "设置一个正确答案，主持台汇总答对人数和正确率。" },
};

const beijingTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "medium",
  timeStyle: "medium",
  hourCycle: "h23",
});

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
    return stats.average === null
      ? "评分 · 暂无评分"
      : `评分 · 平均 ${stats.average.toFixed(2)} 分`;
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

function showToast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

function notice(message = "", success = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("success", success);
  $("notice").hidden = !message;
}

async function copyText(text, okMessage) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    showToast(okMessage);
    return true;
  } catch {
    notice("无法自动复制，请手动选择复制。");
    return false;
  }
}

/* ==================== 桌面端原生桥接 ==================== */
function setupDesktopBridge() {
  const api = window.pywebview?.api;
  if (!api) return;
  $("runtime-badge").textContent = "桌面客户端";
  document.querySelectorAll(".desktop-only").forEach((el) => {
    el.hidden = false;
  });
  $("btn-data-dir").onclick = () => api.open_data_dir?.();
  $("btn-open-browser").onclick = () => api.open_in_browser?.();
}

window.addEventListener("pywebviewready", setupDesktopBridge);
if (window.pywebview?.api) setupDesktopBridge();

/* ==================== 截止时间表单 ==================== */
function deadlineFields(id) {
  const box = $(id);
  box.append($("deadline-template").content.cloneNode(true));
  const mode = box.querySelector("select");
  const at = box.querySelector("input");

  function selectMode() {
    at.disabled = mode.value !== "custom";
    at.required = !at.disabled;
    at.parentElement.hidden = at.disabled;
    if (!at.disabled && !at.value && state?.server_now_ms) {
      at.value = beijingInput(hostNow() + 300000);
    }
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
      if (!Number.isFinite(deadline) || deadline <= hostNow()) {
        throw Error("请选择晚于主持电脑当前时间的北京时间。");
      }
      return { deadline_at_ms: deadline };
    },
  };
}

const newDeadline = deadlineFields("new-deadline");
const activeDeadline = deadlineFields("active-deadline");

function formatRemaining(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const clock = [
    Math.floor(seconds / 3600) % 24,
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
  return {
    seconds,
    text: seconds ? `剩余 ${days ? days + " 天 " : ""}${clock}` : "正在确认截止",
  };
}

function renderDeadline(p) {
  const deadline = p.deadline_at_ms;
  let title = deadline ? "定时截止" : "手动截止";
  let urgent = false;
  let remainingMs = 0;

  if (deadline && p.phase === "open") {
    remainingMs = Math.max(0, deadline - hostNow());
    const rem = formatRemaining(remainingMs);
    title = rem.text;
    urgent = rem.seconds > 0 && rem.seconds <= 10;
    if (trackedDeadlineMs !== deadline) {
      trackedDeadlineMs = deadline;
      trackedDurationMs = Math.max(remainingMs, 1000);
    }
  } else {
    trackedDeadlineMs = null;
    trackedDurationMs = 0;
    if (p.phase !== "open") {
      title = p.phase === "closed" ? "收票已截止" : "收票已结束";
    }
  }

  $("time-left").textContent = title;
  $("deadline-time").textContent = deadline
    ? `${p.phase === "open" ? "截止" : "原定截止"}于 ${beijingTime.format(deadline)}（北京时间）`
    : "";
  $("deadline-box").classList.toggle("urgent", urgent);

  const barTrack = $("deadline-bar-track");
  if (deadline && p.phase === "open" && trackedDurationMs > 0) {
    barTrack.hidden = false;
    const pct = Math.max(0, Math.min(100, (remainingMs / trackedDurationMs) * 100));
    $("deadline-bar-fill").style.width = `${pct}%`;
  } else {
    barTrack.hidden = true;
  }

  const editor = $("edit-deadline");
  editor.hidden = p.phase !== "open" || !state.server_now_ms;
  if (editor.hidden || (editingPoll && editingPoll !== p.id)) editor.open = false;
  // 折叠时准备当前值，展开后保留主持人的输入，轮询不会覆盖正在编辑的选择。
  if (!editor.open) {
    editingPoll = p.id;
    activeDeadline.reset(deadline);
  }

  const stageCountdown = $("stage-countdown");
  if (deadline && p.phase === "open") {
    stageCountdown.hidden = false;
    stageCountdown.classList.toggle("urgent", urgent);
    $("stage-time-left").textContent = title;
    $("stage-deadline-at").textContent = `北京时间 ${beijingTime.format(deadline)} 截止`;
  } else {
    stageCountdown.hidden = true;
  }
}

$("deadline-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!editingPoll || state?.poll?.id !== editingPoll) return;
  try {
    if (await action("deadline", { poll_id: editingPoll, ...activeDeadline.value() })) {
      $("edit-deadline").open = false;
      if (state?.poll) activeDeadline.reset(state.poll.deadline_at_ms);
      showToast("截止时间已更新");
    }
  } catch (error) {
    notice(error.message);
  }
};

/* ==================== 结果文案 & 高清 PNG 导出 ==================== */
function formatResultText(poll) {
  const total = poll.total || 0;
  const maxVotes = Math.max(...(poll.counts || [0]));
  const lines = [
    `【共选投票结果】${poll.title}`,
    `总票数：${total} 票  |  状态：${PHASES[poll.phase] || "已归档"}`,
  ];
  const summary = modeResult(poll);
  if (summary) lines.push(summary);
  lines.push("------------------------------");
  poll.options.forEach((opt, i) => {
    const cnt = poll.counts?.[i] || 0;
    const pct = total ? ((cnt * 100) / total).toFixed(1) : "0.0";
    const mark =
      poll.mode === "quiz" && poll.correct_choice === i
        ? " ✓"
        : total > 0 && cnt === maxVotes
          ? " ★"
          : "";
    lines.push(`${String.fromCharCode(65 + i)}. ${opt}：${cnt} 票（${pct}%）${mark}`);
  });
  return lines.join("\n");
}

function wrapCanvasLines(ctx, text, maxWidth) {
  const lines = [];
  let current = "";
  for (const ch of [...text]) {
    const next = current + ch;
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

async function exportPollImage(poll) {
  if (!poll) return;
  const width = 960;
  const padX = 64;
  const contentW = width - padX * 2;
  const fontBase = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d");
  mctx.font = `700 36px ${fontBase}`;
  const titleLines = wrapCanvasLines(mctx, poll.title, contentW);
  const summaryText = modeResult(poll);

  const rowH = 90;
  const headerH = 140;
  const titleBlockH = titleLines.length * 50 + (summaryText ? 96 : 54);
  const bodyH = poll.options.length * (rowH + 14);
  const footerH = 84;
  const height = headerH + titleBlockH + bodyH + footerH;

  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  ctx.fillStyle = "#f4f7f2";
  ctx.fillRect(0, 0, width, height);

  const headerGrad = ctx.createLinearGradient(0, 0, width, headerH);
  headerGrad.addColorStop(0, "#155f50");
  headerGrad.addColorStop(1, "#0d3f35");
  ctx.fillStyle = headerGrad;
  ctx.fillRect(0, 0, width, headerH);

  drawRoundedRect(ctx, padX, 42, 54, 54, 14);
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 30px ${fontBase}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("共", padX + 27, 70);

  ctx.textAlign = "left";
  ctx.font = `700 24px ${fontBase}`;
  ctx.fillText("共选 · 局域网投票结果", padX + 72, 58);
  ctx.fillStyle = "rgba(232,248,240,0.78)";
  ctx.font = `400 15px ${fontBase}`;
  ctx.fillText(`导出时间：${beijingTime.format(Date.now())}（北京时间）`, padX + 72, 86);

  const total = poll.total || 0;
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 30px ${fontBase}`;
  ctx.fillText(`${total} 票`, width - padX, 60);
  ctx.fillStyle = "rgba(232,248,240,0.78)";
  ctx.font = `400 14px ${fontBase}`;
  ctx.fillText(PHASES[poll.phase] || "历史归档", width - padX, 88);

  let y = headerH + 40;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#143530";
  ctx.font = `700 36px ${fontBase}`;
  for (const line of titleLines) {
    ctx.fillText(line, padX, y);
    y += 50;
  }

  if (summaryText) {
    y += 6;
    drawRoundedRect(ctx, padX, y, contentW, 42, 10);
    ctx.fillStyle = "#e6f3ec";
    ctx.fill();
    ctx.fillStyle = "#134d3e";
    ctx.font = `600 18px ${fontBase}`;
    ctx.textBaseline = "middle";
    ctx.fillText(summaryText, padX + 16, y + 21);
    y += 58;
  } else {
    y += 18;
  }

  const maxVotes = Math.max(...(poll.counts || [0]));
  poll.options.forEach((opt, i) => {
    const cnt = poll.counts?.[i] || 0;
    const pct = total ? (cnt * 100) / total : 0;
    const isCorrect = poll.mode === "quiz" && poll.correct_choice === i;
    const leading = isCorrect || (total > 0 && cnt === maxVotes);

    drawRoundedRect(ctx, padX, y, contentW, rowH, 16);
    ctx.fillStyle = leading ? "#edf7f2" : "#ffffff";
    ctx.fill();
    ctx.strokeStyle = leading ? "#9ecbb6" : "rgba(20,53,48,0.1)";
    ctx.lineWidth = leading ? 2 : 1;
    ctx.stroke();

    drawRoundedRect(ctx, padX + 20, y + 18, 32, 32, 8);
    ctx.fillStyle = leading ? "#145e4f" : "#e5eee7";
    ctx.fill();
    ctx.fillStyle = leading ? "#ffffff" : "#3a5a52";
    ctx.font = `700 17px ${fontBase}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String.fromCharCode(65 + i), padX + 36, y + 35);

    ctx.textAlign = "left";
    ctx.fillStyle = "#143530";
    ctx.font = `600 21px ${fontBase}`;
    ctx.fillText(opt + (isCorrect ? "（正确答案）" : ""), padX + 64, y + 35);

    ctx.textAlign = "right";
    ctx.fillStyle = leading ? "#145e4f" : "#3a5a52";
    ctx.font = `700 20px ${fontBase}`;
    ctx.fillText(
      `${!isCorrect && total > 0 && cnt === maxVotes ? "★ " : ""}${cnt} 票 · ${pct.toFixed(1)}%`,
      padX + contentW - 22,
      y + 35,
    );

    const barX = padX + 20;
    const barY = y + 62;
    const barW = contentW - 40;
    drawRoundedRect(ctx, barX, barY, barW, 12, 6);
    ctx.fillStyle = "#e2ebe4";
    ctx.fill();
    if (pct > 0) {
      drawRoundedRect(ctx, barX, barY, Math.max(12, (barW * pct) / 100), 12, 6);
      ctx.fillStyle = leading ? "#156353" : "#569c7f";
      ctx.fill();
    }
    y += rowH + 14;
  });

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#778a7f";
  ctx.font = `400 14px ${fontBase}`;
  ctx.fillText("由共选局域网投票主持台本地生成 · 数据仅保存在现场电脑", width / 2, height - 38);

  const safeTitle = poll.title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]+/g, "_").slice(0, 20) || "vote";
  const filename = `共选结果_${safeTitle}.png`;
  const dataUrl = canvas.toDataURL("image/png");

  if (window.pywebview?.api?.save_png) {
    try {
      const saved = await window.pywebview.api.save_png(filename, dataUrl);
      if (saved) showToast("结果图片已保存");
    } catch {
      notice("保存结果图片失败，请重试。");
    }
    return;
  }

  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  showToast("已导出结果图片 PNG");
}

/* ==================== 投票历史归档面板 ==================== */
let historyHead;
let historyCount;
let historyBefore = null;
let historyRequest = 0;
const historyDeleteDialog = $("history-delete-dialog");
let historyToDelete = null;

function historyDeleteError(message = "") {
  $("history-delete-error").textContent = message;
  $("history-delete-error").hidden = !message;
}

function confirmHistoryDelete(report) {
  if (!state?.supports_history_delete || busy) return;
  historyToDelete = report.id;
  $("history-delete-detail").textContent =
    `删除「${report.title}」的历史归档？删除后，该场统计无法从历史中查看、复用或下载。`;
  historyDeleteError();
  historyDeleteDialog.showModal();
}

$("history-delete-cancel").onclick = () => historyDeleteDialog.close();
historyDeleteDialog.addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
historyDeleteDialog.onclose = () => { historyToDelete = null; };
$("history-delete-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!historyToDelete || $("history-delete-submit").disabled) return;
  historyDeleteError();
  if (await action("history_delete", {batch_id: historyToDelete}, historyDeleteError)) {
    historyDeleteDialog.close();
    showToast("投票历史已删除");
  }
};

function loadQuestionsIntoEditor(questions) {
  if (!questions?.length) return;
  $("questions").replaceChildren();
  questions.forEach(appendDraftCard);
  numberQuestions();
  preparingNext = true;
  updateButtons();
  $("poll-form").scrollIntoView({ behavior: "smooth", block: "start" });
  showToast(`已载入 ${questions.length} 道题目到新建表单`);
}

function historyEntry(report) {
  const entry = document.createElement("details");
  entry.className = "history-entry";
  entry.dataset.id = report.id;

  const summary = document.createElement("summary");
  const title = document.createElement("strong");
  title.textContent = report.title;
  const meta = document.createElement("small");
  const when =
    report.ended_at_ms === null
      ? `发起于 ${beijingTime.format(report.started_at_ms)}`
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
      const response = await fetch(`/api/history/${report.id}`, { cache: "no-store" });
      if (!response.ok) throw Error();
      const detail = await response.json();
      body.replaceChildren();

      const toolbar = document.createElement("div");
      toolbar.className = "history-toolbar";

      const times = document.createElement("p");
      times.className = "help";
      const end =
        detail.ended_at_ms === null
          ? "旧版未记录结束时间"
          : "结束于 " + beijingTime.format(detail.ended_at_ms);
      times.textContent = `北京时间 · 发起于 ${beijingTime.format(detail.started_at_ms)} · ${end}`;

      const tools = document.createElement("div");
      tools.className = "history-tool-btns";

      const download = document.createElement("a");
      download.className = "mini-tool";
      download.href = `/api/history/${report.id}/csv`;
      download.download = "";
      download.textContent = "下载统计 CSV";
      download.onclick = async (ev) => {
        if (!window.pywebview?.api?.save_csv) return;
        ev.preventDefault();
        try {
          const csvRes = await fetch(download.href, { cache: "no-store" });
          if (!csvRes.ok) throw Error();
          const saved = await window.pywebview.api.save_csv(
            `vote-${report.id}.csv`,
            await csvRes.text(),
          );
          if (saved) showToast("统计 CSV 已保存");
        } catch {
          notice("保存 CSV 失败，请重试。");
        }
      };

      const reuseBtn = document.createElement("button");
      reuseBtn.type = "button";
      reuseBtn.className = "mini-tool";
      reuseBtn.textContent = "复用本场题目";
      reuseBtn.onclick = () => loadQuestionsIntoEditor(detail.questions);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "mini-tool history-delete-button";
      deleteBtn.hidden = !state?.supports_history_delete;
      deleteBtn.textContent = "删除记录";
      deleteBtn.onclick = () => confirmHistoryDelete(report);

      tools.append(download, reuseBtn, deleteBtn);
      toolbar.append(times, tools);
      body.append(toolbar);

      detail.questions.forEach((question, index) => {
        const qHead = document.createElement("div");
        qHead.className = "live-title-row";
        const heading = document.createElement("h3");
        heading.textContent = `${index + 1}. ${question.title}（${question.total} 票）`;
        const pngBtn = document.createElement("button");
        pngBtn.type = "button";
        pngBtn.className = "mini-tool";
        pngBtn.textContent = "导出图片";
        pngBtn.onclick = () => exportPollImage(question);
        qHead.append(heading, pngBtn);
        body.append(qHead);

        const result = modeResult(question);
        if (result) {
          const modeEl = document.createElement("p");
          modeEl.className = "mode-result";
          modeEl.textContent = result;
          body.append(modeEl);
        }

        const list = document.createElement("ul");
        question.options.forEach((option, i) => {
          const row = document.createElement("li");
          const name = document.createElement("span");
          const tally = document.createElement("b");
          name.textContent = `${String.fromCharCode(65 + i)}  ${option}`;
          if (question.mode === "quiz" && question.correct_choice === i) row.dataset.correct = "";
          const percent = question.total ? (question.counts[i] * 100) / question.total : 0;
          tally.textContent = `${question.counts[i]} 票 · ${percent.toFixed(1)}%`;
          row.append(name, tally);
          list.append(row);
        });
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
    const response = await fetch("/api/history" + (before ? `?before=${before}` : ""), {
      cache: "no-store",
    });
    if (!response.ok) throw Error();
    const page = await response.json();
    if (serial !== historyRequest) return;
    const existing = new Map([...list.children].map((row) => [row.dataset.id, row]));
    const rows = page.reports.map((report) => existing.get(report.id) || historyEntry(report));
    if (before) list.append(...rows);
    else list.replaceChildren(...rows);
    historyBefore = page.next_before;
    $("history-more").hidden = historyBefore === null;
    $("history-status").textContent = list.childElementCount
      ? ""
      : "暂无投票历史。收票结束后，统计会自动保存在这里。";
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
$("current-report").onclick = async (event) => {
  event.preventDefault();
  const id = state?.poll?.id;
  const findEntry = () => [...$("history-list").children].find((entry) => entry.dataset.id === id);
  if (!findEntry()) await loadHistory();
  const entry = findEntry();
  if (entry) entry.open = true;
  (entry || $("history")).scrollIntoView({ block: "start" });
};

/* ==================== 实时字库校验 & 题目编辑器 ==================== */
function findUnsupportedChars(texts) {
  if (!coverage.length) return [];
  return [
    ...new Set(
      [...texts.join("")].filter(
        (c) => !coverage.some(([a, b]) => c.codePointAt(0) >= a && c.codePointAt(0) <= b),
      ),
    ),
  ];
}

function checkCardFont(card) {
  const warn = card.querySelector(".card-font-warn");
  if (!warn) return;
  const mode = card.querySelector(".mode-select").value;
  const title = card.querySelector("textarea").value;
  const opts = voteModes[mode]?.options
    ? []
    : [...card.querySelectorAll(".options input")].map((i) => i.value);
  const bad = findUnsupportedChars([title, ...opts]);
  if (!bad.length) {
    warn.hidden = true;
    return;
  }
  warn.hidden = false;
  warn.querySelector(".font-warn-chars").replaceChildren(
    ...bad.slice(0, 12).map((ch) => {
      const chip = document.createElement("span");
      chip.className = "bad-char";
      chip.textContent = ch === " " ? "空格" : ch;
      return chip;
    }),
  );
}

let optionSerial = 0;
function addOption(card, value = "", focus = false) {
  const options = card.querySelector(".options");
  if (options.children.length >= 6) return;
  const row = document.createElement("div");
  row.className = "option";
  row.dataset.choice = String(++optionSerial);

  const letter = document.createElement("span");
  letter.className = "option-letter";

  const wrap = document.createElement("div");
  wrap.className = "option-input-wrap";

  const input = document.createElement("input");
  input.required = true;
  input.maxLength = 24;
  input.value = value;

  const lenTag = document.createElement("span");
  lenTag.className = "option-len";
  lenTag.textContent = `${[...value].length}/24`;

  input.oninput = () => {
    lenTag.textContent = `${[...input.value].length}/24`;
    updateCorrectOptions(card);
    checkCardFont(card);
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      const rows = [...options.children];
      const idx = rows.indexOf(row);
      if (idx === rows.length - 1 && rows.length < 6) {
        addOption(card, "", true);
      } else if (idx < rows.length - 1) {
        rows[idx + 1].querySelector("input").focus();
      }
    }
  };
  wrap.append(input, lenTag);

  const up = document.createElement("button");
  up.type = "button";
  up.className = "option-move";
  up.textContent = "↑";
  up.title = "上移";
  up.onclick = () => {
    if (row.previousElementSibling) {
      options.insertBefore(row, row.previousElementSibling);
      labelOptions(card);
    }
  };

  const down = document.createElement("button");
  down.type = "button";
  down.className = "option-move";
  down.textContent = "↓";
  down.title = "下移";
  down.onclick = () => {
    if (row.nextElementSibling) {
      options.insertBefore(row.nextElementSibling, row);
      labelOptions(card);
    }
  };

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    row.remove();
    labelOptions(card);
    checkCardFont(card);
  });

  row.append(letter, wrap, up, down, remove);
  options.append(row);
  labelOptions(card);
  if (focus) input.focus();
}

function labelOptions(card) {
  const rows = [...card.querySelector(".options").children];
  rows.forEach((row, i) => {
    const label = String.fromCharCode(65 + i);
    const input = row.querySelector("input");
    const moves = row.querySelectorAll(".option-move");
    const remove = row.querySelector(".remove");
    row.querySelector(".option-letter").textContent = label;
    input.placeholder = `选项 ${label}`;
    input.setAttribute("aria-label", `选项 ${label}`);
    moves[0].disabled = i === 0;
    moves[0].setAttribute("aria-label", `上移选项 ${label}`);
    moves[1].disabled = i === rows.length - 1;
    moves[1].setAttribute("aria-label", `下移选项 ${label}`);
    remove.disabled = rows.length <= 2;
    remove.setAttribute("aria-label", `删除选项 ${label}`);
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
    const item = new Option(
      `${String.fromCharCode(65 + i)} · ${value || "待填写"}`,
      row.dataset.choice,
    );
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
  custom.querySelectorAll("input").forEach((input) => {
    input.disabled = custom.hidden;
  });
  const items = (config.options || []).map((label) => {
    const item = document.createElement("li");
    item.textContent = label;
    return item;
  });
  fixed.querySelector("ul").replaceChildren(...items);
  const answer = card.querySelector(".correct-choice");
  answer.parentElement.hidden = mode !== "quiz";
  answer.disabled = mode !== "quiz";
  answer.required = mode === "quiz";
  checkCardFont(card);
}

function fillQuestionCard(card, question) {
  const title = card.querySelector("textarea");
  title.value = question.title || "";
  title.oninput();
  const mode = voteModes[question.mode] ? question.mode : "single";
  card.querySelector(".mode-select").value = mode;
  const options = card.querySelector(".options");
  options.replaceChildren();
  if (!voteModes[mode].options && Array.isArray(question.options)) {
    question.options.slice(0, 6).forEach((option) => addOption(card, option));
  }
  while (options.children.length < 2) addOption(card);
  updateQuestionMode(card);
  const answer = options.children[question.correct_choice];
  if (mode === "quiz" && answer) card.querySelector(".correct-choice").value = answer.dataset.choice;
}

let questionSerial = 0;
function makeQuestionCard(question) {
  const card = $("question-template").content.firstElementChild.cloneNode(true);
  const title = card.querySelector("textarea");
  const label = card.querySelector(".question-label");
  title.id = "question-" + ++questionSerial;
  label.htmlFor = title.id;
  title.oninput = () => {
    label.querySelector("span").textContent = `${[...title.value].length} / 60`;
    checkCardFont(card);
  };
  card.querySelector(".add-option").onclick = () => addOption(card, "", true);
  const mode = card.querySelector(".mode-select");
  const guide = card.querySelector(".mode-guide");
  guide.id = title.id + "-mode-guide";
  mode.setAttribute("aria-describedby", guide.id);
  mode.onchange = () => updateQuestionMode(card);
  card.querySelector(".save-library-draft").onclick = () => {
    try {
      openLibraryEditor(null, readDraft(card, "这道题"));
    } catch (error) {
      notice(error.message);
    }
  };
  fillQuestionCard(card, question || {});
  return card;
}

function appendDraftCard(question) {
  const card = makeQuestionCard(question);
  card.querySelector(".remove-question").onclick = () => {
    if ($("questions").children.length <= 1) return;
    card.remove();
    numberQuestions();
  };
  $("questions").append(card);
  return card;
}

function addQuestion(question) {
  const card = appendDraftCard(question);
  numberQuestions();
  return card.querySelector("textarea");
}

function numberQuestions() {
  [...$("questions").children].forEach((card, i) => {
    card.querySelector("legend").textContent = `第 ${i + 1} 题`;
  });
  updateButtons();
}

let editorRound = null;
let appendBatch = null;
let appendAttempt = null;
let preparingNext = false;

function resetAppend(batchId, question) {
  const card = makeQuestionCard(question);
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
    if (
      active &&
      appendBatch !== poll.id &&
      ![...$("append-question").querySelectorAll("input,textarea")].some((input) =>
        input.value.trim(),
      )
    ) {
      resetAppend(poll.id);
    }
    const appending = active && !preparingNext;
    $("poll-form").hidden = !!appending;
    $("append-form").hidden = !appending;
    $("editor-title").textContent = appending
      ? "向本场追加题目"
      : active
        ? "准备下一场投票"
        : "新建投票";
    $("editor-sub").textContent = appending
      ? "答完前题的投票器会立即收到新题，沿用本场截止时间"
      : "支持单题或一次最多 50 题批量发起，可混用 4 种投票模式";
    $("editor-mode").hidden = !active;
    $("editor-mode").textContent = appending ? "准备下一场投票" : "返回本场追加题目";
    if (active) {
      const stale = appendBatch !== poll.id;
      $("use-append-draft").hidden = !stale;
      $("append-note").textContent = stale
        ? "这份草稿属于上一场。请核对后再用于当前场次。"
        : full
          ? `本场已达到 ${state.max_batch_polls} 题上限。`
          : `新题将排在第 ${count + 1} 题，沿用本场截止时间。答完前题的投票器会立即收到新题。`;
    }
  }
  $("editor-mode").disabled = busy;
  $("use-append-draft").disabled = busy || !active;
  const retry = appendAttempt && state?.batch?.polls.some((q) => q.id === appendAttempt.id);
  $("append-submit").disabled = busy || !active || appendBatch !== poll?.id || (full && !retry);
  const card = $("append-question").firstElementChild;
  if (card) card.disabled = busy;
}

$("editor-mode").onclick = () => {
  preparingNext = !preparingNext;
  updateButtons();
};
$("use-append-draft").onclick = () => {
  if (state?.poll?.phase !== "open") return;
  appendBatch = state.poll.id;
  appendAttempt = null;
  updateButtons();
};

/* ==================== 后端交互 ==================== */
async function action(name, body, onError = notice) {
  if (!state || busy) return false;
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
    const result = await response.json().catch(() => {
      throw Error("未收到主持服务的确认，请保留当前内容后重试。");
    });
    if (!response.ok) throw Error(result.error || "操作未完成，请刷新后重试");
    if ((name === "create" || name === "create_batch") && Number.isInteger(result.pushed_to)) {
      notice(
        result.pushed_to
          ? `已发起，题目已推送至 ${result.pushed_to} 台在线投票器，可立即作答。`
          : "已发起，当前没有在线投票器。设备入场后会自动收到题目。",
        true,
      );
    } else if (name === "append_question") {
      notice(`新题已追加，已同步至 ${result.pushed_to} 台在线投票器。`, true);
    } else if (name !== "alias") {
      notice();
    }
    await refresh();
    return true;
  } catch (error) {
    onError(error instanceof TypeError ? "暂时无法连接主持服务，请保留当前内容后重试。" : error.message);
    return false;
  } finally {
    busy = false;
    updateButtons();
  }
}

function activeLivePoll() {
  const batch = state?.batch?.polls;
  if (!batch) return state?.poll || null;
  return batch.find((q) => q.id === $("live-question").value) || batch[0] || state?.poll || null;
}

function updateButtons() {
  updateEditor();
  $("history-delete-submit").disabled = busy || !state?.supports_history_delete;
  $("history-delete-cancel").disabled = busy;
  document.querySelectorAll(".history-delete-button").forEach((button) => {
    button.hidden = !state?.supports_history_delete;
    button.disabled = busy;
  });
  $("library-open").hidden = !state?.supports_question_library;
  $("library-open").disabled = busy;
  $("library-save").disabled = busy || !state?.supports_question_library;
  document.querySelectorAll(".save-library-draft").forEach((button) => {
    button.hidden = !state?.supports_question_library;
    button.disabled = busy;
  });
  $("device-limit").disabled = !state?.device_limit_max || busy;
  $("save-device-limit").disabled = $("device-limit").disabled;
  document.querySelectorAll(".question-mode").forEach((control) => {
    control.hidden = !state?.supports_modes;
  });
  const p = state?.poll;
  const size = $("questions").children.length;
  $("add-question").disabled = !state || busy || size >= (state.max_batch_polls || 1);
  $("add-question").textContent =
    state?.max_batch_polls && size >= state.max_batch_polls
      ? `已达 ${state.max_batch_polls} 题上限`
      : "＋ 添加题目";
  $("start").textContent = size > 1 ? `一次发起 ${size} 题` : "发起投票";
  $("batch-deadline-note").hidden = size <= 1;
  $("batch-deadline-note").textContent = `所选截止时间适用于这 ${size} 道题。`;
  $("start").disabled = busy || !state || (p && p.phase !== "published");
  $("close").disabled = busy || !p || p.phase !== "open";
  $("publish").disabled = busy || !p || p.phase === "published";
  $("save-deadline").disabled = busy || p?.phase !== "open";
  $("show-result").disabled = busy || !state?.batch || p?.phase !== "published";
  $("stage-close").disabled = $("close").disabled;
  $("stage-publish").disabled = $("publish").disabled;
  $("stage-export").disabled = !p;
  newDeadline.mode.disabled = !state || !state.server_now_ms;
  $("deadline-upgrade").hidden = !state || !!state.server_now_ms;
  $("form-note").textContent =
    p && p.phase !== "published"
      ? "发起下一场前，请先公布本场结果。"
      : "发起后将推送到在线投票器，收票期间可继续追加题目。";
}

/* ==================== 渲染大屏、设备与主界面 ==================== */
function renderStage(p, batch, onlineCount) {
  $("stage-code").textContent = state.join_code;
  $("stage-online").textContent = String(onlineCount);
  $("stage-device-limit").textContent = ` / ${state.max_devices || 10}`;
  const totalShown = batch ? batch.reduce((s, q) => s + q.total, 0) : p?.total || 0;
  $("stage-votes").textContent = String(totalShown);
  $("stage-phase-text").textContent = p ? PHASES[p.phase] : "等待发起";

  $("stage-empty").hidden = !!p;
  $("stage-content").hidden = !p;

  const hasBatch = !!(batch && batch.length > 1);
  $("stage-prev").hidden = !hasBatch;
  $("stage-next").hidden = !hasBatch;
  $("stage-batch-tag").hidden = !hasBatch;
  if (!p) return;

  if (hasBatch) {
    const idx = Math.max(0, batch.findIndex((q) => q.id === p.id));
    $("stage-batch-tag").textContent = `第 ${idx + 1} / ${batch.length} 题`;
  }

  const hideCounts = stageMaskCounts && p.phase !== "published";
  $("stage-toggle-mask").hidden = p.phase === "published";
  $("stage-toggle-mask").textContent = hideCounts ? "显示实时票数" : "隐藏实时票数";
  $("stage-title").textContent = p.title;
  $("stage-subtitle").textContent =
    p.phase === "published"
      ? `最终结果已公布 · 本题共收到 ${p.total} 票`
      : hideCounts
        ? `投票进行中 · 本题已收到 ${p.total} 票（大屏已隐藏实时票数防止干扰）`
        : `投票进行中 · 本题实时收到 ${p.total} 票`;

  const modeSummaryText = hideCounts ? "" : modeResult(p);
  $("stage-mode-result").hidden = !modeSummaryText;
  $("stage-mode-result").textContent = modeSummaryText;

  const maxVotes = Math.max(...(p.counts || [0]));
  const winners = p.counts ? p.counts.filter((c) => c === maxVotes).length : 0;

  $("stage-results").replaceChildren(
    ...p.options.map((option, i) => {
      const cnt = p.counts?.[i] || 0;
      const pct = p.total ? (cnt * 100) / p.total : 0;
      const isCorrect = !hideCounts && p.mode === "quiz" && p.correct_choice === i;
      const leading = isCorrect || (!hideCounts && p.total > 0 && cnt === maxVotes);

      const card = document.createElement("div");
      card.className = `stage-result${leading ? " leading" : ""}`;

      const top = document.createElement("div");
      top.className = "stage-result-top";

      const name = document.createElement("div");
      name.className = "stage-result-name";
      const letter = document.createElement("span");
      letter.className = "stage-letter";
      letter.textContent = String.fromCharCode(65 + i);
      const label = document.createElement("span");
      label.textContent = option;
      name.append(letter, label);

      if (isCorrect) {
        const tag = document.createElement("span");
        tag.className = "correct-tag";
        tag.textContent = "正确答案 ✓";
        name.append(tag);
      } else if (leading && p.phase === "published") {
        const tag = document.createElement("span");
        tag.className = "leader-tag";
        tag.textContent = winners > 1 ? "并列最高" : "得票最高";
        name.append(tag);
      }

      const score = document.createElement("span");
      score.className = "stage-result-score";
      score.textContent = hideCounts ? "收票中…" : `${cnt} 票 · ${pct.toFixed(1)}%`;

      top.append(name, score);

      const track = document.createElement("div");
      track.className = "stage-track";
      const bar = document.createElement("div");
      bar.className = "stage-bar";
      bar.style.width = hideCounts ? "0%" : `${pct}%`;
      track.append(bar);

      card.append(top, track);
      return card;
    }),
  );
}

function renderDevices(batch) {
  $("device-list").replaceChildren(
    ...state.devices.map((d) => {
      const box = document.createElement("div");
      box.className = `device${d.online ? " online" : ""}`;

      const head = document.createElement("div");
      head.className = "device-head";

      const nameWrap = document.createElement("div");
      nameWrap.className = "device-name-wrap";
      const dot = document.createElement("i");
      dot.className = "device-dot";
      dot.setAttribute("aria-hidden", "true");
      const title = document.createElement("strong");
      if (d.alias) {
        title.textContent = d.alias;
      } else {
        title.textContent = d.id.toUpperCase();
        title.className = "mono";
      }
      nameWrap.append(dot, title);

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "device-edit-btn";
      editBtn.title = "设置设备备注名";
      editBtn.setAttribute("aria-label", `备注设备 ${d.id.toUpperCase()}`);
      editBtn.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.2 2.8a1.5 1.5 0 0 1 2.1 2.1L6 12.2 3 13l.8-3 7.4-7.2Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/></svg>';
      editBtn.onclick = () => {
        editingAliasDevice = editingAliasDevice === d.id ? null : d.id;
        renderDevices(batch);
        const field = box.parentElement?.querySelector(".alias-form input");
        if (field) field.focus();
      };
      head.append(nameWrap, editBtn);
      box.append(head);

      if (d.alias) {
        const mac = document.createElement("span");
        mac.className = "device-mac";
        mac.textContent = d.id.toUpperCase();
        box.append(mac);
      }

      if (editingAliasDevice === d.id) {
        const form = document.createElement("form");
        form.className = "alias-form";
        const input = document.createElement("input");
        input.maxLength = 20;
        input.placeholder = "例如：1号评委";
        input.value = d.alias || "";
        const save = document.createElement("button");
        save.type = "submit";
        save.textContent = "存";
        form.onsubmit = async (ev) => {
          ev.preventDefault();
          const ok = await action("alias", { device_id: d.id, alias: input.value });
          if (ok) {
            editingAliasDevice = null;
            showToast(input.value.trim() ? "设备备注已保存" : "已清除设备备注");
            renderDevices(batch);
          }
        };
        input.onkeydown = (ev) => {
          if (ev.key === "Escape") {
            editingAliasDevice = null;
            renderDevices(batch);
          }
        };
        form.append(input, save);
        box.append(form);
      }

      const detail = document.createElement("p");
      const progress = batch
        ? `已答 ${d.answered} / ${batch.length} 题`
        : d.voted
          ? "已投票 ✓"
          : "未投票";
      detail.textContent = `${d.online ? "在线" : "离线"} · ${progress}`;
      detail.className = `device-status${d.voted ? " done" : ""}`;
      box.append(detail);

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
}

function render() {
  if (state.latest_report !== historyHead || state.history_count !== historyCount) {
    historyHead = state.latest_report;
    historyCount = state.history_count;
    loadHistory();
  }
  const batch = state.batch?.polls;
  const picker = $("live-question");
  $("batch-picker").hidden = !batch;
  if (batch && (picker.dataset.batch !== state.batch.id || picker.options.length !== batch.length)) {
    const selected = picker.value;
    picker.replaceChildren(...batch.map((q, i) => new Option(`第 ${i + 1} 题 · ${q.title}`, q.id)));
    if (batch.some((q) => q.id === selected)) picker.value = selected;
    picker.dataset.batch = state.batch.id;
  }

  const p = batch?.find((q) => q.id === picker.value) || state.poll;
  const onlineCount = state.devices.filter((d) => d.online).length;
  const maxDevices = state.max_devices || 10;

  if (state.poll?.id !== lastPollId) {
    lastPollId = state.poll?.id || null;
    if (state.poll && state.poll.phase === "open") stageMaskCounts = true;
  }
  if (state.poll?.phase === "published" && lastPollPhase !== "published") {
    stageMaskCounts = false;
  }
  lastPollPhase = state.poll?.phase || null;

  $("current-report").hidden = !p || p.phase === "open" || state.latest_report !== state.poll.id;
  $("join-code").textContent = state.join_code;
  $("online").textContent = String(onlineCount);
  $("online-sub").textContent = `最多 ${maxDevices} 台`;
  $("online-limit").textContent = ` / ${maxDevices} 台`;
  $("online-bar").style.width = `${Math.min(100, (onlineCount / maxDevices) * 100)}%`;
  $("device-count").textContent = `已登记 ${state.devices.length} / ${maxDevices} 台`;
  $("device-limit-form").hidden = !state.device_limit_max;
  if (state.device_limit_max) {
    $("device-limit").max = state.device_limit_max;
    if (!deviceLimitDirty) $("device-limit").value = maxDevices;
    $("device-limit-help").textContent = `范围 1～${state.device_limit_max} 台。离线设备也占登记名额。`;
  }

  $("votes-label").textContent = batch ? "本组已收票" : "本题已收票";
  const totalVotes = batch ? batch.reduce((sum, q) => sum + q.total, 0) : p?.total || 0;
  $("votes").textContent = String(totalVotes);
  const expectedVotes = batch ? onlineCount * batch.length : onlineCount;
  const denom = Math.max(expectedVotes, totalVotes);
  const turnoutPct = denom ? Math.min(100, Math.round((totalVotes * 100) / denom)) : 0;
  $("votes-bar").style.width = p ? `${turnoutPct}%` : "0%";
  $("turnout-rate").textContent = p
    ? denom
      ? `参与率 ${turnoutPct}%`
      : "等待设备投票"
    : "等待收票";

  $("close").textContent = batch ? "整组截止收票" : "截止收票";
  $("publish").textContent = batch ? "公布整组结果" : "公布结果";
  $("edit-deadline").querySelector("summary").textContent = batch
    ? "调整整组截止时间"
    : "调整截止时间";

  $("phase").textContent = p ? PHASES[p.phase] : "等待发起";
  $("phase-card").dataset.phase = p ? p.phase : "idle";
  $("phase-hint").textContent = p ? PHASE_HINTS[p.phase] : "准备新题目后即可同步发题";
  $("live-badge").textContent = p ? PHASES[p.phase] : "等待开始";
  $("live-badge").classList.toggle("active", p?.phase === "open");
  $("live-sub").textContent =
    p?.phase === "published"
      ? "最终票数已揭晓并同步到全部设备"
      : "收票过程仅主持人可见，公布后同步全员";

  const histCount = state.history_count || 0;
  $("history-count").textContent = String(histCount);
  $("history-count").hidden = histCount === 0;

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
    if (batch) {
      $("result-caption").textContent = `本题已收 ${p.total} 票 · ${$("result-caption").textContent}`;
    }

    const result = modeResult(p);
    $("live-result-summary").hidden = !result;
    $("live-result-summary").textContent = result;

    $("turnout-label").textContent = p.phase === "published" ? "本题最终统计" : "本题参与进度";
    $("turnout-detail").textContent = `${p.total} 票 / ${onlineCount} 台在线`;

    const maxVotes = Math.max(...(p.counts || [0]));
    const winners = p.counts ? p.counts.filter((c) => c === maxVotes).length : 0;

    $("results").replaceChildren(
      ...p.options.map((option, i) => {
        const cnt = p.counts[i];
        const percent = p.total ? (cnt * 100) / p.total : 0;
        const isCorrect = p.mode === "quiz" && p.correct_choice === i;
        const leading = p.total > 0 && cnt === maxVotes;

        const row = document.createElement("div");
        row.className = `result${leading ? " leading" : ""}`;
        if (isCorrect) row.dataset.correct = "";

        const top = document.createElement("div");
        top.className = "result-top";

        const labelBox = document.createElement("div");
        labelBox.className = "result-label";

        const badge = document.createElement("span");
        badge.className = "result-badge";
        badge.textContent = String.fromCharCode(65 + i);

        const title = document.createElement("span");
        title.className = "result-text";
        title.textContent = option;

        labelBox.append(badge, title);
        if (isCorrect) {
          const tag = document.createElement("span");
          tag.className = "correct-tag";
          tag.textContent = "正确答案 ✓";
          labelBox.append(tag);
        } else if (leading) {
          const tag = document.createElement("span");
          tag.className = "leader-tag";
          tag.textContent =
            p.phase === "published" ? (winners > 1 ? "并列最高" : "得票最高") : "领先";
          labelBox.append(tag);
        }

        const count = document.createElement("b");
        count.textContent = `${cnt} 票 · ${percent.toFixed(1)}%`;
        top.append(labelBox, count);

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
  if (!("discovery_available" in state)) {
    discoveryText = "重启新版主持服务即可启用自动发现";
  }
  if (state.discovery_available) {
    discoveryText = "自动发现已开启 · 主持台 " + state.host_id.slice(-8).toUpperCase();
  }
  $("discovery-status").textContent = discoveryText;
  $("discovery-pill").classList.toggle("on", !!state.discovery_available);

  $("server-address").textContent =
    state.addresses.join("  或  ") ||
    `请查看电脑 Wi-Fi 的 IPv4 地址，填写 ws://电脑IP:${state.port}/ws`;

  if (!editingAliasDevice || !state.devices.some((d) => d.id === editingAliasDevice)) {
    editingAliasDevice = null;
    const listState = JSON.stringify([batch?.length || 1, state.devices]);
    if (renderedDevices !== listState) {
      renderDevices(batch);
      renderedDevices = listState;
    }
  }
  renderStage(p, batch, onlineCount);
  updateButtons();
}

/* ==================== 大屏模式切换 ==================== */
function setStageOpen(open) {
  stageOpen = open;
  $("stage-overlay").hidden = !open;
  document.body.style.overflow = open ? "hidden" : "";
  if (open && state) {
    renderStage(
      activeLivePoll(),
      state.batch?.polls,
      state.devices.filter((d) => d.online).length,
    );
  }
  if (window.pywebview?.api?.set_fullscreen) {
    window.pywebview.api.set_fullscreen(open);
  } else if (open && document.documentElement.requestFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else if (!open && document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

function stepBatchQuestion(delta) {
  const batch = state?.batch?.polls;
  if (!batch || batch.length <= 1) return;
  const picker = $("live-question");
  const idx = Math.max(0, batch.findIndex((q) => q.id === picker.value));
  picker.value = batch[(idx + delta + batch.length) % batch.length].id;
  render();
}

/* ==================== 轮询与事件绑定 ==================== */
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
$("live-question").onchange = () => {
  if (state) render();
};
$("show-result").onclick = () => {
  if (state?.batch) {
    action("show_result", { batch_id: state.batch.id, poll_id: $("live-question").value });
  }
};

$("copy-code").onclick = async () => {
  if (!state?.join_code) return;
  if (await copyText(state.join_code, `入场码 ${state.join_code} 已复制`)) {
    $("copy-code-text").textContent = "已复制";
    setTimeout(() => {
      $("copy-code-text").textContent = "复制";
    }, 1800);
  }
};

$("copy-address").onclick = () => {
  const addr = state?.addresses?.[0] || $("server-address").textContent;
  copyText(addr, "局域网地址已复制");
};

$("btn-copy-result").onclick = () => {
  const poll = activeLivePoll();
  if (poll) copyText(formatResultText(poll), "已复制本题投票结果文字");
};
$("btn-export-png").onclick = () => exportPollImage(activeLivePoll());
$("stage-export").onclick = () => exportPollImage(activeLivePoll());

$("btn-stage").onclick = () => setStageOpen(true);
$("stage-exit").onclick = () => setStageOpen(false);
$("stage-prev").onclick = () => stepBatchQuestion(-1);
$("stage-next").onclick = () => stepBatchQuestion(1);
$("stage-toggle-theme").onclick = () => {
  stageLight = !stageLight;
  $("stage-overlay").classList.toggle("light", stageLight);
  $("stage-toggle-theme").textContent = stageLight ? "深色投影" : "浅色展板";
};
$("stage-toggle-mask").onclick = () => {
  stageMaskCounts = !stageMaskCounts;
  if (state) {
    renderStage(
      activeLivePoll(),
      state.batch?.polls,
      state.devices.filter((d) => d.online).length,
    );
  }
};

function readDraft(card, label) {
  const mode = card.querySelector(".mode-select").value;
  if (mode !== "single" && !state?.supports_modes) {
    throw Error("请连接支持投票模式切换的主持服务。");
  }
  const custom = [...card.querySelectorAll(".options .option")];
  const q = {
    title: card.querySelector("textarea").value.trim(),
    options: voteModes[mode].options || custom.map((row) => row.querySelector("input").value.trim()),
  };
  if (state?.supports_modes) q.mode = mode;
  if (!q.title || q.options.some((option) => !option)) throw Error(`请补全${label}的题目和选项。`);
  if (new Set(q.options).size !== q.options.length) throw Error(`${label}有重复选项。`);
  if (coverage.length) {
    const missing = findUnsupportedChars([q.title, ...q.options]);
    if (missing.length) {
      throw Error(`${label}的投票器字库暂不支持：${missing.slice(0, 12).join("")}。`);
    }
  }
  if (mode === "quiz") {
    const answer = card.querySelector(".correct-choice").value;
    q.correct_choice = custom.findIndex((row) => row.dataset.choice === answer);
    if (q.correct_choice < 0) throw Error(`请选择${label}的正确答案。`);
  }
  return q;
}

function newQuestionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const libraryDialog = $("question-library");
let libraryEdit = null;
let libraryRequest = 0;

function libraryStatus(message = "") {
  $("library-status").textContent = message;
  $("library-status").hidden = !message;
}

function hasQuestionDraft(card) {
  return card && (card.querySelector(".mode-select").value !== "single" ||
    [...card.querySelectorAll("textarea, .options input")].some((input) => input.value.trim()));
}

function useLibraryQuestion(question) {
  if (!state || busy) return;
  let title;
  if (!$("append-form").hidden) {
    const poll = state.poll;
    const card = $("append-question").firstElementChild;
    if (poll?.phase !== "open" || (state.batch?.polls.length || 1) >= state.max_batch_polls) {
      libraryStatus("本场无法再追加题目。可切换到「准备下一场投票」后选用。");
      return;
    }
    if (hasQuestionDraft(card) && !window.confirm("替换本场正在编辑的追加题目草稿？")) return;
    resetAppend(poll.id, question);
    title = $("append-question").querySelector("textarea");
    updateButtons();
  } else {
    const emptyCard = [...$("questions").children].find((card) => !hasQuestionDraft(card));
    if (emptyCard) {
      fillQuestionCard(emptyCard, question);
      title = emptyCard.querySelector("textarea");
    } else if (!$("add-question").disabled) {
      title = addQuestion(question);
    } else {
      libraryStatus("新建投票的草稿已满，请腾出一个题目名额后再选用。");
      return;
    }
  }
  libraryDialog.close();
  title.focus();
  showToast("题目已载入投票草稿");
}

function libraryEntry(question) {
  const entry = document.createElement("article");
  const detail = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = question.title;
  const choices = document.createElement("p");
  choices.className = "help";
  choices.textContent = question.options.join(" / ");
  detail.append(heading, choices);
  const actions = document.createElement("div");
  actions.className = "library-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "secondary";
  edit.textContent = "编辑题目";
  edit.onclick = () => openLibraryEditor(question);
  const use = document.createElement("button");
  use.type = "button";
  use.className = "primary";
  use.textContent = "选用题目";
  use.onclick = () => useLibraryQuestion(question);
  actions.append(edit, use);
  entry.append(detail, actions);
  return entry;
}

async function showLibrary(message = "") {
  const request = ++libraryRequest;
  if (!libraryDialog.open) libraryDialog.showModal();
  libraryEdit = null;
  $("library-question").replaceChildren();
  $("library-title").textContent = "本机题库";
  $("library-form").hidden = true;
  $("library-browser").hidden = false;
  $("library-list").replaceChildren();
  libraryDialog.scrollTop = 0;
  libraryStatus("正在读取题库…");
  try {
    const response = await fetch("/api/question_library", {cache: "no-store"});
    if (!response.ok) throw Error();
    const {questions} = await response.json();
    if (!libraryDialog.open || request !== libraryRequest) return;
    $("library-list").replaceChildren(...questions.map(libraryEntry));
    libraryStatus(message || (questions.length ? "" : "还没有保存的题目。点击「新建题目」添加。"));
  } catch {
    if (libraryDialog.open && request === libraryRequest) libraryStatus("题库暂时无法读取，请关闭后重试。");
  }
}

function openLibraryEditor(question, initial = question) {
  libraryRequest++;
  const card = makeQuestionCard(initial);
  card.querySelector(".remove-question").remove();
  card.querySelector(".save-library-draft").remove();
  libraryEdit = question ? {id: question.id, revision: question.revision} : {id: newQuestionId(), revision: null};
  $("library-question").replaceChildren(card);
  $("library-title").textContent = question ? "编辑题库题目" : "新建题库题目";
  $("library-form").hidden = false;
  $("library-browser").hidden = true;
  libraryStatus();
  if (!libraryDialog.open) libraryDialog.showModal();
  libraryDialog.scrollTop = 0;
  updateButtons();
  card.querySelector("textarea").focus();
}

$("library-open").onclick = () => showLibrary();
$("library-new").onclick = () => openLibraryEditor(null);
$("library-back").onclick = () => { if (!busy) showLibrary(); };
$("library-close").onclick = () => { if (!busy) libraryDialog.close(); };
libraryDialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
$("library-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!libraryEdit || $("library-save").disabled) return;
  try {
    const question = readDraft($("library-question").firstElementChild, "这道题");
    if (await action("library_save", {...question, ...libraryEdit}, libraryStatus)) {
      await showLibrary("题目已保存");
    }
  } catch (error) {
    libraryStatus(error.message);
  }
};

addQuestion();

$("poll-form").onsubmit = (event) => {
  event.preventDefault();
  try {
    const questions = [...$("questions").children].map((card, i) =>
      readDraft(card, `第 ${i + 1} 题`),
    );
    const settings = { ...newDeadline.value(), previous_id: state?.poll?.id ?? null };
    if (questions.length === 1) action("create", { ...questions[0], ...settings });
    else if (questions.length <= (state?.max_batch_polls || 1)) {
      action("create_batch", { questions, ...settings });
    } else notice("请连接支持批量发题的主持台。");
  } catch (error) {
    notice(error.message);
  }
};

$("append-form").onsubmit = async (event) => {
  event.preventDefault();
  if ($("append-submit").disabled || appendBatch !== state?.poll?.id) return;
  try {
    const question = readDraft($("append-question").firstElementChild, "追加题目");
    const key = JSON.stringify([appendBatch, question]);
    if (appendAttempt?.key !== key) {
      appendAttempt = {key, id: newQuestionId()};
    }
    const target = appendBatch;
    if (
      (await action("append_question", {
        batch_id: target,
        question_id: appendAttempt.id,
        ...question,
      })) &&
      appendBatch === target
    ) {
      resetAppend(target);
      updateButtons();
    }
  } catch (error) {
    notice(error.message);
  }
};

$("close").onclick = () => action("close", { poll_id: state?.poll?.id });
$("publish").onclick = () => action("publish", { poll_id: state?.poll?.id });
$("device-limit").oninput = () => { deviceLimitDirty = true; };
$("device-limit-form").onsubmit = async (event) => {
  event.preventDefault();
  const limit = $("device-limit").valueAsNumber;
  if (await action("device_limit", { limit })) {
    deviceLimitDirty = false;
    $("device-limit").value = state?.max_devices ?? limit;
    showToast(`已保存设备上限 ${limit} 台`);
  }
};
$("stage-close").onclick = () => action("close", { poll_id: state?.poll?.id });
$("stage-publish").onclick = () => action("publish", { poll_id: state?.poll?.id });

document.addEventListener("keydown", (event) => {
  if (libraryDialog.open || historyDeleteDialog.open) return;
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    if (!stageOpen && !$("poll-form").hidden && !$("start").disabled) {
      event.preventDefault();
      $("poll-form").requestSubmit();
    } else if (!stageOpen && !$("append-form").hidden && !$("append-submit").disabled) {
      event.preventDefault();
      $("append-form").requestSubmit();
    }
    return;
  }
  if (event.key === "Escape" && stageOpen) {
    setStageOpen(false);
    return;
  }
  if (stageOpen && !typing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    stepBatchQuestion(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if (
    !typing &&
    (event.key === "f" || event.key === "F") &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    event.preventDefault();
    setStageOpen(!stageOpen);
  }
});

setInterval(() => {
  if (state?.poll?.phase === "open" && state.poll.deadline_at_ms) {
    renderDeadline(state.poll);
  }
}, 250);

fetch("/font-coverage.json")
  .then((r) => r.json())
  .then((data) => {
    coverage = data.ranges;
    document.querySelectorAll(".draft-question").forEach(checkCardFont);
  })
  .catch(() => notice("字库清单未加载，请刷新页面。"));

async function poll() {
  await refresh();
  setTimeout(poll, 1000);
}
poll();
