import fontCoverage from "../../host/static/font-coverage.json";
import type { ModeSummary, ParsedQuestion, PollMode, PollReportDetail } from "./types.js";

export const DEFAULT_DEVICE_LIMIT = 10;
export const MAX_DEVICE_LIMIT = 200;
export const MAX_ALIAS_LENGTH = 20;
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_ADMIN_BODY_BYTES = 128 * 1024;
export const MAX_BATCH_POLLS = 50;
export const MAX_DEADLINE_MS = 253402300799999; // 公历 9999 年末的 Unix 毫秒数
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export const MODE_LABELS: Record<PollMode, string> = {
  single: "普通单选",
  approval: "赞成 / 反对 / 弃权",
  rating: "五分评分",
  quiz: "答题测验",
};

export const FIXED_OPTIONS: Partial<Record<PollMode, readonly string[]>> = {
  approval: ["赞成", "反对", "弃权"],
  rating: ["1 分", "2 分", "3 分", "4 分", "5 分"],
};

const FONT_RANGES: ReadonlyArray<readonly [number, number]> = fontCoverage.ranges.map(
  (pair) => [pair[0], pair[1]] as const,
);

export class ValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
}

export function isCodePointSupported(cp: number): boolean {
  let low = 0;
  let high = FONT_RANGES.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = FONT_RANGES[mid];
    if (cp < start) {
      high = mid - 1;
    } else if (cp > end) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

export function supportedText(raw: unknown, maximum: number, name: string): string {
  if (typeof raw !== "string") {
    throw new ValidationError(`${name}必须是文字`);
  }
  const text = raw.trim();
  const chars = Array.from(text);
  if (chars.length < 1 || chars.length > maximum) {
    throw new ValidationError(`${name}须为 1～${maximum} 个字符`);
  }
  const missingSet = new Set<string>();
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || !isCodePointSupported(cp)) {
      missingSet.add(ch);
    }
  }
  if (missingSet.size > 0) {
    const missing = Array.from(missingSet).sort();
    throw new ValidationError(`投票器字库暂不支持：${missing.slice(0, 12).join("")}，请换成常用汉字或英文`);
  }
  return text;
}

export function isStrictInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function readDeadline(data: Record<string, unknown>, now: number): number | null {
  let deadline: unknown;
  if ("duration_seconds" in data) {
    const duration = data.duration_seconds;
    if ("deadline_at_ms" in data || !isStrictInt(duration) || duration <= 0) {
      throw new ValidationError("请指定一种截止方式，时长须为正整数秒");
    }
    deadline = now + duration * 1000;
  } else {
    deadline = data.deadline_at_ms ?? null;
  }
  if (deadline !== null) {
    if (!isStrictInt(deadline) || !(now < deadline && deadline <= MAX_DEADLINE_MS)) {
      throw new ValidationError("截止时间须晚于主持服务当前时间，且在有效日期范围内");
    }
    return deadline;
  }
  return null;
}

export function readQuestion(data: unknown): ParsedQuestion {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError("题目格式无效");
  }
  const obj = data as Record<string, unknown>;
  const title = supportedText(obj.title, 60, "题目");
  const rawMode = obj.mode === undefined ? "single" : obj.mode;
  if (typeof rawMode !== "string" || !(rawMode in MODE_LABELS)) {
    throw new ValidationError("投票模式无效");
  }
  const mode = rawMode as PollMode;
  const fixed = FIXED_OPTIONS[mode];
  let options: string[];
  if (fixed) {
    options = [...fixed];
  } else {
    const rawOptions = obj.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 6) {
      throw new ValidationError("需要 2～6 个选项");
    }
    options = rawOptions.map((item) => supportedText(item, 24, "选项"));
    if (new Set(options).size !== options.length) {
      throw new ValidationError("选项不能重复");
    }
  }
  let correctChoice: number | null = null;
  if (mode === "quiz") {
    const rawCorrect = obj.correct_choice;
    if (!isStrictInt(rawCorrect) || rawCorrect < 0 || rawCorrect >= options.length) {
      throw new ValidationError("请为测验题选择有效的正确选项");
    }
    correctChoice = rawCorrect;
  }
  return {
    title,
    optionsJson: JSON.stringify(options),
    mode,
    correctChoice,
  };
}

