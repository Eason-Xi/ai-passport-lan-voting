import { DurableObject } from "cloudflare:workers";
import type {
  DeviceSnapshot,
  DeviceStatus,
  HostStateResponse,
  LibraryQuestion,
  PollItemDevice,
  PollItemHost,
  PollMode,
  PollPhase,
  PollReportDetail,
  PollReportSummary,
  ReportQuestion,
  SocketAttachment,
} from "./types.js";
import {
  DEFAULT_DEVICE_LIMIT,
  MAX_ALIAS_LENGTH,
  MAX_BATCH_POLLS,
  MAX_DEVICE_LIMIT,
  MAX_MESSAGE_BYTES,
  SESSION_TTL_MS,
  ValidationError,
  isStrictInt,
  modeSummary,
  randomHex,
  randomJoinCode,
  readDeadline,
  readQuestion,
  sha256Hex,
  timingSafeEqualStrings,
} from "./validation.js";

interface PollRow {
  id: string;
  title: string;
  options: string;
  phase: PollPhase;
  created: number;
  deadline_at_ms: number | null;
  batch_id: string;
  mode: PollMode;
  correct_choice: number | null;
  history_deleted: number;
  [key: string]: SqlStorageValue;
}

const DEVICE_ID_RE = /^[0-9a-f]{12}$/;
const HEX16_RE = /^[0-9a-f]{16}$/;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 10;

