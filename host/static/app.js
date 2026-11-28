"use strict";
const $ = (id) => document.getElementById(id);
const pageParams = new URLSearchParams(location.search);
const stageView = pageParams.get("view") === "stage";

let state = null;
let busy = false;
let coverage = [];
let stateAt = 0;
let refreshSequence = 0;
let editingPoll = null;
let editingAliasDevice = null;
let deviceLimitDirty = false;
let renderedDevices = null;
let renderedCustomModesKey = null;
let lastActionResult = null;
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

function getCustomModes() {
  return Array.isArray(state?.custom_modes) ? state.custom_modes : [];
}

function findCustomMode(id) {
  return getCustomModes().find((m) => m.id === id) || null;
}

function describeCustomModeRule(m) {
  if (m.base_kind === "approval") {
    const op = m.pass_op === "gte" ? "达到" : "超过";
    const yesName = m.fixed_options?.[m.yes_index ?? 0] || "赞成项";
    const absName = m.abstain_index != null ? m.fixed_options?.[m.abstain_index] : null;
    const absText = absName ? `（不计「${absName}」）` : "（无弃权项）";
    return `表决 · 「${yesName}」${op} ${m.pass_pct ?? 50}% 通过${absText}`;
  }
  if (m.base_kind === "rating") {
    const unit = m.unit ?? "分";
    const weights = Array.isArray(m.weights) ? m.weights : [];
    const rangeText = weights.length ? `${Math.min(...weights)}～${Math.max(...weights)}${unit}` : "";
    return `加权评分${rangeText ? ` · ${rangeText}` : ""}`;
  }
  if (m.base_kind === "quiz") {
    return m.fixed_options ? `测验 · 预设 ${m.fixed_options.length} 项` : "测验 · 自由选项";
  }
  return m.fixed_options ? `单选 · 预设 ${m.fixed_options.length} 项` : "单选 · 自由选项";
}

