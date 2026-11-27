import { env, exports as workerExports } from "cloudflare:workers";
import { evictDurableObject, reset, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const ORIGIN = "https://gongxuan-vote.example.workers.dev";
const PASSWORD = "test-admin-password-2026";

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  return workerExports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function loginAdmin(): Promise<{ cookie: string; nonce: string; joinCode: string; stagePath: string }> {
  const loginResp = await workerFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(loginResp.status).toBe(200);
  const setCookie = loginResp.headers.get("Set-Cookie") ?? "";
  const match = setCookie.match(/gx_session=[0-9a-f]{64}/);
  expect(match).not.toBeNull();
  const cookie = match![0];

  const stateResp = await workerFetch("/api/state", { headers: { Cookie: cookie } });
  expect(stateResp.status).toBe(200);
  const state = (await stateResp.json()) as {
    nonce: string;
    join_code: string;
    stage_share_path: string;
    cloud_mode: boolean;
    readonly_stage: boolean;
    ws_url: string;
  };
  expect(state.cloud_mode).toBe(true);
  expect(state.readonly_stage).toBe(false);
  expect(state.ws_url).toBe("wss://gongxuan-vote.example.workers.dev/ws");
  return {
    cookie,
    nonce: state.nonce,
    joinCode: state.join_code,
    stagePath: state.stage_share_path,
  };
}

async function adminPost(cookie: string, nonce: string, action: string, body: unknown): Promise<Response> {
  return workerFetch(`/api/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Host-Nonce": nonce,
      Origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

class DeviceClient {
  readonly ws: WebSocket;
  private readonly queue: string[] = [];
  private waiters: Array<(msg: string) => void> = [];
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.accept();
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      const waiter = this.waiters.shift();
      if (waiter) waiter(text);
      else this.queue.push(text);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
    });
  }

  static async connect(): Promise<DeviceClient> {
    const resp = await workerFetch("/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(resp.status).toBe(101);
    expect(resp.webSocket).toBeDefined();
    return new DeviceClient(resp.webSocket!);
  }

  sendJson(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  async nextJson<T = Record<string, unknown>>(timeoutMs = 2000): Promise<T> {
    if (this.queue.length > 0) {
      return JSON.parse(this.queue.shift()!) as T;
    }
    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket message timeout")), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
    return JSON.parse(raw) as T;
  }

  close(): void {
    try {
      this.ws.close(1000, "test done");
    } catch {
      // ignore
    }
  }
}

describe("共选 Cloudflare Workers + Durable Objects 主持台", () => {
  afterEach(async () => {
    await reset();
  });

  it("保护管理接口、支持只读大屏令牌并抵御跨站与缺 Nonce 请求", async () => {
    const unauthState = await workerFetch("/api/state");
    expect(unauthState.status).toBe(401);
    expect(await unauthState.json()).toMatchObject({ auth_required: true });

    const wrongLogin = await workerFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(wrongLogin.status).toBe(401);

    const { cookie, nonce, stagePath } = await loginAdmin();

    // 缺少 X-Host-Nonce 应被 403 拦截
    const missingNonce = await workerFetch("/api/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ title: "测试", options: ["甲", "乙"] }),
    });
    expect(missingNonce.status).toBe(403);

    // 跨站 Origin 应被 403 拦截
    const evilOrigin = await workerFetch("/api/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Host-Nonce": nonce,
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ title: "测试", options: ["甲", "乙"] }),
    });
    expect(evilOrigin.status).toBe(403);

    // 只读大屏令牌免登录读取状态，但不暴露 nonce
    const stageToken = new URL(stagePath, ORIGIN).searchParams.get("stage_token")!;
    const stageResp = await workerFetch(`/api/state?stage_token=${encodeURIComponent(stageToken)}`);
    expect(stageResp.status).toBe(200);
    const stageState = (await stageResp.json()) as Record<string, unknown>;
    expect(stageState.readonly_stage).toBe(true);
    expect(stageState.nonce).toBeUndefined();
    expect(stageState.stage_share_path).toBeUndefined();

    // 退出登录后原 Cookie 失效
    const logoutResp = await workerFetch("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    expect(logoutResp.status).toBe(200);
    const afterLogout = await workerFetch("/api/state", { headers: { Cookie: cookie } });
    expect(afterLogout.status).toBe(401);
  });

  it("完整覆盖批量四模式发题、首票锁定、追加题、归档导出、题库及 DO 驱逐持久化", async () => {
    const { cookie, nonce, joinCode } = await loginAdmin();

    // 非法字库字符被拒
    const emojiResp = await adminPost(cookie, nonce, "create", {
      title: "喜欢😀吗",
      options: ["喜欢", "一般"],
    });
    expect(emojiResp.status).toBe(400);
    expect((await emojiResp.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("字库暂不支持"),
    });

    // 连接 2 台投票器（含错码拒收测试）
    const badDev = await DeviceClient.connect();
    badDev.sendJson({ v: 1, type: "hello", device_id: "aabbcc000099", code: "000000" });
    const badReply = await badDev.nextJson<{ type: string; message: string }>();
    expect(badReply.type).toBe("error");
    expect(badReply.message).toContain("入场码");
    badDev.close();

    const dev1 = await DeviceClient.connect();
    const dev2 = await DeviceClient.connect();
    dev1.sendJson({ v: 1, type: "hello", device_id: "aabbcc000001", code: joinCode });
    dev2.sendJson({ v: 1, type: "hello", device_id: "aabbcc000002", code: joinCode });
    expect((await dev1.nextJson<{ poll: unknown }>()).poll).toBeNull();
    expect((await dev2.nextJson<{ poll: unknown }>()).poll).toBeNull();

    // 发起 4 题混合模式批量投票
    const batchResp = await adminPost(cookie, nonce, "create_batch", {
      questions: [
        { title: "=活动地点", options: ["公园", "博物馆"], mode: "single" },
        { title: "是否通过预算", mode: "approval" },
        { title: "整体满意度", mode: "rating" },
        { title: "哪种是水果", options: ["苹果", "白菜"], mode: "quiz", correct_choice: 0 },
      ],
    });
    expect(batchResp.status).toBe(200);
    expect(await batchResp.json()).toEqual({ ok: true, pushed_to: 2 });

    const snap1 = await dev1.nextJson<{ poll: { id: string; batch: { index: number; count: number; answered: number } } }>();
    const snap2 = await dev2.nextJson<{ poll: { id: string } }>();
    expect(snap1.poll.batch).toEqual({ index: 1, count: 4, answered: 0 });
    expect(snap2.poll.id).toBe(snap1.poll.id);

    const state1 = (await (await workerFetch("/api/state", { headers: { Cookie: cookie } })).json()) as {
      batch: { id: string; polls: Array<{ id: string }> };
    };
    const [q1, q2, q3, q4] = state1.batch.polls.map((p) => p.id);

    // 跳题提交应被拒绝
    dev1.sendJson({ v: 1, type: "vote", poll_id: q2, choice: 0 });
    const skipErr = await dev1.nextJson<{ type: string; message: string }>();
    expect(skipErr.type).toBe("error");
    expect(skipErr.message).toContain("上一题");
    await dev1.nextJson(); // 紧随其后的状态快照

    // dev1 顺序答完前 4 题，并测首票锁定 + 幂等重试
    dev1.sendJson({ v: 1, type: "vote", poll_id: q1, choice: 1 });
    const afterQ1 = await dev1.nextJson<{ poll: { id: string; batch: { index: number; answered: number } } }>();
    expect(afterQ1.poll.id).toBe(q2);
    expect(afterQ1.poll.batch.answered).toBe(1);

    // 幂等重发原选择允许通过
    dev1.sendJson({ v: 1, type: "vote", poll_id: q1, choice: 1 });
    const idempotent = await dev1.nextJson<{ type: string }>();
    expect(idempotent.type).toBe("state");

    // 改选原题应被锁定拒绝
    dev1.sendJson({ v: 1, type: "vote", poll_id: q1, choice: 0 });
    const lockErr = await dev1.nextJson<{ type: string; message: string }>();
    expect(lockErr.type).toBe("error");
    expect(lockErr.message).toContain("锁定");
    await dev1.nextJson();

    dev1.sendJson({ v: 1, type: "vote", poll_id: q2, choice: 0 });
    await dev1.nextJson();
    dev1.sendJson({ v: 1, type: "vote", poll_id: q3, choice: 4 });
    await dev1.nextJson();
    dev1.sendJson({ v: 1, type: "vote", poll_id: q4, choice: 0 });
    const doneAll = await dev1.nextJson<{ poll: { batch: { answered: number; count: number } } }>();
    expect(doneAll.poll.batch.answered).toBe(4);

    // 收票中追加第 5 题（测幂等重试）
    const appendBody = {
      batch_id: q1,
      question_id: "0123456789abcdef",
      title: "临时加题",
      options: ["同意", "不同意"],
      mode: "single",
    };
    const appResp1 = await adminPost(cookie, nonce, "append_question", appendBody);
    expect(appResp1.status).toBe(200);
    const appResp2 = await adminPost(cookie, nonce, "append_question", appendBody);
    expect(appResp2.status).toBe(200);

    const dev1NewQ = await dev1.nextJson<{ poll: { id: string; batch: { index: number; count: number } } }>();
    expect(dev1NewQ.poll.id).toBe("0123456789abcdef");
    expect(dev1NewQ.poll.batch.count).toBe(5);
    await dev1.nextJson(); // 第二次幂等广播
    await dev2.nextJson();
    await dev2.nextJson();

    // 题库保存与乐观锁校验 + 设备备注
    expect((await adminPost(cookie, nonce, "alias", { device_id: "aabbcc000001", alias: "1号评委" })).status).toBe(200);
    const libId = "fedcba9876543210";
    expect(
      (await adminPost(cookie, nonce, "library_save", { id: libId, revision: null, title: "常驻题", options: ["好", "不好"], mode: "single" })).status,
    ).toBe(200);
    expect(
      (await adminPost(cookie, nonce, "library_save", { id: libId, revision: 1, title: "常驻题新版", options: ["好", "不好"], mode: "single" })).status,
    ).toBe(200);
    // 旧 revision 应报冲突
    const conflictResp = await adminPost(cookie, nonce, "library_save", {
      id: libId,
      revision: 1,
      title: "冲突覆盖",
      options: ["好", "不好"],
      mode: "single",
    });
    expect(conflictResp.status).toBe(400);

    // 公布结果并检查设备收到统计 + 切题
    expect((await adminPost(cookie, nonce, "publish", { poll_id: q1 })).status).toBe(200);
    const pub1 = await dev1.nextJson<{ poll: { phase: string; counts: number[]; total: number; batch: { next: string } } }>();
    expect(pub1.poll.phase).toBe("published");
    expect(pub1.poll.counts).toEqual([0, 1]);
    expect(pub1.poll.total).toBe(1);
    expect(pub1.poll.batch.next).toBe(q2);
    await dev2.nextJson();

    // 驱逐 Durable Object 模拟休眠/重启，验证 SQLite 状态与 Session 完全保留
    const stub = env.VOTING_ROOM.getByName("default");
    await evictDurableObject(stub);

    const afterEvict = (await (await workerFetch("/api/state", { headers: { Cookie: cookie } })).json()) as {
      devices: Array<{ id: string; alias: string; online: boolean }>;
      history_count: number;
    };
    expect(afterEvict.history_count).toBe(1);
    expect(afterEvict.devices.find((d) => d.id === "aabbcc000001")?.alias).toBe("1号评委");

    // 检查 CSV 导出包含 UTF-8 BOM（EF BB BF）、公式转义与模式统计
    const csvResp = await workerFetch(`/api/history/${q1}/csv`, { headers: { Cookie: cookie } });
    expect(csvResp.status).toBe(200);
    const csvBytes = new Uint8Array(await csvResp.arrayBuffer());
    expect(Array.from(csvBytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csvText = new TextDecoder("utf-8").decode(csvBytes);
    expect(csvText).toContain("'=活动地点");
    expect(csvText).toContain("平均 5.00 分");
    expect(csvText).toContain("答对 1 人");

    // 更换入场码
    const rotateResp = await adminPost(cookie, nonce, "rotate_join_code", {});
    expect(rotateResp.status).toBe(200);
    const rotated = (await rotateResp.json()) as { join_code: string };
    expect(rotated.join_code).toMatch(/^[0-9]{6}$/);

    // 删除历史记录
    expect((await adminPost(cookie, nonce, "history_delete", { batch_id: q1 })).status).toBe(200);
    const histAfterDel = (await (await workerFetch("/api/history", { headers: { Cookie: cookie } })).json()) as {
      reports: unknown[];
    };
    expect(histAfterDel.reports).toEqual([]);

    dev1.close();
    dev2.close();
  });

  it("支持定时截止 Alarm 自动收票并归档，且能正确切换回手动截止", async () => {
    const { cookie, nonce, joinCode } = await loginAdmin();
    const dev = await DeviceClient.connect();
    dev.sendJson({ v: 1, type: "hello", device_id: "aabbcc000010", code: joinCode });
    await dev.nextJson();

    const startResp = await adminPost(cookie, nonce, "create", {
      title: "限时快投",
      options: ["A", "B"],
      duration_seconds: 60,
    });
    expect(startResp.status).toBe(200);
    const opened = await dev.nextJson<{ poll: { id: string; phase: string; remaining_ms: number } }>();
    expect(opened.poll.phase).toBe("open");
    expect(opened.poll.remaining_ms).toBeGreaterThan(0);

    // 改回手动截止会取消 Alarm
    const toManual = await adminPost(cookie, nonce, "deadline", {
      poll_id: opened.poll.id,
      deadline_at_ms: null,
    });
    expect(toManual.status).toBe(200);
    const manualSnap = await dev.nextJson<{ poll: { remaining_ms?: number } }>();
    expect(manualSnap.poll.remaining_ms).toBeUndefined();

    // 再设一个 80ms 后到期的截止时间，验证 Durable Object Alarm 准时自动触发、关闭收票并推送给在线设备
    const stub = env.VOTING_ROOM.getByName("default");
    const shortDeadline = Date.now() + 80;
    const setShort = await adminPost(cookie, nonce, "deadline", {
      poll_id: opened.poll.id,
      deadline_at_ms: shortDeadline,
    });
    expect(setShort.status).toBe(200);
    await dev.nextJson();

    const closedSnap = await dev.nextJson<{ poll: { phase: string; remaining_ms?: number } }>(3000);
    expect(closedSnap.poll.phase).toBe("closed");
    expect(closedSnap.poll.remaining_ms).toBeUndefined();
    // 截止完成后不再残留待执行 Alarm
    expect(await runDurableObjectAlarm(stub)).toBe(false);

    // 截止后迟到投票应被拒
    dev.sendJson({ v: 1, type: "vote", poll_id: opened.poll.id, choice: 0 });
    const lateErr = await dev.nextJson<{ type: string; message: string }>();
    expect(lateErr.type).toBe("error");
    expect(lateErr.message).toContain("截止");

    dev.close();
  });
});