export function modeSummary(mode: PollMode, correctChoice: number | null, counts: number[]): ModeSummary {
  if (mode === "approval") {
    const [yes = 0, no = 0, abstain = 0] = counts;
    const valid = yes + no;
    return {
      yes,
      no,
      abstain,
      approval_pct: valid > 0 ? (100 * yes) / valid : null,
      passed: valid > 0 ? yes > no : null,
    };
  }
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (mode === "rating") {
    const weighted = counts.reduce((sum, count, idx) => sum + (idx + 1) * count, 0);
    return { average: total > 0 ? weighted / total : null };
  }
  if (mode === "quiz") {
    const correct = correctChoice !== null ? (counts[correctChoice] ?? 0) : 0;
    return {
      correct_count: correct,
      correct_pct: total > 0 ? (100 * correct) / total : null,
    };
  }
  return {};
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomJoinCode(): string {
  // 拒绝采样，保证 000000..999999 严格均匀分布
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) {
      return String(buf[0] % 1_000_000).padStart(6, "0");
    }
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

function csvEscape(cell: string | number): string {
  const text = String(cell);
  const safe = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return safe;
}

function formatBeijingTimestamp(ms: number | null): string {
  if (ms === null) return "";
  const shifted = new Date(ms + 8 * 3600 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mi = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export function formatReportCsv(report: PollReportDetail): string {
  const rows: string[] = [];
  const pushRow = (values: Array<string | number>) => {
    rows.push(values.map(csvEscape).join(","));
  };
  pushRow([
    "发起时间（北京时间）",
    "结束时间（北京时间）",
    "参与人数",
    "整场票数",
    "题号",
    "题目",
    "本题票数",
    "选项编号",
    "选项",
    "选项票数",
    "得票比例",
    "投票模式",
    "正确选项",
    "模式统计",
  ]);
  const shared = [
    formatBeijingTimestamp(report.started_at_ms),
    formatBeijingTimestamp(report.ended_at_ms),
    report.participants,
    report.total_votes,
  ];
  report.questions.forEach((question, qIndex) => {
    const total = question.total;
    const mode = question.mode;
    const correctChoice = question.correct_choice;
    const answer = correctChoice !== null ? String.fromCharCode(65 + correctChoice) : "";
    let stats = "";
    if (mode === "approval") {
      const s = question.mode_summary as { approval_pct: number | null; passed: boolean | null };
      if (s.approval_pct === null) {
        stats = "无有效表决票";
      } else {
        const outcome = s.passed ? "通过" : "未通过";
        stats = `${outcome} · 赞成率 ${s.approval_pct.toFixed(1)}%（不计弃权）`;
      }
    } else if (mode === "rating") {
      const s = question.mode_summary as { average: number | null };
      stats = s.average !== null ? `平均 ${s.average.toFixed(2)} 分` : "暂无评分";
    } else if (mode === "quiz") {
      const s = question.mode_summary as { correct_count: number; correct_pct: number | null };
      stats =
        s.correct_pct !== null
          ? `答对 ${s.correct_count} 人 · 正确率 ${s.correct_pct.toFixed(1)}%`
          : "暂无作答";
    }
    const extra = [MODE_LABELS[mode], answer, stats];
    question.options.forEach((option, i) => {
      const count = question.counts[i] ?? 0;
      const percent = total > 0 ? (100 * count) / total : 0;
      pushRow([
        ...shared,
        qIndex + 1,
        question.title,
        total,
        String.fromCharCode(65 + i),
        option,
        count,
        `${percent.toFixed(1)}%`,
        ...extra,
      ]);
    });
  });
  return "\ufeff" + rows.join("\r\n") + "\r\n";
}