export class VotingRoom extends DurableObject<Env> {
  private loginFailures: number[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        seen REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS polls (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        options TEXT NOT NULL,
        phase TEXT NOT NULL,
        created REAL NOT NULL,
        deadline_at_ms INTEGER,
        batch_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'single',
        correct_choice INTEGER,
        history_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS polls_by_batch ON polls(batch_id);
      CREATE TABLE IF NOT EXISTS votes (
        poll_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        choice INTEGER NOT NULL,
        created REAL NOT NULL,
        PRIMARY KEY (poll_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS poll_reports (
        batch_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        question_count INTEGER NOT NULL,
        participants INTEGER NOT NULL,
        total_votes INTEGER NOT NULL,
        questions TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS question_library (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        options TEXT NOT NULL,
        mode TEXT NOT NULL,
        correct_choice INTEGER,
        revision INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
    `);

    this.ensureSetting("join_code", randomJoinCode());
    this.ensureSetting("host_id", randomHex(8));
    this.ensureSetting("admin_nonce", randomHex(24));
    this.ensureSetting("stage_token", randomHex(18));
  }

  private ensureSetting(key: string, defaultValue: string): void {
    this.sql.exec("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", key, defaultValue);
  }

  private getSetting(key: string): string | null {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)
      .toArray()[0];
    return row ? row.value : null;
  }

  private setSetting(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private getJoinCode(): string {
    return this.getSetting("join_code") ?? "000000";
  }

  private getHostId(): string {
    return this.getSetting("host_id") ?? "0000000000000000";
  }

  private getAdminNonce(): string {
    return this.getSetting("admin_nonce") ?? "";
  }

  private getStageToken(): string {
    return this.getSetting("stage_token") ?? "";
  }

  private getDeviceLimit(): number {
    const raw = this.getSetting("device_limit");
    return raw ? Number.parseInt(raw, 10) : DEFAULT_DEVICE_LIMIT;
  }

  private getAliases(): Record<string, string> {
    const raw = this.getSetting("device_aliases");
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") result[k] = v;
      }
      return result;
    } catch {
      return {};
    }
  }

  private latestBatch(): PollRow | null {
    const row = this.sql
      .exec<PollRow>(
        "SELECT * FROM polls WHERE id = (SELECT batch_id FROM polls ORDER BY rowid DESC LIMIT 1)",
      )
      .toArray()[0];
    return row ?? null;
  }

  private isDue(poll: PollRow | null, now: number): boolean {
    return (
      poll !== null &&
      poll.phase === "open" &&
      poll.deadline_at_ms !== null &&
      now >= poll.deadline_at_ms
    );
  }

  private countsForPoll(pollId: string, optionCount: number): number[] {
    const counts = new Array<number>(optionCount).fill(0);
    const rows = this.sql
      .exec<{ choice: number; total: number }>(
        "SELECT choice, COUNT(*) AS total FROM votes WHERE poll_id = ? GROUP BY choice",
        pollId,
      )
      .toArray();
    for (const row of rows) {
      if (row.choice >= 0 && row.choice < optionCount) {
        counts[row.choice] = row.total;
      }
    }
    return counts;
  }

  private saveReport(batch: PollRow, endedAtMs: number | null): void {
    const rows = this.sql
      .exec<PollRow>("SELECT * FROM polls WHERE batch_id = ? ORDER BY rowid", batch.id)
      .toArray();
    const questions: ReportQuestion[] = rows.map((poll) => {
      const options = JSON.parse(poll.options) as string[];
      const counts = this.countsForPoll(poll.id, options.length);
      const total = counts.reduce((sum, n) => sum + n, 0);
      return {
        id: poll.id,
        title: poll.title,
        options,
        counts,
        total,
        mode: poll.mode,
        correct_choice: poll.correct_choice,
        mode_summary: modeSummary(poll.mode, poll.correct_choice, counts),
      };
    });
    const participantRow = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(DISTINCT v.device_id) AS count FROM votes v JOIN polls p ON p.id = v.poll_id WHERE p.batch_id = ?",
        batch.id,
      )
      .toArray()[0];
    const participants = participantRow ? participantRow.count : 0;
    const totalVotes = questions.reduce((sum, q) => sum + q.total, 0);
    this.sql.exec(
      `INSERT INTO poll_reports(batch_id, title, started_at_ms, ended_at_ms, question_count, participants, total_votes, questions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      batch.id,
      batch.title,
      Math.round(batch.created * 1000),
      endedAtMs,
      questions.length,
      participants,
      totalVotes,
      JSON.stringify(questions),
    );
  }

  private finishBatch(poll: PollRow, phase: PollPhase, endedAtMs: number): void {
    this.sql.exec("UPDATE polls SET phase = ? WHERE batch_id = ?", phase, poll.id);
    if (poll.phase === "open") {
      this.saveReport(poll, endedAtMs);
    }
  }

  /**
   * 检查当前批次是否已过截止时刻；如到期则立即独立提交自动截止，确保即使后续操作被拒也保留截止态。
   */
  private ensureUpToDate(now = Date.now()): { batch: PollRow | null; autoClosed: boolean } {
    let autoClosed = false;
    const batch = this.ctx.storage.transactionSync(() => {
      const latest = this.latestBatch();
      if (this.isDue(latest, now) && latest) {
        this.finishBatch(latest, "closed", latest.deadline_at_ms!);
        autoClosed = true;
        return this.latestBatch();
      }
      return latest;
    });
    return { batch, autoClosed };
  }

  private async syncDeadlineAlarm(): Promise<void> {
    const batch = this.latestBatch();
    if (batch && batch.phase === "open" && batch.deadline_at_ms !== null) {
      await this.ctx.storage.setAlarm(batch.deadline_at_ms);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private buildHostPollItem(poll: PollRow, now: number): PollItemHost {
    const options = JSON.parse(poll.options) as string[];
    const counts = this.countsForPoll(poll.id, options.length);
    const total = counts.reduce((sum, n) => sum + n, 0);
    const item: PollItemHost = {
      id: poll.id,
      title: poll.title,
      options,
      phase: poll.phase,
      my_choice: -1,
      counts,
      total,
      mode: poll.mode,
      correct_choice: poll.correct_choice,
      mode_summary: modeSummary(poll.mode, poll.correct_choice, counts),
    };
    if (poll.deadline_at_ms !== null) {
      item.deadline_at_ms = poll.deadline_at_ms;
      if (poll.phase === "open") {
        item.remaining_ms = Math.max(0, poll.deadline_at_ms - now);
      }
    }
    return item;
  }

  private buildDeviceSnapshot(deviceId: string, viewedId: string | null, now = Date.now()): DeviceSnapshot {
    const { batch } = this.ensureUpToDate(now);
    const state: DeviceSnapshot = { v: 1, type: "state", poll: null };
    if (!batch) return state;

    const rows = this.sql
      .exec<PollRow>("SELECT * FROM polls WHERE batch_id = ? ORDER BY rowid", batch.id)
      .toArray();
    if (rows.length === 0) return state;

    const published = batch.phase === "published";
    let shown: string | null = null;
    if (published && rows.length > 1) {
      const savedShown = this.getSetting("shown_result");
      shown = savedShown && rows.some((p) => p.id === savedShown) ? savedShown : batch.id;
    }

    const mineRows = this.sql
      .exec<{ poll_id: string; choice: number }>(
        "SELECT v.poll_id, v.choice FROM votes v JOIN polls p ON p.id = v.poll_id WHERE p.batch_id = ? AND v.device_id = ?",
        batch.id,
        deviceId,
      )
      .toArray();
    const mine = new Map<string, number>();
    for (const r of mineRows) {
      mine.set(r.poll_id, r.choice);
    }

    const ids = rows.map((p) => p.id);
    let index: number;
    if (published) {
      const resultId = viewedId && ids.includes(viewedId) ? viewedId : shown;
      index = resultId ? Math.max(0, ids.indexOf(resultId)) : 0;
    } else {
      const firstUnanswered = ids.findIndex((id) => !mine.has(id));
      index = firstUnanswered >= 0 ? firstUnanswered : rows.length - 1;
    }

    const poll = rows[index];
    const options = JSON.parse(poll.options) as string[];
    const item: PollItemDevice = {
      id: poll.id,
      title: poll.title,
      options,
      phase: poll.phase,
      my_choice: mine.get(poll.id) ?? -1,
    };
    if (poll.deadline_at_ms !== null) {
      item.deadline_at_ms = poll.deadline_at_ms;
      if (poll.phase === "open") {
        item.remaining_ms = Math.max(0, poll.deadline_at_ms - now);
      }
    }
    if (published) {
      const counts = this.countsForPoll(poll.id, options.length);
      item.counts = counts;
      item.total = counts.reduce((sum, n) => sum + n, 0);
    }
    if (rows.length > 1) {
      item.batch = {
        index: index + 1,
        count: rows.length,
        answered: mine.size,
      };
      if (published) {
        item.batch.next = ids[(index + 1) % rows.length];
        item.batch.prev = ids[(index - 1 + rows.length) % rows.length];
      }
    }
    state.poll = item;
    return state;
  }

  private getAttachment(ws: WebSocket): SocketAttachment {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (att) return att;
    return {
      deviceId: null,
      viewedId: null,
      authed: false,
      connectedAtMs: Date.now(),
      recentMs: [],
    };
  }

  private setAttachment(ws: WebSocket, att: SocketAttachment): void {
    ws.serializeAttachment(att);
  }

  private onlineDeviceSet(): Set<string> {
    const online = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (att.authed && att.deviceId) {
        online.add(att.deviceId);
      }
    }
    return online;
  }

  private clearAllViewed(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (att.viewedId !== null) {
        att.viewedId = null;
        this.setAttachment(ws, att);
      }
    }
  }

  private sendDeviceState(ws: WebSocket, att: SocketAttachment, extra?: { join_code?: string }): boolean {
    if (!att.authed || !att.deviceId) return false;
    try {
      const snapshot = this.buildDeviceSnapshot(att.deviceId, att.viewedId);
      if (extra?.join_code) {
        snapshot.join_code = extra.join_code;
      }
      ws.send(JSON.stringify(snapshot));
      return true;
    } catch {
      try {
        ws.close(1011, "send failed");
      } catch {
        // ignore already closed socket
      }
      return false;
    }
  }

  private broadcastToDevices(): number {
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (att.authed && att.deviceId) {
        if (this.sendDeviceState(ws, att)) {
          sent += 1;
        }
      }
    }
    return sent;
  }

  // ==================== Alarm（定时截止唤醒） ====================

  async alarm(): Promise<void> {
    const { autoClosed } = this.ensureUpToDate(Date.now());
    if (autoClosed) {
      this.broadcastToDevices();
    }
    await this.syncDeadlineAlarm();
  }

  // ==================== WebSocket Hibernation 入口 ====================

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.setAttachment(server, {
      deviceId: null,
      viewedId: null,
      authed: false,
      connectedAtMs: Date.now(),
      recentMs: [],
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = this.getAttachment(ws);
    if (typeof message !== "string") {
      if (!att.authed) {
        this.sendWsErrorAndClose(ws, "请先登记设备");
      }
      return;
    }
    if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
      this.sendWsErrorAndClose(ws, "消息超出长度限制");
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      if (!att.authed) {
        this.sendWsErrorAndClose(ws, "协议版本或握手无效");
      } else {
        this.sendWsError(ws, att, "协议无效");
      }
      return;
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      if (!att.authed) {
        this.sendWsErrorAndClose(ws, "协议版本或握手无效");
      } else {
        this.sendWsError(ws, att, "协议无效");
      }
      return;
    }
    const payload = data as Record<string, unknown>;

    if (!att.authed) {
      await this.handleDeviceHello(ws, att, payload);
      return;
    }

    const now = Date.now();
    att.recentMs = att.recentMs.filter((ts) => now - ts < 1000);
    if (att.recentMs.length >= 8) {
      this.sendWsErrorAndClose(ws, "消息过于频繁");
      return;
    }
    att.recentMs.push(now);
    this.setAttachment(ws, att);

    try {
      if (payload.v !== 1) {
        throw new ValidationError("协议无效");
      }
      const type = payload.type;
      if (type === "vote") {
        const autoClosed = this.recordVote(att.deviceId!, payload.poll_id, payload.choice);
        if (autoClosed) {
          this.broadcastToDevices();
          await this.syncDeadlineAlarm();
        } else {
          this.sendDeviceState(ws, att);
        }
      } else if (type === "view") {
        const requested = payload.poll_id;
        if (typeof requested !== "string" || !HEX16_RE.test(requested)) {
          throw new ValidationError("题目编号无效");
        }
        const { batch } = this.ensureUpToDate();
        if (
          !batch ||
          batch.phase !== "published" ||
          !this.sql
            .exec("SELECT 1 FROM polls WHERE id = ? AND batch_id = ?", requested, batch.id)
            .toArray()[0]
        ) {
          throw new ValidationError("请等待主持人公布本组结果");
        }
        att.viewedId = requested;
        this.setAttachment(ws, att);
        this.sendDeviceState(ws, att);
      } else if (type === "sync") {
        const { autoClosed } = this.ensureUpToDate();
        if (autoClosed) {
          this.broadcastToDevices();
          await this.syncDeadlineAlarm();
        } else {
          this.sendDeviceState(ws, att);
        }
      } else {
        throw new ValidationError("消息类型无效");
      }
    } catch (err) {
      const text = err instanceof ValidationError ? err.message : "记录写入失败，请稍后重试";
      this.sendWsError(ws, att, text);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "socket error");
    } catch {
      // already closed
    }
  }

  private sendWsError(ws: WebSocket, att: SocketAttachment, message: string): void {
    try {
      ws.send(JSON.stringify({ v: 1, type: "error", message }));
      this.sendDeviceState(ws, att);
    } catch {
      try {
        ws.close(1011, "error send failed");
      } catch {
        // ignore
      }
    }
  }

  private sendWsErrorAndClose(ws: WebSocket, message: string): void {
    try {
      ws.send(JSON.stringify({ v: 1, type: "error", message }));
    } catch {
      // ignore
    }
    try {
      ws.close(1008, message);
    } catch {
      // ignore
    }
  }

  private async handleDeviceHello(
    ws: WebSocket,
    att: SocketAttachment,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (payload.v !== 1 || payload.type !== "hello") {
        throw new ValidationError("协议版本或握手无效");
      }
      if (payload.open_join === true) {
        throw new ValidationError("云端模式请使用入场码");
      }
      const code = payload.code;
      const expectedCode = this.getJoinCode();
      if (typeof code !== "string" || !/^[0-9]{6}$/.test(code) || !(await timingSafeEqualStrings(code, expectedCode))) {
        throw new ValidationError("入场码错误，长按确定可切换");
      }
      const candidate = payload.device_id;
      if (typeof candidate !== "string" || !DEVICE_ID_RE.test(candidate)) {
        throw new ValidationError("设备编号无效");
      }

      this.registerDevice(candidate);

      // 公网移动网络下设备断线重连常见半开连接，鉴权通过后温和接管同设备旧连接
      for (const existing of this.ctx.getWebSockets()) {
        if (existing === ws) continue;
        const other = this.getAttachment(existing);
        if (other.authed && other.deviceId === candidate) {
          other.authed = false;
          other.deviceId = null;
          this.setAttachment(existing, other);
          try {
            existing.close(1000, "replaced by reconnect");
          } catch {
            // ignore
          }
        }
      }

      att.authed = true;
      att.deviceId = candidate;
      att.viewedId = null;
      this.setAttachment(ws, att);

      const { autoClosed } = this.ensureUpToDate();
      if (autoClosed) {
        this.broadcastToDevices();
        await this.syncDeadlineAlarm();
      } else {
        this.sendDeviceState(ws, att);
      }
    } catch (err) {
      const msg = err instanceof ValidationError ? err.message : "登记存储失败，请联系主持人";
      this.sendWsErrorAndClose(ws, msg);
    }
  }

  private registerDevice(deviceId: string): void {
    if (!DEVICE_ID_RE.test(deviceId)) {
      throw new ValidationError("设备编号无效");
    }
    this.ctx.storage.transactionSync(() => {
      const existing = this.sql
        .exec("SELECT 1 FROM devices WHERE id = ?", deviceId)
        .toArray()[0];
      if (!existing) {
        const limit = this.getDeviceLimit();
        const countRow = this.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM devices")
          .toArray()[0];
        if ((countRow?.count ?? 0) >= limit) {
          throw new ValidationError(`本场设备已满，最多登记 ${limit} 台`);
        }
      }
      this.sql.exec(
        "INSERT INTO devices (id, seen) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET seen = excluded.seen",
        deviceId,
        Date.now() / 1000,
      );
    });
  }

  private recordVote(deviceId: string, pollId: unknown, choice: unknown): boolean {
    const now = Date.now();
    const { batch, autoClosed } = this.ensureUpToDate(now);
    this.ctx.storage.transactionSync(() => {
      let poll: PollRow | null = null;
      if (batch && typeof pollId === "string") {
        poll =
          this.sql
            .exec<PollRow>("SELECT * FROM polls WHERE batch_id = ? AND id = ?", batch.id, pollId)
            .toArray()[0] ?? null;
      }
      if (!poll) {
        throw new ValidationError("题目已变更，本次提交未计票");
      }
      const old = this.sql
        .exec<{ choice: number }>(
          "SELECT choice FROM votes WHERE poll_id = ? AND device_id = ?",
          poll.id,
          deviceId,
        )
        .toArray()[0];
      if (old) {
        if (!isStrictInt(choice) || choice !== old.choice) {
          throw new ValidationError("本机已投票，首次选择已锁定");
        }
        return;
      }
      if (poll.phase !== "open") {
        throw new ValidationError("投票已截止，本次提交未计票");
      }
      const options = JSON.parse(poll.options) as string[];
      if (!isStrictInt(choice) || choice < 0 || choice >= options.length) {
        throw new ValidationError("选项编号无效");
      }
      const firstUnanswered = this.sql
        .exec<{ id: string }>(
          `SELECT p.id FROM polls p WHERE p.batch_id = ? AND NOT EXISTS
           (SELECT 1 FROM votes v WHERE v.poll_id = p.id AND v.device_id = ?)
           ORDER BY p.rowid LIMIT 1`,
          batch!.id,
          deviceId,
        )
        .toArray()[0];
      if (!firstUnanswered || firstUnanswered.id !== poll.id) {
        throw new ValidationError("请先完成上一题，本次提交未计票");
      }
      this.sql.exec(
        "INSERT INTO votes (poll_id, device_id, choice, created) VALUES (?, ?, ?, ?)",
        poll.id,
        deviceId,
        choice,
        now / 1000,
      );
    });
    return autoClosed;
  }

  // ==================== 管理员会话 & 鉴权 RPC ====================

  async login(providedPassword: string, expectedPassword: string): Promise<{ ok: true; token: string } | { ok: false; status: number; error: string }> {
    const now = Date.now();
    this.loginFailures = this.loginFailures.filter((ts) => now - ts < LOGIN_WINDOW_MS);
    if (this.loginFailures.length >= LOGIN_MAX_FAILURES) {
      return { ok: false, status: 429, error: "尝试次数过多，请 1 分钟后再试" };
    }
    const matched = await timingSafeEqualStrings(providedPassword, expectedPassword);
    if (!matched) {
      this.loginFailures.push(now);
      return { ok: false, status: 401, error: "管理密码错误" };
    }
    this.loginFailures = [];
    const token = randomHex(32);
    const tokenHash = await sha256Hex(token);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM sessions WHERE expires_at_ms <= ?", now);
      this.sql.exec(
        "INSERT INTO sessions (token_hash, created_at_ms, expires_at_ms) VALUES (?, ?, ?)",
        tokenHash,
        now,
        now + SESSION_TTL_MS,
      );
    });
    return { ok: true, token };
  }

