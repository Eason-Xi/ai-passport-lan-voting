"use strict";
const $ = (id) => document.getElementById(id);

let state = null;
let busy = false;
let coverage = [];
let stateAt = 0;
let refreshSequence = 0;
let editingPoll = null;
let editingAliasDevice = null;
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

const PRESETS = {
  agree: {
    options: ["赞成", "反对", "弃权"],
  },
  satisfy: {
    options: ["非常满意", "比较满意", "一般", "不太满意"],
  },
  yesno: {
    options: ["是", "否"],
  },
};

const beijingTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  dateStyle: "medium",
  timeStyle: "medium",
  hourCycle: "h23",
});

const beijingShort = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

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

function notice(message = "") {
  $("notice").textContent = message;
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

/* ==================== 桌面端桥接自动检测 ==================== */
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
  if (!editor.open) {
    editingPoll = p.id;
    activeDeadline.reset(deadline);
  }

  // 同步到大屏倒计时
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

/* ==================== 实时字库校验 & 选项编辑 ==================== */
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

function checkLiveFontCoverage() {
  const title = $("question").value;
  const options = [...$("options").querySelectorAll("input")].map((i) => i.value);
  const bad = findUnsupportedChars([title, ...options]);
  const warn = $("font-warn");
  if (!bad.length) {
    warn.hidden = true;
    return;
  }
  warn.hidden = false;
  $("font-warn-chars").replaceChildren(
    ...bad.slice(0, 12).map((ch) => {
      const chip = document.createElement("span");
      chip.className = "bad-char";
      chip.textContent = ch === " " ? "空格" : ch;
      return chip;
    }),
  );
}

function addOption(value = "", focus = false) {
  if ($("options").children.length >= 6) return;
  const row = document.createElement("div");
  row.className = "option";

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

  input.addEventListener("input", () => {
    lenTag.textContent = `${[...input.value].length}/24`;
    checkLiveFontCoverage();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      const rows = [...$("options").children];
      const idx = rows.indexOf(row);
      if (idx === rows.length - 1 && rows.length < 6) {
        addOption("", true);
      } else if (idx < rows.length - 1) {
        rows[idx + 1].querySelector("input").focus();
      }
    }
  });
  wrap.append(input, lenTag);

  const up = document.createElement("button");
  up.type = "button";
  up.className = "option-move";
  up.textContent = "↑";
  up.title = "上移";
  up.addEventListener("click", () => {
    if (row.previousElementSibling) {
      row.parentNode.insertBefore(row, row.previousElementSibling);
      labelOptions();
    }
  });

  const down = document.createElement("button");
  down.type = "button";
  down.className = "option-move";
  down.textContent = "↓";
  down.title = "下移";
  down.addEventListener("click", () => {
    if (row.nextElementSibling) {
      row.parentNode.insertBefore(row.nextElementSibling, row);
      labelOptions();
    }
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    row.remove();
    labelOptions();
    checkLiveFontCoverage();
  });

  row.append(letter, wrap, up, down, remove);
  $("options").append(row);
  labelOptions();
  if (focus) input.focus();
}

function setOptions(list) {
  $("options").replaceChildren();
  list.slice(0, 6).forEach((text) => addOption(text));
  while ($("options").children.length < 2) addOption("");
  checkLiveFontCoverage();
}

function labelOptions() {
  const rows = [...$("options").children];
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
  $("add-option").disabled = rows.length >= 6;
}

/* ==================== 网络操作 ==================== */
async function action(name, body) {
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
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "操作未完成，请刷新后重试");
    notice();
    await refresh();
    return true;
  } catch (error) {
    notice(error.message);
    return false;
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
  $("stage-close").disabled = $("close").disabled;
  $("stage-publish").disabled = $("publish").disabled;
  $("stage-export").disabled = !p;
  newDeadline.mode.disabled = !state || !state.server_now_ms;
  $("deadline-upgrade").hidden = !state || !!state.server_now_ms;
  $("form-note").textContent =
    p && p.phase !== "published"
      ? "请先公布当前题目结果，再发起新题。"
      : "发起后，题目将同步到所有在线投票器（快捷键 ⌘/Ctrl + Enter）。";
}