function modeResult(poll) {
  const stats = poll.mode_summary;
  const meta = poll.mode_meta || null;
  if (poll.mode === "single") {
    return meta?.name ? `模式 · ${meta.name}` : "";
  }
  if (!stats) return "";
  if (poll.mode === "approval") {
    const label = meta?.name || "表决";
    const hasAbstain = stats.has_abstain !== false;
    const abstainNote = hasAbstain ? "（不计弃权）" : "";
    if (stats.approval_pct === null) {
      return `${label} · 暂无有效表决票`;
    }
    const prefix = stats.passed ? "" : "未";
    const status = poll.phase === "open" ? `当前${prefix}达到通过线` : `${prefix}通过`;
    const thresholdNote =
      stats.pass_pct !== undefined
        ? `（${stats.pass_op === "gte" ? "≥" : ">"}${stats.pass_pct}%）`
        : "";
    const yesName = meta && typeof meta.yes_index === "number" ? poll.options?.[meta.yes_index] : null;
    const rateLabel = yesName && yesName !== "赞成" ? `「${yesName}」占比` : "赞成率";
    return `${label} · ${rateLabel} ${stats.approval_pct.toFixed(1)}%${abstainNote} · ${status}${thresholdNote}`;
  }
  if (poll.mode === "rating") {
    const label = meta?.name || "评分";
    const unit = stats.unit ?? meta?.unit ?? "分";
    const suffix = unit ? ` ${unit}` : "";
    if (stats.average === null) return `${label} · 暂无评分`;
    const totalPart =
      stats.total_score !== undefined && stats.total_score !== null
        ? ` · 总计 ${stats.total_score}${suffix}`
        : "";
    return `${label} · 平均 ${stats.average.toFixed(2)}${suffix}${totalPart}`;
  }
  if (poll.mode === "quiz") {
    const modePrefix = meta?.name ? `${meta.name} · ` : "";
    const answer = `${modePrefix}正确答案 ${String.fromCharCode(65 + poll.correct_choice)} · ${poll.options[poll.correct_choice]}`;
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
  const at = box.querySelector('[name="at"]');
  const durationFields = box.querySelector(".deadline-duration");
  const minutes = durationFields.querySelector('[name="minutes"]');
  const seconds = durationFields.querySelector('[name="seconds"]');

  function selectMode() {
    at.disabled = mode.value !== "custom";
    at.required = !at.disabled;
    at.parentElement.hidden = at.disabled;
    durationFields.hidden = mode.value !== "duration";
    minutes.disabled = durationFields.hidden;
    seconds.disabled = durationFields.hidden;
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
      minutes.value = "";
      seconds.value = "";
      selectMode();
    },
    value() {
      if (mode.value === "manual") return { deadline_at_ms: null };
      if (!state?.server_now_ms) throw Error("请重启新版主持服务后设置定时截止。");
      if (mode.value === "duration") {
        const total =
          (minutes.value ? minutes.valueAsNumber : 0) * 60 +
          (seconds.value ? seconds.valueAsNumber : 0);
        if (!Number.isSafeInteger(total) || total <= 0) {
          throw Error("请输入大于 0 秒的有效时长。");
        }
        return { duration_seconds: total };
      }
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
  editor.querySelector("summary").textContent = deadline ? "调整截止时间" : "设置截止时间";
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

  ctx.fillStyle = "#f5f5f7";
  ctx.fillRect(0, 0, width, height);

  const headerGrad = ctx.createLinearGradient(0, 0, width, headerH);
  headerGrad.addColorStop(0, "#1d1d1f");
  headerGrad.addColorStop(1, "#141416");
  ctx.fillStyle = headerGrad;
  ctx.fillRect(0, 0, width, headerH);

  drawRoundedRect(ctx, padX, 42, 54, 54, 14);
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `600 28px ${fontBase}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("共", padX + 27, 70);

  ctx.textAlign = "left";
  ctx.font = `600 24px ${fontBase}`;
  ctx.fillText("共选 · 局域网投票结果", padX + 72, 58);
  ctx.fillStyle = "rgba(245,245,247,0.68)";
  ctx.font = `400 15px ${fontBase}`;
  ctx.fillText(`导出时间：${beijingTime.format(Date.now())}（北京时间）`, padX + 72, 86);

  const total = poll.total || 0;
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffffff";
  ctx.font = `600 30px ${fontBase}`;
  ctx.fillText(`${total} 票`, width - padX, 60);
  ctx.fillStyle = "rgba(245,245,247,0.68)";
  ctx.font = `400 14px ${fontBase}`;
  ctx.fillText(PHASES[poll.phase] || "历史归档", width - padX, 88);

  let y = headerH + 40;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#1d1d1f";
  ctx.font = `600 36px ${fontBase}`;
  for (const line of titleLines) {
    ctx.fillText(line, padX, y);
    y += 50;
  }

  if (summaryText) {
    y += 6;
    drawRoundedRect(ctx, padX, y, contentW, 42, 12);
    ctx.fillStyle = "rgba(0,113,227,0.09)";
    ctx.fill();
    ctx.fillStyle = "#005bb5";
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
    const accentColor = isCorrect ? "#34c759" : "#0071e3";

    drawRoundedRect(ctx, padX, y, contentW, rowH, 16);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = isCorrect
      ? "rgba(52,199,89,0.45)"
      : leading
        ? "rgba(0,113,227,0.35)"
        : "rgba(0,0,0,0.07)";
    ctx.lineWidth = leading ? 1.5 : 1;
    ctx.stroke();

    drawRoundedRect(ctx, padX + 20, y + 18, 32, 32, 16);
    ctx.fillStyle = leading ? accentColor : "#ededf0";
    ctx.fill();
    ctx.fillStyle = leading ? "#ffffff" : "#6e6e73";
    ctx.font = `600 16px ${fontBase}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String.fromCharCode(65 + i), padX + 36, y + 35);

    ctx.textAlign = "left";
    ctx.fillStyle = "#1d1d1f";
    ctx.font = `600 21px ${fontBase}`;
    ctx.fillText(opt + (isCorrect ? "（正确答案）" : ""), padX + 64, y + 35);

    ctx.textAlign = "right";
    ctx.fillStyle = isCorrect ? "#1b7f37" : leading ? "#0071e3" : "#6e6e73";
    ctx.font = `600 20px ${fontBase}`;
    ctx.fillText(
      `${!isCorrect && total > 0 && cnt === maxVotes ? "★ " : ""}${cnt} 票 · ${pct.toFixed(1)}%`,
      padX + contentW - 22,
      y + 35,
    );

    const barX = padX + 20;
    const barY = y + 63;
    const barW = contentW - 40;
    drawRoundedRect(ctx, barX, barY, barW, 10, 5);
    ctx.fillStyle = "#ebebf0";
    ctx.fill();
    if (pct > 0) {
      drawRoundedRect(ctx, barX, barY, Math.max(10, (barW * pct) / 100), 10, 5);
      ctx.fillStyle = leading ? accentColor : "#8e8e93";
      ctx.fill();
    }
    y += rowH + 14;
  });

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#86868b";
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
historyDeleteDialog.onclose = () => {
  historyToDelete = null;
};
$("history-delete-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!historyToDelete || $("history-delete-submit").disabled) return;
  historyDeleteError();
  if (await action("history_delete", { batch_id: historyToDelete }, historyDeleteError)) {
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
  const rosterText =
    report.roster_summary && report.roster_summary !== "全员参与" ? ` · ${report.roster_summary}` : "";
  meta.textContent = `${when} · ${report.question_count} 题 · ${report.participants} 人参与 · ${report.total_votes} 票${rosterText}`;
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
      const detailRoster =
        detail.roster_summary && detail.roster_summary !== "全员参与" ? ` · ${detail.roster_summary}` : "";
      times.textContent = `北京时间 · 发起于 ${beijingTime.format(detail.started_at_ms)} · ${end}${detailRoster}`;

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

function resolveCardMode(card, rawValue) {
  const value = rawValue ?? card.querySelector(".mode-select").value;
  if (value.startsWith("custom:")) {
    const id = value.slice(7);
    const custom = findCustomMode(id);
    if (custom) {
      return {
        value,
        baseKind: custom.base_kind,
        customId: custom.id,
        customMode: custom,
        modeMeta: null,
        options: custom.fixed_options || null,
        guide: custom.guide || describeCustomModeRule(custom),
      };
    }
  }
  if (value.startsWith("snapshot:") && card._snapshotModeMeta) {
    const snap = card._snapshotModeMeta;
    return {
      value,
      baseKind: snap.base_kind || "single",
      customId: null,
      customMode: null,
      modeMeta: snap,
      options: Array.isArray(card._snapshotOptions) ? card._snapshotOptions : null,
      guide: `已保存的自定义规则「${snap.name}」（原模式已删除，仍可直接发起）`,
    };
  }
  const baseKind = voteModes[value] ? value : "single";
  return {
    value: baseKind,
    baseKind,
    customId: null,
    customMode: null,
    modeMeta: null,
    options: voteModes[baseKind].options || null,
    guide: voteModes[baseKind].guide,
  };
}

function syncModeSelect(select, card) {
  const prev = select.value || "single";
  select.replaceChildren();

  const builtins = [
    ["single", "普通单选"],
    ["approval", "赞成 / 反对 / 弃权"],
    ["rating", "五分评分"],
    ["quiz", "答题测验"],
  ];
  builtins.forEach(([val, label]) => select.add(new Option(label, val)));

  const customs = getCustomModes();
  if (customs.length) {
    const group = document.createElement("optgroup");
    group.label = "我的自定义模式";
    customs.forEach((m) => {
      group.append(new Option(m.name, `custom:${m.id}`));
    });
    select.append(group);
  }

  if (card._snapshotModeMeta) {
    const snap = card._snapshotModeMeta;
    const snapVal = `snapshot:${snap.id}`;
    select.add(new Option(`${snap.name}（已保存规则）`, snapVal));
  }

  if (state?.supports_custom_modes) {
    const manageOpt = new Option("＋ 新建 / 管理自定义模式…", "__manage_custom__");
    select.add(manageOpt);
  }

  const exists = [...select.options].some((o) => o.value === prev && prev !== "__manage_custom__");
  if (exists) {
    select.value = prev;
    if (prev.startsWith("custom:")) {
      updateQuestionMode(card);
    }
  } else {
    select.value = "single";
    updateQuestionMode(card);
  }
}

function syncAllModeSelects() {
  document.querySelectorAll(".draft-question").forEach((card) => {
    const select = card.querySelector(".mode-select");
    if (select) syncModeSelect(select, card);
  });
}

function checkCardFont(card) {
  const warn = card.querySelector(".card-font-warn");
  if (!warn) return;
  const resolved = resolveCardMode(card);
  const title = card.querySelector("textarea").value;
  const opts = resolved.options
    ? resolved.options
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

const MAX_POLL_OPTIONS = 10;
let optionSerial = 0;
function addOption(card, value = "", focus = false) {
  const options = card.querySelector(".options");
  if (options.children.length >= MAX_POLL_OPTIONS) return;
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
      if (idx === rows.length - 1 && rows.length < MAX_POLL_OPTIONS) {
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
  card.querySelector(".add-option").disabled = rows.length >= MAX_POLL_OPTIONS;
  updateCorrectOptions(card);
}

function updateCorrectOptions(card) {
  const select = card.querySelector(".correct-choice");
  const selected = select.value;
  select.replaceChildren(new Option("请选择正确选项", ""));
  const resolved = resolveCardMode(card);
  if (resolved.options) {
    resolved.options.forEach((optText, i) => {
      const item = new Option(`${String.fromCharCode(65 + i)} · ${optText}`, `fixed:${i}`);
      select.add(item);
      if (selected === item.value) select.value = selected;
    });
    return;
  }
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
  const select = card.querySelector(".mode-select");
  if (select.value === "__manage_custom__") {
    select.value = card.dataset.prevMode || "single";
    openCustomModesDialog(card);
    return;
  }
  card.dataset.prevMode = select.value;
  if (!select.value.startsWith("snapshot:")) {
    card._snapshotModeMeta = null;
    card._snapshotOptions = null;
  }

  const resolved = resolveCardMode(card);
  const fixed = card.querySelector(".fixed-options");
  const custom = card.querySelector(".custom-options");
  card.querySelector(".mode-guide").textContent = resolved.guide;
  fixed.hidden = !resolved.options;
  custom.hidden = !!resolved.options;
  custom.querySelectorAll("input").forEach((input) => {
    input.disabled = custom.hidden;
  });
  const cm = resolved.customMode || resolved.modeMeta;
  const items = (resolved.options || []).map((label, idx) => {
    const item = document.createElement("li");
    let display = label;
    if (resolved.baseKind === "rating" && cm?.weights && typeof cm.weights[idx] === "number") {
      const unit = cm.unit ?? "分";
      display = `${label}（${cm.weights[idx]}${unit}）`;
    } else if (resolved.baseKind === "approval" && cm) {
      if (idx === (cm.yes_index ?? 0)) display = `${label}（赞成）`;
      else if (cm.abstain_index != null && idx === cm.abstain_index) display = `${label}（弃权）`;
    }
    item.textContent = display;
    return item;
  });
  fixed.querySelector("ul").replaceChildren(...items);
  const answer = card.querySelector(".correct-choice");
  answer.parentElement.hidden = resolved.baseKind !== "quiz";
  answer.disabled = resolved.baseKind !== "quiz";
  answer.required = resolved.baseKind === "quiz";
  updateCorrectOptions(card);
  checkCardFont(card);
}

function fillQuestionCard(card, question) {
  const title = card.querySelector("textarea");
  title.value = question.title || "";
  title.oninput();

  const select = card.querySelector(".mode-select");
  card._snapshotModeMeta = null;
  card._snapshotOptions = null;

  let targetModeValue = voteModes[question.mode] ? question.mode : "single";
  if (question.mode_meta && typeof question.mode_meta === "object") {
    const existing = question.mode_meta.id ? findCustomMode(question.mode_meta.id) : null;
    if (existing) {
      targetModeValue = `custom:${existing.id}`;
    } else {
      card._snapshotModeMeta = question.mode_meta;
      const needsFixed =
        question.mode_meta.base_kind === "approval" || question.mode_meta.base_kind === "rating";
      card._snapshotOptions = needsFixed && Array.isArray(question.options) ? [...question.options] : null;
      targetModeValue = `snapshot:${question.mode_meta.id || "0000000000000000"}`;
    }
  }

  syncModeSelect(select, card);
  select.value = targetModeValue;
  const resolved = resolveCardMode(card);
  const options = card.querySelector(".options");
  options.replaceChildren();
  if (!resolved.options && Array.isArray(question.options)) {
    question.options.slice(0, MAX_POLL_OPTIONS).forEach((option) => addOption(card, option));
  }
  while (options.children.length < 2) addOption(card);
  updateQuestionMode(card);

  if (resolved.baseKind === "quiz" && Number.isInteger(question.correct_choice)) {
    if (resolved.options) {
      card.querySelector(".correct-choice").value = `fixed:${question.correct_choice}`;
    } else {
      const answer = options.children[question.correct_choice];
      if (answer) card.querySelector(".correct-choice").value = answer.dataset.choice;
    }
  }
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
      : "支持单题或一次最多 50 题批量发起，可混用 4 种内置与自定义模式";
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
    lastActionResult = result;
    if ((name === "create" || name === "create_batch") && Number.isInteger(result.pushed_to)) {
      notice(
        result.pushed_to
          ? `已发起，题目已推送至 ${result.pushed_to} 台在线参与投票器，本轮名单已锁定。`
          : "已发起，当前没有在线的参与投票器。符合本轮资格的设备入场后会自动收到题目。",
        true,
      );
    } else if (name === "append_question") {
      notice(`新题已追加，已同步至 ${result.pushed_to} 台在线参与投票器。`, true);
    } else if (
      name !== "alias" &&
      name !== "roster_config" &&
      name !== "custom_mode_save" &&
      name !== "custom_mode_delete"
    ) {
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
  const p = state?.poll;
  if (stageView) {
    $("stage-close").disabled = busy || p?.phase !== "open";
    $("stage-publish").disabled = busy || !p || p.phase === "published";
    $("stage-export").disabled = !p;
    return;
  }
  updateEditor();
  $("rotate-code-btn").hidden = !state?.supports_rotate_join_code;
  $("rotate-code-btn").disabled = busy || !state?.supports_rotate_join_code;
  if (!state?.supports_rotate_join_code) $("join-code-form").hidden = true;
  $("join-code-save").disabled = busy;
  $("join-code-random").disabled = busy;
  $("history-delete-submit").disabled = busy || !state?.supports_history_delete;
  $("history-delete-cancel").disabled = busy;
  document.querySelectorAll(".history-delete-button").forEach((button) => {
    button.hidden = !state?.supports_history_delete;
    button.disabled = busy;
  });
  $("library-open").hidden = !state?.supports_question_library;
  $("library-open").disabled = busy;
  $("library-save").disabled = busy || !state?.supports_question_library;
  const cmOpenBtn = $("custom-modes-open");
  if (cmOpenBtn) {
    cmOpenBtn.hidden = !state?.supports_custom_modes;
    cmOpenBtn.disabled = busy;
  }
  const cmSaveBtn = $("cm-save");
  if (cmSaveBtn) cmSaveBtn.disabled = busy || !state?.supports_custom_modes;
  document.querySelectorAll(".save-library-draft").forEach((button) => {
    button.hidden = !state?.supports_question_library;
    button.disabled = busy;
  });
  $("open-join-btn").hidden = !state?.supports_open_join;
  $("open-join-btn").disabled = busy || !state?.supports_open_join;
  $("device-limit").disabled = !state?.device_limit_max || busy;
  $("save-device-limit").disabled = $("device-limit").disabled;
  document.querySelectorAll(".question-mode").forEach((control) => {
    control.hidden = !state?.supports_modes;
  });
  const size = $("questions").children.length;
  $("add-question").disabled = !state || busy || size >= (state.max_batch_polls || 1);
  $("add-question").textContent =
    state?.max_batch_polls && size >= state.max_batch_polls
      ? `已达 ${state.max_batch_polls} 题上限`
      : "＋ 添加题目";
  $("start").textContent = size > 1 ? `一次发起 ${size} 题` : "发起投票";
  $("batch-deadline-note").hidden = size <= 1;
  $("batch-deadline-note").textContent = `所选截止时间适用于这 ${size} 道题。`;
  const rosterCheck = evaluateNextRoster();
  $("start").disabled = busy || !state || (p && p.phase !== "published") || !rosterCheck.canStart;
  $("close").disabled = busy || !p || p.phase !== "open";
  $("publish").disabled = busy || !p || p.phase === "published";
  $("save-deadline").disabled = busy || p?.phase !== "open";
  $("show-result").disabled = busy || !state?.batch || p?.phase !== "published";
  newDeadline.mode.disabled = !state || !state.server_now_ms;
  $("deadline-upgrade").hidden = !state || !!state.server_now_ms;
  $("form-note").textContent =
    p && p.phase !== "published"
      ? "发起下一场前，请先公布本场结果。"
      : rosterCheck.canStart
        ? "发题前可在下方「参与设备」调整参与范围，发起后本轮名单即锁定。"
        : rosterCheck.reason;
  renderRosterControls();
}

/* ==================== 参与设备选排控制 ==================== */
function isRosterLocked() {
  return Boolean(state?.poll && state.poll.phase !== "published");
}

function getRosterConfig() {
  return (
    state?.roster || {
      mode: "all",
      device_ids: [],
      allow_late_join: true,
      excluded_see_results: true,
    }
  );
}

function evaluateNextRoster() {
  if (!state?.supports_roster) {
    return { canStart: true, summary: "", reason: "", pill: "全员参与" };
  }
  const cfg = getRosterConfig();
  const devices = state.devices || [];
  const onlineCount = devices.filter((d) => d.online).length;
  const listed = new Set(cfg.device_ids || []);

  if (cfg.mode === "all") {
    return {
      canStart: true,
      pill: "全员参与",
      summary: `参与范围：全员参与（当前 ${onlineCount} 台在线，中途新机自动加入）`,
      reason: "",
    };
  }
  if (cfg.mode === "selected") {
    const selectedDevices = devices.filter((d) => listed.has(d.id));
    const selOnline = selectedDevices.filter((d) => d.online).length;
    const selOffline = selectedDevices.length - selOnline;
    if (selectedDevices.length === 0) {
      return {
        canStart: false,
        pill: "未选设备",
        summary: "参与范围：选中参与（尚未选中任何设备）",
        reason: "当前为「选中参与」模式，请先在下方选中至少 1 台投票器。",
      };
    }
    const offNote = selOffline > 0 ? ` · ${selOffline} 离线` : "";
    return {
      canStart: true,
      pill: `选中 ${selectedDevices.length} 台`,
      summary: `参与范围：仅选中 ${selectedDevices.length} 台参与（${selOnline} 在线${offNote}，中途新机不参与）`,
      reason: "",
    };
  }

  // cfg.mode === "exclude"
  const excludedDevices = devices.filter((d) => listed.has(d.id));
  const eligibleDevices = devices.filter((d) => !listed.has(d.id));
  const elOnline = eligibleDevices.filter((d) => d.online).length;
  if (!cfg.allow_late_join && eligibleDevices.length === 0) {
    return {
      canStart: false,
      pill: "无可用设备",
      summary: "参与范围：排除指定（已排除全部设备且锁定名单）",
      reason: "已排除全部设备且未开启中途新机加入，请取消排除至少 1 台。",
    };
  }
  const lateNote = cfg.allow_late_join ? "允许中途新机加入" : "锁定名单";
  return {
    canStart: true,
    pill: excludedDevices.length ? `排除 ${excludedDevices.length} 台` : "全员参与",
    summary: excludedDevices.length
      ? `参与范围：排除 ${excludedDevices.length} 台，其余 ${eligibleDevices.length} 台参与（${elOnline} 在线 · ${lateNote}）`
      : `参与范围：未排除设备（当前 ${eligibleDevices.length} 台参与 · ${lateNote}）`,
    reason: "",
  };
}

async function saveRosterConfig(next, toastMsg = "") {
  if (!state?.supports_roster || busy || isRosterLocked()) return false;
  const ok = await action("roster_config", next);
  if (ok && toastMsg) showToast(toastMsg);
  return ok;
}

function renderRosterControls() {
  const panel = $("roster-panel");
  const previewBar = $("roster-preview-bar");
  if (!panel || !previewBar) return;
  if (!state?.supports_roster || stageView) {
    panel.hidden = true;
    previewBar.hidden = true;
    return;
  }

  panel.hidden = false;
  const locked = isRosterLocked();
  const cfg = getRosterConfig();
  const activeRoster = state.active_roster;
  const check = evaluateNextRoster();

  previewBar.hidden = locked;
  previewBar.classList.toggle("warn", !check.canStart);
  $("roster-preview-text").textContent = check.canStart ? check.summary : check.reason;
  $("roster-jump-btn").textContent = check.canStart ? "调整范围" : "去选设备";

  panel.classList.toggle("locked", locked);
  const pill = $("roster-summary-pill");
  if (locked && activeRoster) {
    pill.textContent = "本轮已锁定";
    pill.classList.add("active");
  } else {
    pill.textContent = check.pill;
    pill.classList.toggle("active", cfg.mode !== "all");
  }

  const lockedNote = $("roster-locked-note");
  lockedNote.hidden = !locked;
  if (locked && activeRoster) {
    const seeText = activeRoster.excluded_see_results ? "公布结果时旁观机可看结果" : "旁观机全程待命";
    lockedNote.textContent = `本轮名单已锁定：${activeRoster.summary}（${seeText}）。公布结果后可为下一轮调整。`;
  }

  const displayMode = locked && activeRoster ? activeRoster.mode : cfg.mode;
  const ctrlDisabled = busy || locked;
  document.querySelectorAll(".roster-seg-btn").forEach((btn) => {
    const active = btn.dataset.rosterMode === displayMode;
    btn.setAttribute("aria-pressed", String(active));
    btn.disabled = ctrlDisabled;
  });

  const actionsRow = $("roster-actions-row");
  actionsRow.hidden = locked || displayMode === "all";
  const allowLateWrap = $("roster-allow-late-wrap");
  allowLateWrap.hidden = displayMode !== "exclude";

  const hasDevices = (state.devices || []).length > 0;
  const hasOnline = (state.devices || []).some((d) => d.online);
  if (displayMode === "selected") {
    $("roster-quick-primary").textContent = "全选";
    $("roster-quick-online").textContent = "仅选在线";
    $("roster-quick-clear").textContent = "清空";
    $("roster-quick-primary").disabled = ctrlDisabled || !hasDevices;
    $("roster-quick-online").disabled = ctrlDisabled || !hasOnline;
    $("roster-quick-clear").disabled = ctrlDisabled || !(cfg.device_ids || []).length;
  } else if (displayMode === "exclude") {
    $("roster-quick-primary").textContent = "排除离线";
    $("roster-quick-online").textContent = "全部恢复";
    $("roster-quick-clear").textContent = "全选排除";
    const hasOffline = (state.devices || []).some((d) => !d.online);
    $("roster-quick-primary").disabled = ctrlDisabled || !hasOffline;
    $("roster-quick-online").disabled = ctrlDisabled || !(cfg.device_ids || []).length;
    $("roster-quick-clear").disabled = ctrlDisabled || !hasDevices;
  }

  const allowLateInput = $("roster-allow-late");
  allowLateInput.checked = locked && activeRoster ? activeRoster.allow_late_join : cfg.allow_late_join;
  allowLateInput.disabled = ctrlDisabled || displayMode !== "exclude";

  const excludedResInput = $("roster-excluded-results");
  excludedResInput.checked =
    locked && activeRoster ? activeRoster.excluded_see_results : cfg.excluded_see_results;
  excludedResInput.disabled = ctrlDisabled;

  const hint = $("roster-mode-hint");
  if (locked) {
    hint.textContent = "收票与待公布阶段参与名单不可变更";
  } else if (displayMode === "selected") {
    hint.textContent = "仅下方勾选的机器参与本轮，未选与中途新机均旁观";
  } else if (displayMode === "exclude") {
    hint.textContent = "下方标为「已排除」的机器不参与本轮，其余正常投票";
  } else {
    hint.textContent = "所有已入场及中途新连入的机器自动参与；也可直接点单台卡片快速排除";
  }
}

/* ==================== 渲染大屏、设备与主界面 ==================== */
function renderStageDeadline(p) {
  const deadline = p?.deadline_at_ms;
  const countdown = $("stage-countdown");
  countdown.hidden = !deadline || p.phase !== "open";
  if (countdown.hidden) return;
  const remaining = formatRemaining(deadline - hostNow());
  countdown.classList.toggle("urgent", remaining.seconds > 0 && remaining.seconds <= 10);
  $("stage-time-left").textContent = remaining.text;
  $("stage-deadline-at").textContent = `北京时间 ${beijingTime.format(deadline)} 截止`;
}

function renderStage(p, batch, onlineCount) {
  const ar = state.active_roster;
  const filteredStage = Boolean(p && ar && (ar.mode !== "all" || ar.excluded_count > 0));
  $("stage-code").textContent = state.join_code;
  if (filteredStage) {
    $("stage-online-label").textContent = "本轮参与";
    $("stage-online").textContent = String(ar.eligible_online);
    $("stage-device-limit").textContent = ` / ${ar.eligible_total}`;
  } else {
    $("stage-online-label").textContent = "在线设备";
    $("stage-online").textContent = String(onlineCount);
    $("stage-device-limit").textContent = ` / ${state.max_devices || 10}`;
  }
  const totalShown = batch ? batch.reduce((s, q) => s + q.total, 0) : p?.total || 0;
  $("stage-votes").textContent = String(totalShown);
  $("stage-phase-text").textContent = p ? PHASES[p.phase] : "等待发起";

  $("stage-empty").hidden = !!p;
  $("stage-content").hidden = !p;

  const hasBatch = !!(batch && batch.length > 1);
  $("stage-prev").hidden = !hasBatch;
  $("stage-next").hidden = !hasBatch;
  $("stage-batch-tag").hidden = !hasBatch;
  const stageRosterTag = $("stage-roster-tag");
  if (stageRosterTag) {
    stageRosterTag.hidden = !filteredStage;
    if (filteredStage) stageRosterTag.textContent = ar.summary;
  }
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
      if (isCorrect) card.dataset.correct = "";

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
  const supportsRoster = Boolean(state?.supports_roster);
  const locked = isRosterLocked();
  const cfg = getRosterConfig();
  const listed = new Set(cfg.device_ids || []);

  $("device-list").replaceChildren(
    ...state.devices.map((d) => {
      const isExcludedVisual = supportsRoster && !d.eligible;
      const box = document.createElement("div");
      box.className = `device${d.online ? " online" : ""}${isExcludedVisual ? " roster-excluded" : ""}`;

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

      if (supportsRoster) {
        const roleRow = document.createElement("div");
        roleRow.className = "device-role-row";
        const roleBtn = document.createElement("button");
        roleBtn.type = "button";
        roleBtn.className = "device-role-btn";
        const label = d.alias || d.id.toUpperCase();

        if (locked) {
          roleBtn.disabled = true;
          if (d.eligible) {
            roleBtn.classList.add("included");
            roleBtn.textContent = "本轮参与";
          } else {
            roleBtn.classList.add(cfg.mode === "exclude" && listed.has(d.id) ? "explicit-excluded" : "excluded");
            roleBtn.textContent = "本轮旁观";
          }
        } else if (cfg.mode === "selected") {
          const picked = listed.has(d.id);
          roleBtn.disabled = busy;
          roleBtn.classList.add(picked ? "included" : "excluded");
          roleBtn.textContent = picked ? "✓ 已选参与" : "＋ 选中参与";
          roleBtn.title = picked ? "点击取消参与本轮" : "点击选中参与下一轮";
          roleBtn.onclick = () => {
            const nextIds = picked
              ? (cfg.device_ids || []).filter((id) => id !== d.id)
              : [...(cfg.device_ids || []), d.id];
            saveRosterConfig(
              { ...cfg, mode: "selected", device_ids: nextIds },
              picked ? `已取消选中 ${label}` : `已选中 ${label} 参与`,
            );
          };
        } else if (cfg.mode === "exclude") {
          const excluded = listed.has(d.id);
          roleBtn.disabled = busy;
          roleBtn.classList.add(excluded ? "explicit-excluded" : "included");
          roleBtn.textContent = excluded ? "已排除 · 点此恢复" : "✓ 参与 · 点此排除";
          roleBtn.onclick = () => {
            const nextIds = excluded
              ? (cfg.device_ids || []).filter((id) => id !== d.id)
              : [...(cfg.device_ids || []), d.id];
            saveRosterConfig(
              { ...cfg, mode: "exclude", device_ids: nextIds },
              excluded ? `已恢复 ${label} 参与` : `已排除 ${label}`,
            );
          };
        } else {
          roleBtn.disabled = busy;
          roleBtn.classList.add("included");
          roleBtn.textContent = "参与 · 排除此机";
          roleBtn.title = "点击将此机器设为排除（自动切换为「排除指定」模式）";
          roleBtn.onclick = () => {
            saveRosterConfig(
              { ...cfg, mode: "exclude", device_ids: [d.id], allow_late_join: true },
              `已将 ${label} 设为排除（其余机器正常参与）`,
            );
          };
        }
        roleRow.append(roleBtn);
        box.append(roleRow);
      }

      const detail = document.createElement("p");
      const notInCurrentRound = supportsRoster && state?.poll && d.active_eligible === false;
      const progress = notInCurrentRound
        ? "本轮旁观"
        : batch
          ? `已答 ${d.answered} / ${batch.length} 题`
          : d.voted
            ? "已投票 ✓"
            : "未投票";
      detail.textContent = `${d.online ? "在线" : "离线"} · ${progress}`;
      detail.className = `device-status${!notInCurrentRound && d.voted ? " done" : ""}`;
      box.append(detail);

      const foot = document.createElement("div");
      foot.className = "device-actions-foot";
      if (d.online) {
        if (state?.supports_kick || state?.cloud_mode) {
          const kick = document.createElement("button");
          kick.type = "button";
          kick.className = "text-button danger-link";
          kick.textContent = "踢出设备";
          kick.disabled = busy;
          kick.onclick = async () => {
            const label = d.alias || d.id.toUpperCase();
            if (!window.confirm(`确定将「${label}」移出当前会场？移出后设备将立即断开，需更换入场码才能重新加入。`)) {
              return;
            }
            if (await action("kick", { device_id: d.id })) {
              showToast(`已将 ${label} 移出会场`);
            }
          };
          foot.append(kick);
        }
      } else {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "text-button";
        remove.textContent = "移除登记";
        remove.disabled = busy;
        remove.onclick = () => action("forget", { device_id: d.id });
        foot.append(remove);
      }
      if (foot.childElementCount) box.append(foot);
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

const OPEN_JOIN_SECONDS = 300;

function formatOpenJoinCountdown(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function renderOpenJoin() {
  const btn = $("open-join-btn");
  if (!state?.supports_open_join) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const until = state.open_join_until_ms;
  const leftMs = until && state.server_now_ms ? Math.max(0, until - hostNow()) : 0;
  const seconds = Math.ceil(leftMs / 1000);
  const active = seconds > 0;
  btn.classList.toggle("active", active);
  $("open-join-text").textContent = active ? `一键入场 ${formatOpenJoinCountdown(seconds)}` : "一键入场";
  $("session-sub").textContent = active
    ? "一键入场开放中：投票器长按确定即可免输码加入（再点关闭）"
    : "投票器可本机输 4 位码或点一键入场 · 同局域网自动发现";
}

function render() {
  const batch = state.batch?.polls;
  const picker = $("live-question");
  $("batch-picker").hidden = !batch;
  if (batch && (picker.dataset.batch !== state.batch.id || picker.options.length !== batch.length)) {
    const selected = picker.value || (stageView ? pageParams.get("question") : null);
    picker.replaceChildren(...batch.map((q, i) => new Option(`第 ${i + 1} 题 · ${q.title}`, q.id)));
    if (batch.some((q) => q.id === selected)) picker.value = selected;
    picker.dataset.batch = state.batch.id;
  }

  const p = batch?.find((q) => q.id === picker.value) || state.poll;
  const onlineCount = state.devices.filter((d) => d.online).length;

  if (stageView) {
    if (state.poll?.id !== lastPollId && state.poll?.phase === "open") stageMaskCounts = true;
    if (state.poll?.phase === "published" && lastPollPhase !== "published") stageMaskCounts = false;
    lastPollId = state.poll?.id || null;
    lastPollPhase = state.poll?.phase || null;
    renderStage(p, batch, onlineCount);
    renderStageDeadline(state.poll);
    updateButtons();
    return;
  }
  if (state.latest_report !== historyHead || state.history_count !== historyCount) {
    historyHead = state.latest_report;
    historyCount = state.history_count;
    loadHistory();
  }
  $("btn-stage").href = batch && p ? `/?view=stage&question=${encodeURIComponent(p.id)}` : "/?view=stage";

  const maxDevices = state.max_devices || 10;
  $("current-report").hidden = !p || p.phase === "open" || state.latest_report !== state.poll.id;
  $("join-code").textContent = state.join_code;
  renderOpenJoin();
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
  const ar = state.active_roster;
  const fixedTarget = Boolean(ar && (ar.mode === "selected" || !ar.allow_late_join));
  const targetDevices = p && ar ? (fixedTarget ? ar.eligible_total : ar.eligible_online) : onlineCount;
  const expectedVotes = batch ? targetDevices * batch.length : targetDevices;
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
    if (ar && (ar.mode !== "all" || ar.excluded_count > 0)) {
      if (fixedTarget) {
        const offlineNote = ar.eligible_total > ar.eligible_online ? `（${ar.eligible_online} 在线）` : "";
        $("turnout-detail").textContent = `${p.total} 票 / ${ar.eligible_total} 台参与${offlineNote}`;
      } else {
        $("turnout-detail").textContent = `${p.total} 票 / ${ar.eligible_online} 台在线参与 · 排除 ${ar.excluded_count} 台`;
      }
    } else {
      $("turnout-detail").textContent = `${p.total} 票 / ${onlineCount} 台在线`;
    }

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

  const cmKey = JSON.stringify([Boolean(state.supports_custom_modes), state.custom_modes || []]);
  if (renderedCustomModesKey !== cmKey) {
    renderedCustomModesKey = cmKey;
    syncAllModeSelects();
    if (customModesDialog?.open && !$("cm-browser").hidden) {
      renderCustomModesList();
    }
  }

  if (!editingAliasDevice || !state.devices.some((d) => d.id === editingAliasDevice)) {
    editingAliasDevice = null;
    const listState = JSON.stringify([
      batch?.length || 1,
      state.poll?.phase || null,
      state.roster || null,
      state.active_roster || null,
      state.devices,
      busy,
    ]);
    if (renderedDevices !== listState) {
      renderDevices(batch);
      renderedDevices = listState;
    }
  }
  updateButtons();
}

/* ==================== 独立大屏 ==================== */
if (stageView) {
  document.title = "共选 · 现场大屏";
  document.querySelector(".topbar").hidden = true;
  document.querySelector("main").hidden = true;
  $("stage-overlay").hidden = false;
  $("stage-overlay").querySelector(".stage-top").after($("notice"));
  document.addEventListener("fullscreenchange", () => {
    $("stage-fullscreen").textContent = document.fullscreenElement ? "退出全屏" : "全屏";
  });
}

async function toggleStageFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("stage-overlay").requestFullscreen();
  } catch {
    notice("请使用浏览器菜单的全屏功能。");
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

/* ==================== 4 位入场码行内编辑 ==================== */
function setJoinCodeEditorVisible(visible) {
  const form = $("join-code-form");
  form.hidden = !visible;
  if (visible) {
    const input = $("join-code-input");
    input.value = state?.join_code || "";
    input.focus();
    input.select();
  }
}

$("rotate-code-btn").onclick = () => {
  if (!state?.supports_rotate_join_code || busy) return;
  setJoinCodeEditorVisible($("join-code-form").hidden);
};

$("join-code-input").oninput = (event) => {
  const digits = event.target.value.replace(/\D+/g, "").slice(0, 4);
  if (event.target.value !== digits) event.target.value = digits;
};

$("join-code-input").onkeydown = (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    setJoinCodeEditorVisible(false);
  }
};

$("join-code-cancel").onclick = () => setJoinCodeEditorVisible(false);

$("join-code-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!state?.supports_rotate_join_code || busy) return;
  const code = $("join-code-input").value.replace(/\D+/g, "");
  if (code.length !== 4) {
    notice("请输入 4 位纯数字入场码。");
    $("join-code-input").focus();
    return;
  }
  if (code === state.join_code) {
    setJoinCodeEditorVisible(false);
    return;
  }
  if (await action("rotate_join_code", { code })) {
    setJoinCodeEditorVisible(false);
    showToast(`入场码已设为 ${state?.join_code || code}`);
  }
};

$("join-code-random").onclick = async () => {
  if (!state?.supports_rotate_join_code || busy) return;
  if (await action("rotate_join_code", {})) {
    setJoinCodeEditorVisible(false);
    showToast(`已随机切换为新入场码 ${state?.join_code || ""}`);
  }
};

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
    if (stageView) {
      $("stage-phase-text").textContent = "服务已断开 · 正在重连";
      renderStageDeadline(null);
    }
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

$("open-join-btn").onclick = async () => {
  if (!state?.supports_open_join || busy) return;
  const active = state.open_join_until_ms && state.server_now_ms && state.open_join_until_ms > hostNow();
  const seconds = active ? 0 : OPEN_JOIN_SECONDS;
  if (await action("open_join", { seconds })) {
    showToast(seconds ? "已开放 5 分钟一键入场，投票器长按确定可免输码加入" : "已关闭一键入场");
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

$("stage-fullscreen").onclick = toggleStageFullscreen;
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
  const resolved = resolveCardMode(card);
  if (resolved.value !== "single" && !state?.supports_modes) {
    throw Error("请连接支持投票模式切换的主持服务。");
  }
  const customRows = [...card.querySelectorAll(".options .option")];
  const q = {
    title: card.querySelector("textarea").value.trim(),
    options: resolved.options
      ? [...resolved.options]
      : customRows.map((row) => row.querySelector("input").value.trim()),
  };
  if (state?.supports_modes) {
    q.mode = resolved.baseKind;
    if (resolved.customId) q.custom_mode_id = resolved.customId;
    else if (resolved.modeMeta) q.mode_meta = resolved.modeMeta;
  }
  if (!q.title || q.options.some((option) => !option)) throw Error(`请补全${label}的题目和选项。`);
  if (new Set(q.options).size !== q.options.length) throw Error(`${label}有重复选项。`);
  if (coverage.length) {
    const missing = findUnsupportedChars([q.title, ...q.options]);
    if (missing.length) {
      throw Error(`${label}的投票器字库暂不支持：${missing.slice(0, 12).join("")}。`);
    }
  }
  if (resolved.baseKind === "quiz") {
    const answer = card.querySelector(".correct-choice").value;
    if (resolved.options) {
      const idx = answer.startsWith("fixed:") ? Number.parseInt(answer.slice(6), 10) : -1;
      q.correct_choice = Number.isInteger(idx) && idx >= 0 && idx < q.options.length ? idx : -1;
    } else {
      q.correct_choice = customRows.findIndex((row) => row.dataset.choice === answer);
    }
    if (q.correct_choice < 0) throw Error(`请选择${label}的正确答案。`);
  }
  return q;
}

function newQuestionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* ==================== 自定义投票模式管理弹窗 ==================== */
const customModesDialog = $("custom-modes-dialog");
let editingCustomModeId = null;
let pendingModeSelectCard = null;

const CUSTOM_MODE_PRESETS = {
  two_thirds: {
    name: "2/3 多数表决",
    base_kind: "approval",
    guide: "有效表决票中「同意」达到 66.7% 即通过，弃权不计入分母",
    fixed_options: ["同意", "反对", "弃权"],
    yes_index: 0,
    abstain_index: 2,
    pass_op: "gte",
    pass_pct: 66.7,
  },
  satisfaction4: {
    name: "四档满意度",
    base_kind: "rating",
    guide: "按 10 / 7 / 4 / 0 分加权汇总平均满意度",
    fixed_options: ["非常满意", "满意", "一般", "不满意"],
    weights: [10, 7, 4, 0],
    unit: "分",
  },
  score10: {
    name: "十分制打分",
    base_kind: "rating",
    guide: "适合评委快速打分，自动汇总平均分与总分",
    fixed_options: ["10 分", "8 分", "6 分", "4 分", "2 分"],
    weights: [10, 8, 6, 4, 2],
    unit: "分",
  },
  true_false: {
    name: "是非判断",
    base_kind: "quiz",
    guide: "预设「正确 / 错误」两项，出题时直接指定正确答案",
    fixed_options: ["正确", "错误"],
  },
};

function cmStatus(message = "") {
  $("cm-status").textContent = message;
  $("cm-status").hidden = !message;
}

function checkCmFont() {
  const warn = $("cm-font-warn");
  if ($("cm-fixed-section").hidden) {
    warn.hidden = true;
    return;
  }
  const texts = [...$("cm-options").querySelectorAll(".cm-option-text")].map((el) => el.value);
  const bad = findUnsupportedChars(texts);
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

function syncCmApprovalSelects() {
  const rows = [...$("cm-options").children];
  const yesSel = $("cm-yes-index");
  const absSel = $("cm-abstain-index");
  const prevYes = yesSel.value;
  const prevAbs = absSel.value;

  yesSel.replaceChildren();
  absSel.replaceChildren(new Option("无弃权项（全部计入分母）", ""));

  rows.forEach((row, i) => {
    const txt = row.querySelector(".cm-option-text").value.trim() || `选项 ${String.fromCharCode(65 + i)}`;
    const label = `${String.fromCharCode(65 + i)} · ${txt}`;
    yesSel.add(new Option(label, String(i)));
    if (rows.length >= 3) {
      absSel.add(new Option(label, String(i)));
    }
  });

  yesSel.value = [...yesSel.options].some((o) => o.value === prevYes) ? prevYes : "0";
  if (rows.length < 3) {
    absSel.value = "";
    absSel.disabled = true;
  } else {
    absSel.disabled = false;
    [...absSel.options].forEach((opt) => {
      opt.disabled = opt.value !== "" && opt.value === yesSel.value;
    });
    const absValid =
      prevAbs !== "" && prevAbs !== yesSel.value && [...absSel.options].some((o) => o.value === prevAbs);
    absSel.value = absValid ? prevAbs : "";
  }
}

function relabelCmOptions() {
  const rows = [...$("cm-options").children];
  const isRating = $("cm-base-kind").value === "rating";
  const unit = $("cm-unit").value.trim();
  rows.forEach((row, i) => {
    const letter = String.fromCharCode(65 + i);
    row.querySelector(".option-letter").textContent = letter;
    const textInput = row.querySelector(".cm-option-text");
    textInput.placeholder = `预设选项 ${letter}`;
    const weightWrap = row.querySelector(".cm-weight-wrap");
    weightWrap.hidden = !isRating;
    row.querySelector(".cm-weight-input").disabled = !isRating;
    row.querySelector(".cm-weight-unit").textContent = unit;
    row.querySelector(".remove").disabled = rows.length <= 2;
  });
  $("cm-add-option").disabled = rows.length >= MAX_POLL_OPTIONS;
  syncCmApprovalSelects();
  checkCmFont();
}

function addCmOptionRow(text = "", weight = "") {
  const box = $("cm-options");
  if (box.children.length >= MAX_POLL_OPTIONS) return;
  const row = document.createElement("div");
  row.className = "cm-option-row";

  const letter = document.createElement("span");
  letter.className = "option-letter";

  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.className = "cm-option-text";
  textInput.maxLength = 24;
  textInput.value = text;
  textInput.oninput = () => {
    syncCmApprovalSelects();
    checkCmFont();
  };

  const weightWrap = document.createElement("span");
  weightWrap.className = "cm-weight-wrap";
  const weightInput = document.createElement("input");
  weightInput.type = "number";
  weightInput.className = "cm-weight-input";
  weightInput.step = "0.5";
  weightInput.min = "-1000";
  weightInput.max = "1000";
  weightInput.placeholder = "分值";
  weightInput.value = weight === "" || weight === undefined ? String(box.children.length + 1) : String(weight);
  const weightUnit = document.createElement("span");
  weightUnit.className = "cm-weight-unit";
  weightWrap.append(weightInput, weightUnit);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.onclick = () => {
    if (box.children.length <= 2) return;
    row.remove();
    relabelCmOptions();
  };

  row.append(letter, textInput, weightWrap, remove);
  box.append(row);
  relabelCmOptions();
}

function updateCmFormLayout() {
  const kind = $("cm-base-kind").value;
  const requiresFixed = kind === "approval" || kind === "rating";
  $("cm-use-fixed-wrap").hidden = requiresFixed;
  if (requiresFixed) $("cm-use-fixed").checked = true;
  const showFixed = requiresFixed || $("cm-use-fixed").checked;
  $("cm-fixed-section").hidden = !showFixed;
  $("cm-unit-wrap").hidden = kind !== "rating";
  $("cm-approval-rules").hidden = kind !== "approval";
  $("cm-options-hint").textContent =
    kind === "rating"
      ? `2～${MAX_POLL_OPTIONS} 项，为每个选项填入对应分值（支持小数或负分）`
      : `2～${MAX_POLL_OPTIONS} 项，每项最多 24 字（须在投票器字库内）`;
  if (showFixed) {
    while ($("cm-options").children.length < 2) addCmOptionRow();
  }
  relabelCmOptions();
}

function renderCustomModesList() {
  const list = $("cm-list");
  const modes = getCustomModes();
  if (!modes.length) {
    list.replaceChildren();
    cmStatus("还没有保存的自定义模式。点击「＋ 新建模式」或上方快速范本即可创建。");
    return;
  }
  cmStatus("");
  list.replaceChildren(
    ...modes.map((m) => {
      const item = document.createElement("article");
      item.className = "cm-item";

      const main = document.createElement("div");
      main.className = "cm-item-main";

      const head = document.createElement("div");
      head.className = "cm-item-head";
      const h3 = document.createElement("h3");
      h3.textContent = m.name;
      const tag = document.createElement("span");
      tag.className = "cm-item-tag";
      tag.textContent = describeCustomModeRule(m);
      head.append(h3, tag);

      const meta = document.createElement("p");
      meta.className = "cm-item-meta";
      if (m.fixed_options) {
        const optsText = m.fixed_options
          .map((opt, idx) =>
            m.base_kind === "rating" && Array.isArray(m.weights)
              ? `${opt}(${m.weights[idx]}${m.unit ?? "分"})`
              : opt,
          )
          .join(" / ");
        meta.textContent = `选项：${optsText}${m.guide ? ` · ${m.guide}` : ""}`;
      } else {
        meta.textContent = m.guide || `出题时自由填写 2～${MAX_POLL_OPTIONS} 个选项`;
      }
      main.append(head, meta);

      const actions = document.createElement("div");
      actions.className = "cm-item-actions";

      if (pendingModeSelectCard) {
        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.className = "primary";
        useBtn.textContent = "选用";
        useBtn.onclick = () => {
          const card = pendingModeSelectCard;
          pendingModeSelectCard = null;
          customModesDialog.close();
          if (card && card.isConnected) {
            const sel = card.querySelector(".mode-select");
            syncModeSelect(sel, card);
            sel.value = `custom:${m.id}`;
            updateQuestionMode(card);
            showToast(`已切换为「${m.name}」`);
          }
        };
        actions.append(useBtn);
      }

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "secondary";
      editBtn.textContent = "编辑";
      editBtn.onclick = () => openCustomModeEditor(m);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "mini-tool history-delete-button";
      delBtn.textContent = "删除";
      delBtn.onclick = async () => {
        if (!window.confirm(`确定删除自定义模式「${m.name}」？已保存的历史记录与题库中的旧题不受影响。`)) {
          return;
        }
        if (await action("custom_mode_delete", { id: m.id }, cmStatus)) {
          showToast(`已删除模式「${m.name}」`);
          renderCustomModesList();
        }
      };

      actions.append(editBtn, delBtn);
      item.append(main, actions);
      return item;
    }),
  );
}

function showCustomModesBrowser() {
  editingCustomModeId = null;
  $("cm-dialog-title").textContent = "自定义投票模式";
  $("cm-browser").hidden = false;
  $("cm-form").hidden = true;
  renderCustomModesList();
}

function openCustomModeEditor(initial = null) {
  editingCustomModeId = initial?.id || null;
  $("cm-dialog-title").textContent = editingCustomModeId ? "编辑自定义模式" : "新建自定义投票模式";
  $("cm-browser").hidden = true;
  $("cm-form").hidden = false;
  cmStatus();

  $("cm-name").value = initial?.name || "";
  $("cm-base-kind").value = initial?.base_kind || "approval";
  $("cm-guide").value = initial?.guide || "";
  $("cm-unit").value = initial?.unit !== undefined ? initial.unit : "分";

  const hasFixed = initial ? Array.isArray(initial.fixed_options) : true;
  $("cm-use-fixed").checked = hasFixed;

  $("cm-options").replaceChildren();
  const seedOptions = Array.isArray(initial?.fixed_options)
    ? initial.fixed_options
    : initial
      ? ["选项一", "选项二"]
      : ["同意", "反对", "弃权"];
  const seedWeights = Array.isArray(initial?.weights) ? initial.weights : [];
  seedOptions.forEach((opt, i) => addCmOptionRow(opt, seedWeights[i] !== undefined ? seedWeights[i] : i + 1));

  updateCmFormLayout();
  if ($("cm-base-kind").value === "approval") {
    $("cm-yes-index").value = String(initial?.yes_index ?? 0);
    syncCmApprovalSelects();
    $("cm-abstain-index").value = initial?.abstain_index != null ? String(initial.abstain_index) : "";
    $("cm-pass-op").value = initial?.pass_op === "gte" ? "gte" : "gt";
    $("cm-pass-pct").value = String(initial?.pass_pct ?? 50);
  }
  $("cm-name").focus();
}

function openCustomModesDialog(forCard = null) {
  pendingModeSelectCard = forCard;
  showCustomModesBrowser();
  if (!customModesDialog.open) customModesDialog.showModal();
  customModesDialog.scrollTop = 0;
}

$("custom-modes-open").onclick = () => openCustomModesDialog(null);
$("cm-close").onclick = () => {
  if (!busy) customModesDialog.close();
};
customModesDialog.addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
customModesDialog.onclose = () => {
  pendingModeSelectCard = null;
};
$("cm-new").onclick = () => openCustomModeEditor(null);
$("cm-back").onclick = () => {
  if (!busy) showCustomModesBrowser();
};
document.querySelectorAll(".cm-preset-btn").forEach((btn) => {
  btn.onclick = () => {
    const preset = CUSTOM_MODE_PRESETS[btn.dataset.preset];
    if (preset) openCustomModeEditor(preset);
  };
});
$("cm-base-kind").onchange = updateCmFormLayout;
$("cm-use-fixed").onchange = updateCmFormLayout;
$("cm-unit").oninput = relabelCmOptions;
$("cm-yes-index").onchange = syncCmApprovalSelects;
$("cm-add-option").onclick = () => {
  addCmOptionRow("", $("cm-options").children.length + 1);
  const inputs = $("cm-options").querySelectorAll(".cm-option-text");
  inputs[inputs.length - 1]?.focus();
};
document.querySelectorAll(".cm-pct-chip").forEach((chip) => {
  chip.onclick = () => {
    $("cm-pass-op").value = chip.dataset.op;
    $("cm-pass-pct").value = chip.dataset.pct;
  };
});

$("cm-form").onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  cmStatus();
  const kind = $("cm-base-kind").value;
  const requiresFixed = kind === "approval" || kind === "rating";
  const useFixed = requiresFixed || $("cm-use-fixed").checked;
  const payload = {
    ...(editingCustomModeId ? { id: editingCustomModeId } : {}),
    name: $("cm-name").value.trim(),
    guide: $("cm-guide").value.trim(),
    base_kind: kind,
    fixed_options: null,
  };
  if (useFixed) {
    const rows = [...$("cm-options").children];
    const options = rows.map((r) => r.querySelector(".cm-option-text").value.trim());
    if (options.some((o) => !o)) {
      cmStatus("请填写完整的预设选项内容。");
      return;
    }
    if (new Set(options).size !== options.length) {
      cmStatus("预设选项不能重复。");
      return;
    }
    if (coverage.length) {
      const missing = findUnsupportedChars(options);
      if (missing.length) {
        cmStatus(`投票器字库暂不支持：${missing.slice(0, 12).join("")}。`);
        return;
      }
    }
    payload.fixed_options = options;
    if (kind === "approval") {
      payload.yes_index = Number.parseInt($("cm-yes-index").value, 10);
      const absRaw = $("cm-abstain-index").value;
      payload.abstain_index = absRaw === "" ? null : Number.parseInt(absRaw, 10);
      payload.pass_op = $("cm-pass-op").value;
      payload.pass_pct = Number($("cm-pass-pct").value);
    } else if (kind === "rating") {
      const weights = rows.map((r) => Number(r.querySelector(".cm-weight-input").value));
      if (weights.some((w) => !Number.isFinite(w))) {
        cmStatus("请为每个选项填写有效的数字分值。");
        return;
      }
      payload.weights = weights;
      payload.unit = $("cm-unit").value.trim();
    }
  }

  const wasEdit = Boolean(editingCustomModeId);
  if (await action("custom_mode_save", payload, cmStatus)) {
    const savedId = lastActionResult?.mode_id || editingCustomModeId;
    showToast(wasEdit ? `已更新模式「${payload.name}」` : `已保存模式「${payload.name}」`);
    if (pendingModeSelectCard && pendingModeSelectCard.isConnected && savedId) {
      const card = pendingModeSelectCard;
      pendingModeSelectCard = null;
      customModesDialog.close();
      const sel = card.querySelector(".mode-select");
      syncModeSelect(sel, card);
      sel.value = `custom:${savedId}`;
      updateQuestionMode(card);
    } else {
      showCustomModesBrowser();
    }
  }
};

/* ==================== 本机题库弹窗 ==================== */
const libraryDialog = $("question-library");
let libraryEdit = null;
let libraryRequest = 0;

function libraryStatus(message = "") {
  $("library-status").textContent = message;
  $("library-status").hidden = !message;
}

function hasQuestionDraft(card) {
  return (
    card &&
    (card.querySelector(".mode-select").value !== "single" ||
      [...card.querySelectorAll("textarea, .options input")].some((input) => input.value.trim()))
  );
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
    const response = await fetch("/api/question_library", { cache: "no-store" });
    if (!response.ok) throw Error();
    const { questions } = await response.json();
    if (!libraryDialog.open || request !== libraryRequest) return;
    $("library-list").replaceChildren(...questions.map(libraryEntry));
    libraryStatus(message || (questions.length ? "" : "还没有保存的题目。点击「新建题目」添加。"));
  } catch {
    if (libraryDialog.open && request === libraryRequest) {
      libraryStatus("题库暂时无法读取，请关闭后重试。");
    }
  }
}

function openLibraryEditor(question, initial = question) {
  libraryRequest++;
  const card = makeQuestionCard(initial);
  card.querySelector(".remove-question").remove();
  card.querySelector(".save-library-draft").remove();
  libraryEdit = question
    ? { id: question.id, revision: question.revision }
    : { id: newQuestionId(), revision: null };
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
$("library-back").onclick = () => {
  if (!busy) showLibrary();
};
$("library-close").onclick = () => {
  if (!busy) libraryDialog.close();
};
libraryDialog.addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
$("library-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!libraryEdit || $("library-save").disabled) return;
  try {
    const question = readDraft($("library-question").firstElementChild, "这道题");
    if (await action("library_save", { ...question, ...libraryEdit }, libraryStatus)) {
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
    const rosterCheck = evaluateNextRoster();
    if (!rosterCheck.canStart) {
      throw Error(rosterCheck.reason || "请先选择参与投票的设备。");
    }
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
      appendAttempt = { key, id: newQuestionId() };
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
$("device-limit").oninput = () => {
  deviceLimitDirty = true;
};
$("device-limit-form").onsubmit = async (event) => {
  event.preventDefault();
  const limit = $("device-limit").valueAsNumber;
  if (await action("device_limit", { limit })) {
    deviceLimitDirty = false;
    $("device-limit").value = state?.max_devices ?? limit;
    showToast(`已保存设备上限 ${limit} 台`);
  }
};

$("roster-jump-btn").onclick = () => {
  const target = $("roster-panel") || $("panel-devices");
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
};

document.querySelectorAll(".roster-seg-btn").forEach((btn) => {
  btn.onclick = () => {
    const mode = btn.dataset.rosterMode;
    const cfg = getRosterConfig();
    if (!mode || mode === cfg.mode || isRosterLocked() || busy) return;
    if (mode === "all") {
      saveRosterConfig(
        { mode: "all", device_ids: [], allow_late_join: true, excluded_see_results: cfg.excluded_see_results },
        "已切换为全员参与",
      );
    } else if (mode === "selected") {
      saveRosterConfig(
        { mode: "selected", device_ids: [], allow_late_join: false, excluded_see_results: cfg.excluded_see_results },
        "已切换为选中参与，请在下方勾选参与设备",
      );
    } else if (mode === "exclude") {
      saveRosterConfig(
        {
          mode: "exclude",
          device_ids: [],
          allow_late_join: true,
          excluded_see_results: cfg.excluded_see_results,
        },
        "已切换为排除指定，点击下方设备即可排除",
      );
    }
  };
});

$("roster-quick-primary").onclick = () => {
  const cfg = getRosterConfig();
  if (isRosterLocked() || busy) return;
  if (cfg.mode === "selected") {
    const allIds = (state?.devices || []).map((d) => d.id);
    saveRosterConfig({ ...cfg, mode: "selected", device_ids: allIds }, `已全选 ${allIds.length} 台设备`);
  } else if (cfg.mode === "exclude") {
    const offlineIds = (state?.devices || []).filter((d) => !d.online).map((d) => d.id);
    saveRosterConfig({ ...cfg, mode: "exclude", device_ids: offlineIds }, `已排除 ${offlineIds.length} 台离线设备`);
  }
};

$("roster-quick-online").onclick = () => {
  const cfg = getRosterConfig();
  if (isRosterLocked() || busy) return;
  if (cfg.mode === "selected") {
    const onlineIds = (state?.devices || []).filter((d) => d.online).map((d) => d.id);
    saveRosterConfig({ ...cfg, mode: "selected", device_ids: onlineIds }, `已选中 ${onlineIds.length} 台在线设备`);
  } else if (cfg.mode === "exclude") {
    saveRosterConfig({ ...cfg, mode: "exclude", device_ids: [] }, "已恢复全部设备参与");
  }
};

$("roster-quick-clear").onclick = () => {
  const cfg = getRosterConfig();
  if (isRosterLocked() || busy) return;
  if (cfg.mode === "selected") {
    saveRosterConfig({ ...cfg, mode: "selected", device_ids: [] }, "已清空选中设备");
  } else if (cfg.mode === "exclude") {
    const allIds = (state?.devices || []).map((d) => d.id);
    saveRosterConfig({ ...cfg, mode: "exclude", device_ids: allIds }, `已排除全部 ${allIds.length} 台设备`);
  }
};

$("roster-allow-late").onchange = (event) => {
  const cfg = getRosterConfig();
  if (isRosterLocked() || busy || cfg.mode !== "exclude") return;
  const allow = Boolean(event.target.checked);
  saveRosterConfig(
    { ...cfg, allow_late_join: allow },
    allow ? "已开启：中途新机自动参与" : "已锁定：中途新机不参与本轮",
  );
};

$("roster-excluded-results").onchange = (event) => {
  const cfg = getRosterConfig();
  if (isRosterLocked() || busy) return;
  const allowSee = Boolean(event.target.checked);
  saveRosterConfig(
    { ...cfg, excluded_see_results: allowSee },
    allowSee ? "公布结果时未参与设备也可查看" : "公布结果时未参与设备保持待命",
  );
};

$("stage-close").onclick = () => action("close", { poll_id: state?.poll?.id });
$("stage-publish").onclick = () => action("publish", { poll_id: state?.poll?.id });

document.addEventListener("keydown", (event) => {
  if (libraryDialog.open || customModesDialog.open || historyDeleteDialog.open) return;
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    if (!stageView && !$("poll-form").hidden && !$("start").disabled) {
      event.preventDefault();
      $("poll-form").requestSubmit();
    } else if (!stageView && !$("append-form").hidden && !$("append-submit").disabled) {
      event.preventDefault();
      $("append-form").requestSubmit();
    }
    return;
  }
  if (stageView && !typing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
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
    if (stageView) toggleStageFullscreen();
    else $("btn-stage").click();
  }
});

setInterval(() => {
  if (state?.poll?.phase === "open" && state.poll.deadline_at_ms) {
    if (stageView) renderStageDeadline(state.poll);
    else renderDeadline(state.poll);
  }
  if (state?.supports_open_join && state.open_join_until_ms) {
    renderOpenJoin();
  }
}, 250);

if (!stageView) {
  fetch("/font-coverage.json")
    .then((r) => r.json())
    .then((data) => {
      coverage = data.ranges;
      document.querySelectorAll(".draft-question").forEach(checkCardFont);
    })
    .catch(() => notice("字库清单未加载，请刷新页面。"));
}

async function poll() {
  await refresh();
  setTimeout(poll, 1000);
}
poll();