  async verifySession(token: string | null): Promise<boolean> {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const row = this.sql
      .exec<{ expires_at_ms: number }>(
        "SELECT expires_at_ms FROM sessions WHERE token_hash = ?",
        tokenHash,
      )
      .toArray()[0];
    if (!row || row.expires_at_ms <= now) {
      if (row) {
        this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
      }
      return false;
    }
    return true;
  }

  async logout(token: string | null): Promise<void> {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return;
    const tokenHash = await sha256Hex(token);
    this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  async verifyStageToken(token: string | null): Promise<boolean> {
    if (!token) return false;
    return timingSafeEqualStrings(token, this.getStageToken());
  }

  async verifyNonce(provided: string | null): Promise<boolean> {
    if (!provided) return false;
    return timingSafeEqualStrings(provided, this.getAdminNonce());
  }

  // ==================== 主持台查询 RPC ====================

  async getHostState(wsUrl: string, readonlyStage: boolean): Promise<HostStateResponse> {
    const now = Date.now();
    const { batch, autoClosed } = this.ensureUpToDate(now);
    if (autoClosed) {
      this.broadcastToDevices();
      await this.syncDeadlineAlarm();
    }

    let pollItem: PollItemHost | null = null;
    let batchState: HostStateResponse["batch"] | undefined;
    let questionCount = 1;

    if (batch) {
      const rows = this.sql
        .exec<PollRow>("SELECT * FROM polls WHERE batch_id = ? ORDER BY rowid", batch.id)
        .toArray();
      const items = rows.map((row) => this.buildHostPollItem(row, now));
      pollItem = items[0] ?? null;
      questionCount = items.length || 1;
      if (items.length > 1) {
        const published = batch.phase === "published";
        let shown: string | null = null;
        if (published) {
          const saved = this.getSetting("shown_result");
          shown = saved && rows.some((p) => p.id === saved) ? saved : batch.id;
        }
        batchState = { id: batch.id, polls: items, shown_result: shown };
      }
    }

    const latestReportRow = this.sql
      .exec<{ batch_id: string }>("SELECT batch_id FROM poll_reports ORDER BY rowid DESC LIMIT 1")
      .toArray()[0];
    const historyCountRow = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM poll_reports")
      .toArray()[0];

    const currentId = pollItem?.id ?? "";
    const answeredRows = currentId
      ? this.sql
          .exec<{ device_id: string; count: number }>(
            "SELECT v.device_id, COUNT(*) AS count FROM votes v JOIN polls p ON p.id = v.poll_id WHERE p.batch_id = ? GROUP BY v.device_id",
            currentId,
          )
          .toArray()
      : [];
    const answered = new Map<string, number>();
    for (const r of answeredRows) {
      answered.set(r.device_id, r.count);
    }

    const onlineSet = this.onlineDeviceSet();
    const aliases = this.getAliases();
    const deviceRows = this.sql
      .exec<{ id: string }>("SELECT id FROM devices ORDER BY id")
      .toArray();
    const devices: DeviceStatus[] = deviceRows.map((row) => {
      const count = answered.get(row.id) ?? 0;
      return {
        id: row.id,
        online: onlineSet.has(row.id),
        answered: count,
        voted: count === questionCount,
        alias: readonlyStage ? "" : (aliases[row.id] ?? ""),
      };
    });

    const response: HostStateResponse = {
      v: 1,
      type: "state",
      server_now_ms: now,
      poll: pollItem,
      ...(batchState ? { batch: batchState } : {}),
      latest_report: latestReportRow ? latestReportRow.batch_id : null,
      join_code: this.getJoinCode(),
      max_devices: this.getDeviceLimit(),
      device_limit_max: MAX_DEVICE_LIMIT,
      addresses: [wsUrl],
      port: 443,
      host_id: this.getHostId(),
      discovery_available: false,
      max_batch_polls: MAX_BATCH_POLLS,
      supports_append: true,
      supports_modes: true,
      supports_question_library: true,
      supports_history_delete: true,
      supports_open_join: false,
      supports_rotate_join_code: true,
      open_join_remaining_ms: 0,
      open_join_until_ms: null,
      history_count: historyCountRow ? historyCountRow.count : 0,
      devices,
      cloud_mode: true,
      readonly_stage: readonlyStage,
      ws_url: wsUrl,
    };

    if (!readonlyStage) {
      response.nonce = this.getAdminNonce();
      response.stage_share_path = `/?view=stage&stage_token=${encodeURIComponent(this.getStageToken())}`;
    }

    return response;
  }

  async getQuestionLibrary(): Promise<{ questions: LibraryQuestion[] }> {
    const rows = this.sql
      .exec<{
        id: string;
        title: string;
        options: string;
        mode: PollMode;
        correct_choice: number | null;
        revision: number;
      }>("SELECT id, title, options, mode, correct_choice, revision FROM question_library ORDER BY updated_at_ms DESC, rowid DESC")
      .toArray();
    return {
      questions: rows.map((row) => ({
        id: row.id,
        title: row.title,
        options: JSON.parse(row.options) as string[],
        mode: row.mode,
        correct_choice: row.correct_choice,
        revision: row.revision,
      })),
    };
  }

  async getHistory(before: number | null): Promise<{ reports: PollReportSummary[]; next_before: number | null }> {
    const baseQuery = `SELECT rowid AS cursor, batch_id AS id, title, started_at_ms, ended_at_ms,
                              question_count, participants, total_votes FROM poll_reports`;
    const rows =
      before !== null
        ? this.sql
            .exec<PollReportSummary & { [key: string]: SqlStorageValue }>(
              `${baseQuery} WHERE rowid < ? ORDER BY rowid DESC LIMIT 21`,
              before,
            )
            .toArray()
        : this.sql
            .exec<PollReportSummary & { [key: string]: SqlStorageValue }>(
              `${baseQuery} ORDER BY rowid DESC LIMIT 21`,
            )
            .toArray();
    const reports: PollReportSummary[] = rows.slice(0, 20).map((r) => ({
      cursor: r.cursor,
      id: r.id,
      title: r.title,
      started_at_ms: r.started_at_ms,
      ended_at_ms: r.ended_at_ms,
      question_count: r.question_count,
      participants: r.participants,
      total_votes: r.total_votes,
    }));
    return {
      reports,
      next_before: rows.length > 20 ? reports[19].cursor : null,
    };
  }

  async getReport(batchId: string): Promise<PollReportDetail | null> {
    const row = this.sql
      .exec<{
        id: string;
        title: string;
        started_at_ms: number;
        ended_at_ms: number | null;
        question_count: number;
        participants: number;
        total_votes: number;
        questions: string;
      }>(
        `SELECT batch_id AS id, title, started_at_ms, ended_at_ms,
                question_count, participants, total_votes, questions
         FROM poll_reports WHERE batch_id = ?`,
        batchId,
      )
      .toArray()[0];
    if (!row) return null;
    const questions = (JSON.parse(row.questions) as Partial<ReportQuestion>[]).map((q) => ({
      id: q.id ?? "",
      title: q.title ?? "",
      options: q.options ?? [],
      counts: q.counts ?? [],
      total: q.total ?? 0,
      mode: (q.mode ?? "single") as PollMode,
      correct_choice: q.correct_choice ?? null,
      mode_summary: q.mode_summary ?? {},
    }));
    return {
      id: row.id,
      title: row.title,
      started_at_ms: row.started_at_ms,
      ended_at_ms: row.ended_at_ms,
      question_count: row.question_count,
      participants: row.participants,
      total_votes: row.total_votes,
      questions,
    };
  }

  // ==================== 主持台写操作 RPC ====================

  async handleAdminAction(
    action: string,
    data: Record<string, unknown>,
  ): Promise<{ ok: true; pushed_to?: number; join_code?: string; stage_share_path?: string } | { error: string; status: number }> {
    try {
      let shouldBroadcast = false;
      let shouldSyncAlarm = false;
      let extra: { join_code?: string; stage_share_path?: string } = {};

      if (action === "create") {
        this.createQuestions([data], data);
        shouldBroadcast = true;
        shouldSyncAlarm = true;
      } else if (action === "create_batch") {
        const questions = data.questions;
        if (!Array.isArray(questions) || questions.length < 2 || questions.length > MAX_BATCH_POLLS) {
          throw new ValidationError(`批量发题需要 2～${MAX_BATCH_POLLS} 道题`);
        }
        this.createQuestions(questions, data);
        shouldBroadcast = true;
        shouldSyncAlarm = true;
      } else if (action === "append_question") {
        this.appendQuestion(data);
        shouldBroadcast = true;
      } else if (action === "deadline") {
        this.changeDeadline(data);
        shouldBroadcast = true;
        shouldSyncAlarm = true;
      } else if (action === "close" || action === "publish") {
        this.transitionPhase(data.poll_id, action === "close" ? "closed" : "published");
        if (action === "publish") {
          this.clearAllViewed();
        }
        shouldBroadcast = true;
        shouldSyncAlarm = true;
      } else if (action === "show_result") {
        this.showResult(data.batch_id, data.poll_id);
        this.clearAllViewed();
        shouldBroadcast = true;
      } else if (action === "forget") {
        const device = data.device_id;
        if (typeof device !== "string" || !DEVICE_ID_RE.test(device)) {
          throw new ValidationError("设备编号无效");
        }
        if (this.onlineDeviceSet().has(device)) {
          throw new ValidationError("请先断开该设备");
        }
        this.sql.exec("DELETE FROM devices WHERE id = ?", device);
      } else if (action === "alias") {
        this.setAlias(data.device_id, data.alias ?? "");
      } else if (action === "device_limit") {
        this.setDeviceLimit(data.limit);
      } else if (action === "library_save") {
        this.saveLibraryQuestion(data);
      } else if (action === "history_delete") {
        this.deleteReport(data.batch_id);
      } else if (action === "rotate_join_code") {
        const nextCode = randomJoinCode();
        this.setSetting("join_code", nextCode);
        extra.join_code = nextCode;
      } else if (action === "rotate_stage_token") {
        const nextToken = randomHex(18);
        this.setSetting("stage_token", nextToken);
        extra.stage_share_path = `/?view=stage&stage_token=${encodeURIComponent(nextToken)}`;
      } else if (action === "open_join") {
        throw new ValidationError("云端模式暂不支持免码一键入场，请使用 6 位入场码");
      } else {
        throw new ValidationError("操作无效");
      }

      if (shouldSyncAlarm) {
        await this.syncDeadlineAlarm();
      }
      if (shouldBroadcast) {
        const pushed = this.broadcastToDevices();
        if (action === "create" || action === "create_batch" || action === "append_question") {
          return { ok: true, pushed_to: pushed };
        }
      }
      return { ok: true, ...extra };
    } catch (err) {
      if (err instanceof ValidationError) {
        return { error: err.message, status: err.status };
      }
      console.error(JSON.stringify({ message: "admin action failed", action, error: String(err) }));
      return { error: "数据写入失败，操作未确认；请稍后重试", status: 500 };
    }
  }

  private createQuestions(questions: unknown[], data: Record<string, unknown>): void {
    const entries = questions.map((question, idx) => {
      try {
        return readQuestion(question);
      } catch (err) {
        if (questions.length === 1 || !(err instanceof ValidationError)) throw err;
        throw new ValidationError(`第 ${idx + 1} 题：${err.message}`);
      }
    });

    const now = Date.now();
    this.ensureUpToDate(now);
    this.ctx.storage.transactionSync(() => {
      const poll = this.latestBatch();
      if (poll && poll.phase !== "published") {
        throw new ValidationError("请先公布当前投票的结果，再发起新题");
      }
      if ("previous_id" in data && data.previous_id !== (poll ? poll.id : null)) {
        throw new ValidationError("当前投票已变更，请刷新后操作");
      }
      const deadline = readDeadline(data, now);
      const batchId = randomHex(8);
      entries.forEach((entry, idx) => {
        const id = idx === 0 ? batchId : randomHex(8);
        this.sql.exec(
          `INSERT INTO polls (id, title, options, mode, correct_choice, phase, created, deadline_at_ms, batch_id)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
          id,
          entry.title,
          entry.optionsJson,
          entry.mode,
          entry.correctChoice,
          now / 1000,
          deadline,
          batchId,
        );
      });
    });
  }

  private appendQuestion(data: Record<string, unknown>): void {
    const entry = readQuestion(data);
    const questionId = data.question_id;
    if (typeof questionId !== "string" || !HEX16_RE.test(questionId)) {
      throw new ValidationError("追加题目的编号无效");
    }
    const now = Date.now();
    this.ensureUpToDate(now);
    this.ctx.storage.transactionSync(() => {
      const batch = this.latestBatch();
      if (!batch || batch.id !== data.batch_id) {
        throw new ValidationError("场次已变更，请核对当前投票");
      }
      const existing = this.sql
        .exec<{
          batch_id: string;
          title: string;
          options: string;
          mode: PollMode;
          correct_choice: number | null;
        }>("SELECT batch_id, title, options, mode, correct_choice FROM polls WHERE id = ?", questionId)
        .toArray()[0];
      if (existing) {
        if (
          questionId !== batch.id &&
          existing.batch_id === batch.id &&
          existing.title === entry.title &&
          existing.options === entry.optionsJson &&
          existing.mode === entry.mode &&
          existing.correct_choice === entry.correctChoice
        ) {
          return;
        }
        throw new ValidationError("这个题号已用于其他内容，请重新添加");
      }
      if (batch.phase !== "open") {
        throw new ValidationError("本场已结束收票，不能追加题目");
      }
      const countRow = this.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM polls WHERE batch_id = ?", batch.id)
        .toArray()[0];
      if ((countRow?.count ?? 0) >= MAX_BATCH_POLLS) {
        throw new ValidationError(`本场已达到 ${MAX_BATCH_POLLS} 题上限`);
      }
      this.sql.exec(
        `INSERT INTO polls (id, title, options, mode, correct_choice, phase, created, deadline_at_ms, batch_id)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        questionId,
        entry.title,
        entry.optionsJson,
        entry.mode,
        entry.correctChoice,
        now / 1000,
        batch.deadline_at_ms,
        batch.id,
      );
    });
  }

  private changeDeadline(data: Record<string, unknown>): void {
    const now = Date.now();
    this.ensureUpToDate(now);
    this.ctx.storage.transactionSync(() => {
      const poll = this.latestBatch();
      if (!poll || poll.id !== data.poll_id) {
        throw new ValidationError("题目已变更，请刷新后操作");
      }
      if (poll.phase !== "open") {
        throw new ValidationError("投票已截止，不能修改截止时间");
      }
      if (!("duration_seconds" in data) && !("deadline_at_ms" in data)) {
        throw new ValidationError("请选择截止方式");
      }
      const deadline = readDeadline(data, now);
      this.sql.exec("UPDATE polls SET deadline_at_ms = ? WHERE batch_id = ?", deadline, poll.id);
    });
  }

  private transitionPhase(pollId: unknown, phase: "closed" | "published"): void {
    const now = Date.now();
    this.ensureUpToDate(now);
    this.ctx.storage.transactionSync(() => {
      const poll = this.latestBatch();
      if (!poll || poll.id !== pollId) {
        throw new ValidationError("题目已变更，请刷新后操作");
      }
      if (phase === "closed" && poll.phase !== "open") {
        throw new ValidationError("当前题目已截止");
      }
      if (phase === "published" && poll.phase === "published") {
        return;
      }
      this.finishBatch(poll, phase, now);
    });
  }

  private showResult(batchId: unknown, pollId: unknown): void {
    this.ensureUpToDate();
    this.ctx.storage.transactionSync(() => {
      const batch = this.latestBatch();
      if (!batch || batch.id !== batchId || batch.phase !== "published") {
        throw new ValidationError("请先公布本组结果");
      }
      if (
        typeof pollId !== "string" ||
        !this.sql
          .exec("SELECT 1 FROM polls WHERE id = ? AND batch_id = ?", pollId, batchId)
          .toArray()[0]
      ) {
        throw new ValidationError("该题不在当前投票中");
      }
      this.setSetting("shown_result", pollId);
    });
  }

  private setAlias(device: unknown, alias: unknown): void {
    if (typeof device !== "string" || !DEVICE_ID_RE.test(device)) {
      throw new ValidationError("设备编号无效");
    }
    if (typeof alias !== "string") {
      throw new ValidationError("设备备注必须是文字");
    }
    const cleaned = alias.trim();
    if (Array.from(cleaned).length > MAX_ALIAS_LENGTH) {
      throw new ValidationError(`设备备注最多 ${MAX_ALIAS_LENGTH} 个字符`);
    }
    for (const ch of cleaned) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code === 127) {
        throw new ValidationError("设备备注不能包含换行或控制字符");
      }
    }
    this.ctx.storage.transactionSync(() => {
      if (!this.sql.exec("SELECT 1 FROM devices WHERE id = ?", device).toArray()[0]) {
        throw new ValidationError("该设备尚未登记");
      }
      const mapping = this.getAliases();
      if (cleaned) {
        mapping[device] = cleaned;
      } else {
        delete mapping[device];
      }
      this.setSetting("device_aliases", JSON.stringify(mapping));
    });
  }

  private setDeviceLimit(limit: unknown): void {
    if (!isStrictInt(limit) || limit < 1 || limit > MAX_DEVICE_LIMIT) {
      throw new ValidationError(`请输入 1～${MAX_DEVICE_LIMIT} 的整数作为设备上限`);
    }
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM devices")
        .toArray()[0];
      const registered = row ? row.count : 0;
      if (limit < registered) {
        throw new ValidationError(`已有 ${registered} 台设备登记，设备上限不能更低。可先移除离线设备`);
      }
      this.setSetting("device_limit", String(limit));
    });
  }

  private saveLibraryQuestion(data: Record<string, unknown>): void {
    const questionId = data.id;
    const revision = data.revision ?? null;
    if (typeof questionId !== "string" || !HEX16_RE.test(questionId)) {
      throw new ValidationError("题库编号无效");
    }
    if (revision !== null && (!isStrictInt(revision) || revision < 1)) {
      throw new ValidationError("题库版本无效");
    }
    const entry = readQuestion(data);
    this.ctx.storage.transactionSync(() => {
      const current = this.sql
        .exec<{
          title: string;
          options: string;
          mode: PollMode;
          correct_choice: number | null;
          revision: number;
        }>("SELECT title, options, mode, correct_choice, revision FROM question_library WHERE id = ?", questionId)
        .toArray()[0];
      if (!current) {
        if (revision !== null) {
          throw new ValidationError("找不到这道题，请返回题库再试");
        }
        this.sql.exec(
          `INSERT INTO question_library (id, title, options, mode, correct_choice, revision, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
          questionId,
          entry.title,
          entry.optionsJson,
          entry.mode,
          entry.correctChoice,
          Date.now(),
        );
        return;
      }
      if (
        current.title === entry.title &&
        current.options === entry.optionsJson &&
        current.mode === entry.mode &&
        current.correct_choice === entry.correctChoice
      ) {
        return;
      }
      if (revision !== current.revision) {
        throw new ValidationError("题库里的这道题已有新版本，请返回题库重新打开");
      }
      this.sql.exec(
        `UPDATE question_library
         SET title = ?, options = ?, mode = ?, correct_choice = ?, revision = revision + 1, updated_at_ms = ?
         WHERE id = ?`,
        entry.title,
        entry.optionsJson,
        entry.mode,
        entry.correctChoice,
        Date.now(),
        questionId,
      );
    });
  }

  private deleteReport(batchId: unknown): void {
    if (typeof batchId !== "string" || !HEX16_RE.test(batchId)) {
      throw new ValidationError("投票记录编号无效");
    }
    this.ctx.storage.transactionSync(() => {
      const existed = this.sql
        .exec("SELECT 1 FROM poll_reports WHERE batch_id = ?", batchId)
        .toArray()[0];
      if (existed) {
        this.sql.exec("DELETE FROM poll_reports WHERE batch_id = ?", batchId);
        this.sql.exec("UPDATE polls SET history_deleted = 1 WHERE id = ?", batchId);
        return;
      }
      const alreadyDeleted = this.sql
        .exec("SELECT 1 FROM polls WHERE id = ? AND history_deleted = 1", batchId)
        .toArray()[0];
      if (!alreadyDeleted) {
        throw new ValidationError("找不到可删除的历史记录");
      }
    });
  }
}