/* ==================== 结果文案 & 高清 PNG 导出 ==================== */
function formatResultText(poll) {
  const total = poll.total || 0;
  const maxVotes = Math.max(...(poll.counts || [0]));
  const lines = [
    `【共选投票结果】${poll.title}`,
    `总票数：${total} 票  |  状态：${PHASES[poll.phase] || poll.phase}`,
    "------------------------------",
  ];
  poll.options.forEach((opt, i) => {
    const cnt = poll.counts?.[i] || 0;
    const pct = total ? ((cnt * 100) / total).toFixed(1) : "0.0";
    const crown = total > 0 && cnt === maxVotes ? " ★" : "";
    lines.push(`${String.fromCharCode(65 + i)}. ${opt}：${cnt} 票（${pct}%）${crown}`);
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

  const rowH = 90;
  const headerH = 140;
  const titleBlockH = titleLines.length * 50 + 58;
  const bodyH = poll.options.length * (rowH + 14);
  const footerH = 84;
  const height = headerH + titleBlockH + bodyH + footerH;

  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  // 背景
  ctx.fillStyle = "#f4f7f2";
  ctx.fillRect(0, 0, width, height);

  // 顶部松翠色带
  const headerGrad = ctx.createLinearGradient(0, 0, width, headerH);
  headerGrad.addColorStop(0, "#155f50");
  headerGrad.addColorStop(1, "#0d3f35");
  ctx.fillStyle = headerGrad;
  ctx.fillRect(0, 0, width, headerH);

  // 品牌章
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
  const stamp = beijingTime.format(Date.now());
  ctx.fillText(`导出时间：${stamp}（北京时间）`, padX + 72, 86);

  // 总票数徽章
  const total = poll.total || 0;
  ctx.textAlign = "right";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 30px ${fontBase}`;
  ctx.fillText(`${total} 票`, width - padX, 60);
  ctx.fillStyle = "rgba(232,248,240,0.78)";
  ctx.font = `400 14px ${fontBase}`;
  ctx.fillText(PHASES[poll.phase] || "投票统计", width - padX, 88);

  // 题目区
  let y = headerH + 44;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#143530";
  ctx.font = `700 36px ${fontBase}`;
  for (const line of titleLines) {
    ctx.fillText(line, padX, y);
    y += 50;
  }
  y += 20;

  const maxVotes = Math.max(...(poll.counts || [0]));
  poll.options.forEach((opt, i) => {
    const cnt = poll.counts?.[i] || 0;
    const pct = total ? (cnt * 100) / total : 0;
    const leading = total > 0 && cnt === maxVotes;

    drawRoundedRect(ctx, padX, y, contentW, rowH, 16);
    ctx.fillStyle = leading ? "#edf7f2" : "#ffffff";
    ctx.fill();
    ctx.strokeStyle = leading ? "#9ecbb6" : "rgba(20,53,48,0.1)";
    ctx.lineWidth = leading ? 2 : 1;
    ctx.stroke();

    // 字母
    drawRoundedRect(ctx, padX + 20, y + 18, 32, 32, 8);
    ctx.fillStyle = leading ? "#145e4f" : "#e5eee7";
    ctx.fill();
    ctx.fillStyle = leading ? "#ffffff" : "#3a5a52";
    ctx.font = `700 17px ${fontBase}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String.fromCharCode(65 + i), padX + 36, y + 35);

    // 选项文字
    ctx.textAlign = "left";
    ctx.fillStyle = "#143530";
    ctx.font = `600 21px ${fontBase}`;
    ctx.fillText(opt, padX + 64, y + 35);

    // 票数
    ctx.textAlign = "right";
    ctx.fillStyle = leading ? "#145e4f" : "#3a5a52";
    ctx.font = `700 20px ${fontBase}`;
    ctx.fillText(
      `${leading ? "★ " : ""}${cnt} 票 · ${pct.toFixed(1)}%`,
      padX + contentW - 22,
      y + 35,
    );

    // 进度条
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

  // 页脚
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

/* ==================== 主界面 & 大屏渲染 ==================== */
function renderStage(p, onlineCount) {
  $("stage-code").textContent = state.join_code;
  $("stage-online").textContent = String(onlineCount);
  $("stage-votes").textContent = String(p?.total || 0);
  $("stage-phase-text").textContent = p ? PHASES[p.phase] : "等待发起";

  $("stage-empty").hidden = !!p;
  $("stage-content").hidden = !p;
  if (!p) return;

  const hideCounts = stageMaskCounts && p.phase !== "published";
  $("stage-toggle-mask").hidden = p.phase === "published";
  $("stage-toggle-mask").textContent = hideCounts ? "显示实时票数" : "隐藏实时票数";
  $("stage-title").textContent = p.title;
  $("stage-subtitle").textContent =
    p.phase === "published"
      ? `最终结果已公布 · 共收到 ${p.total} 票`
      : hideCounts
        ? `投票进行中 · 已收到 ${p.total} 票（大屏已隐藏实时票数防止干扰）`
        : `投票进行中 · 实时共收到 ${p.total} 票`;

  const maxVotes = Math.max(...(p.counts || [0]));
  const winners = p.counts ? p.counts.filter((c) => c === maxVotes).length : 0;

  $("stage-results").replaceChildren(
    ...p.options.map((option, i) => {
      const cnt = p.counts?.[i] || 0;
      const pct = p.total ? (cnt * 100) / p.total : 0;
      const leading = !hideCounts && p.total > 0 && cnt === maxVotes;

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

      if (leading && p.phase === "published") {
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

function renderDevices() {
  $("device-count").textContent = `${state.devices.length} 台已登记`;
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
        renderDevices();
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
            renderDevices();
          }
        };
        input.onkeydown = (ev) => {
          if (ev.key === "Escape") {
            editingAliasDevice = null;
            renderDevices();
          }
        };
        form.append(input, save);
        box.append(form);
      }

      const detail = document.createElement("p");
      detail.className = `device-status${d.voted ? " done" : ""}`;
      detail.textContent = `${d.online ? "在线" : "离线"} · ${d.voted ? "已投票 ✓" : "未投票"}`;
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
  const p = state.poll;
  const onlineCount = state.devices.filter((d) => d.online).length;
  const maxDevices = state.max_devices || 10;

  // 新题开始时恢复大屏默认防剧透状态；公布时自动揭晓
  if (p?.id !== lastPollId) {
    lastPollId = p?.id || null;
    if (p && p.phase === "open") stageMaskCounts = true;
  }
  if (p?.phase === "published" && lastPollPhase !== "published") {
    stageMaskCounts = false;
  }
  lastPollPhase = p?.phase || null;

  $("join-code").textContent = state.join_code;
  $("online").textContent = String(onlineCount);
  $("online-bar").style.width = `${Math.min(100, (onlineCount / maxDevices) * 100)}%`;

  const totalVotes = p?.total || 0;
  $("votes").textContent = String(totalVotes);
  const denom = Math.max(onlineCount, totalVotes);
  const turnoutPct = denom ? Math.min(100, Math.round((totalVotes * 100) / denom)) : 0;
  $("votes-bar").style.width = p ? `${turnoutPct}%` : "0%";
  $("turnout-rate").textContent = p
    ? denom
      ? `参与率 ${turnoutPct}%`
      : "等待设备投票"
    : "等待收票";

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

  if (p) {
    renderDeadline(p);
    $("live-title").textContent = p.title;
    $("result-caption").textContent =
      p.phase === "published"
        ? "结果已同步至在线投票器；重连设备会自动补收。"
        : "票数仅主持人可见，公布后同步到投票器。";
    $("turnout-label").textContent =
      p.phase === "published" ? "最终参与统计" : "实时参与进度";
    $("turnout-detail").textContent = `${totalVotes} 票 / ${onlineCount} 台在线`;

    const maxVotes = Math.max(...(p.counts || [0]));
    const winners = p.counts ? p.counts.filter((c) => c === maxVotes).length : 0;

    $("results").replaceChildren(
      ...p.options.map((option, i) => {
        const cnt = p.counts[i];
        const percent = p.total ? (cnt * 100) / p.total : 0;
        const leading = p.total > 0 && cnt === maxVotes;

        const row = document.createElement("div");
        row.className = `result${leading ? " leading" : ""}`;

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
        if (leading) {
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
    renderDevices();
  }
  renderStage(p, onlineCount);
  updateButtons();
}

/* ==================== 历史投票抽屉 ==================== */
async function openHistory() {
  $("history-backdrop").hidden = false;
  $("history-drawer").hidden = false;
  $("history-list").innerHTML = '<p class="history-empty">正在读取本场投票记录…</p>';
  try {
    const res = await fetch("/api/history", { cache: "no-store" });
    if (!res.ok) throw Error();
    const { polls } = await res.json();
    if (!polls.length) {
      $("history-list").innerHTML = '<p class="history-empty">本场还没有发起过投票。</p>';
      return;
    }
    $("history-list").replaceChildren(
      ...polls.map((item) => {
        const card = document.createElement("article");
        card.className = "history-card";

        const meta = document.createElement("div");
        meta.className = "history-meta";
        const time = document.createElement("span");
        time.textContent = item.created_ms ? beijingShort.format(item.created_ms) : "";
        const badge = document.createElement("span");
        badge.textContent = `${PHASES[item.phase] || item.phase} · 共 ${item.total} 票`;
        meta.append(time, badge);

        const h4 = document.createElement("h4");
        h4.textContent = item.title;

        const bars = document.createElement("div");
        bars.className = "history-bars";
        item.options.forEach((opt, idx) => {
          const cnt = item.counts[idx] || 0;
          const pct = item.total ? (cnt * 100) / item.total : 0;
          const row = document.createElement("div");
          row.className = "history-bar-row";
          const name = document.createElement("span");
          name.textContent = `${String.fromCharCode(65 + idx)}. ${opt}`;
          const val = document.createElement("b");
          val.textContent = `${cnt} 票 (${pct.toFixed(1)}%)`;
          const track = document.createElement("div");
          track.className = "history-bar-track";
          const fill = document.createElement("div");
          fill.className = "history-bar-fill";
          fill.style.width = `${pct}%`;
          track.append(fill);
          row.append(name, val, track);
          bars.append(row);
        });

        const acts = document.createElement("div");
        acts.className = "history-actions";

        const reuse = document.createElement("button");
        reuse.type = "button";
        reuse.className = "mini-tool";
        reuse.textContent = "复用为新题";
        reuse.onclick = () => {
          $("question").value = item.title;
          $("question-count").textContent = `${[...item.title].length} / 60`;
          setOptions(item.options);
          closeHistory();
          $("question").focus();
          showToast("已载入到新建投票表单");
        };

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "mini-tool";
        copyBtn.textContent = "复制文字";
        copyBtn.onclick = () => copyText(formatResultText(item), "已复制投票结果文字");

        const imgBtn = document.createElement("button");
        imgBtn.type = "button";
        imgBtn.className = "mini-tool";
        imgBtn.textContent = "导出图片";
        imgBtn.onclick = () => exportPollImage(item);

        acts.append(reuse, copyBtn, imgBtn);
        card.append(meta, h4, bars, acts);
        return card;
      }),
    );
  } catch {
    $("history-list").innerHTML = '<p class="history-empty">暂时无法读取历史记录，请稍后重试。</p>';
  }
}

function closeHistory() {
  $("history-backdrop").hidden = true;
  $("history-drawer").hidden = true;
}

/* ==================== 大屏切换 ==================== */
function setStageOpen(open) {
  stageOpen = open;
  $("stage-overlay").hidden = !open;
  document.body.style.overflow = open ? "hidden" : "";
  if (open && state) {
    renderStage(state.poll, state.devices.filter((d) => d.online).length);
  }
  if (window.pywebview?.api?.set_fullscreen) {
    window.pywebview.api.set_fullscreen(open);
  } else if (open && document.documentElement.requestFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else if (!open && document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

/* ==================== 轮询刷新 ==================== */
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

/* ==================== 事件绑定 ==================== */
$("add-option").onclick = () => addOption("", true);
addOption();
addOption();

$("question").oninput = () => {
  $("question-count").textContent = `${[...$("question").value].length} / 60`;
  checkLiveFontCoverage();
};

document.querySelectorAll(".preset-chip").forEach((btn) => {
  btn.onclick = () => {
    const key = btn.dataset.preset;
    if (key === "clear") {
      $("question").value = "";
      $("question-count").textContent = "0 / 60";
      setOptions(["", ""]);
      newDeadline.reset(null);
      notice();
      return;
    }
    const preset = PRESETS[key];
    if (preset) {
      setOptions(preset.options);
      showToast("已应用快捷选项模板");
    }
  };
});

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
  if (state?.poll) copyText(formatResultText(state.poll), "已复制投票结果文字");
};
$("btn-export-png").onclick = () => exportPollImage(state?.poll);
$("stage-export").onclick = () => exportPollImage(state?.poll);

$("btn-history").onclick = openHistory;
$("history-close").onclick = closeHistory;
$("history-backdrop").onclick = closeHistory;

$("btn-stage").onclick = () => setStageOpen(true);
$("stage-exit").onclick = () => setStageOpen(false);
$("stage-toggle-theme").onclick = () => {
  stageLight = !stageLight;
  $("stage-overlay").classList.toggle("light", stageLight);
  $("stage-toggle-theme").textContent = stageLight ? "深色投影" : "浅色展板";
};
$("stage-toggle-mask").onclick = () => {
  stageMaskCounts = !stageMaskCounts;
  if (state) renderStage(state.poll, state.devices.filter((d) => d.online).length);
};

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

$("poll-form").onsubmit = (event) => {
  event.preventDefault();
  const title = $("question").value.trim();
  const options = [...$("options").querySelectorAll("input")].map((i) => i.value.trim());
  const unsupported = findUnsupportedChars([title, ...options]);
  if (coverage.length && unsupported.length) {
    return notice(
      `投票器字库暂不支持：${unsupported.slice(0, 12).join("")}，请换成常用汉字或英文。`,
    );
  }
  try {
    action("create", { title, options, ...newDeadline.value() });
  } catch (error) {
    notice(error.message);
  }
};

$("close").onclick = () => action("close", { poll_id: state?.poll?.id });
$("publish").onclick = () => action("publish", { poll_id: state?.poll?.id });
$("stage-close").onclick = () => action("close", { poll_id: state?.poll?.id });
$("stage-publish").onclick = () => action("publish", { poll_id: state?.poll?.id });

document.addEventListener("keydown", (event) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    if (!$("start").disabled && !stageOpen) {
      event.preventDefault();
      $("poll-form").requestSubmit();
    }
    return;
  }
  if (event.key === "Escape") {
    if (stageOpen) {
      setStageOpen(false);
    } else if (!$("history-drawer").hidden) {
      closeHistory();
    }
    return;
  }
  if (!typing && (event.key === "f" || event.key === "F") && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    setStageOpen(!stageOpen);
  }
});

// 定时题秒级顺滑倒计时刷新（无需额外请求后端）
setInterval(() => {
  if (state?.poll?.phase === "open" && state.poll.deadline_at_ms) {
    renderDeadline(state.poll);
  }
}, 250);

fetch("/font-coverage.json")
  .then((r) => r.json())
  .then((data) => {
    coverage = data.ranges;
    checkLiveFontCoverage();
  })
  .catch(() => notice("字库清单未加载，请刷新页面。"));

async function poll() {
  await refresh();
  setTimeout(poll, 1000);
}
poll();
