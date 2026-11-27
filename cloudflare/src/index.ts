import { VotingRoom } from "./voting-room.js";
import { MAX_ADMIN_BODY_BYTES, SESSION_TTL_MS, formatReportCsv } from "./validation.js";

export { VotingRoom };

const SESSION_COOKIE = "gx_session";
const STATIC_FILES = new Set([
  "/",
  "/index.html",
  "/app.js",
  "/style.css",
  "/font-coverage.json",
  "/favicon.ico",
]);

const CSP_HEADER =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'";

function parseCookies(header: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

function buildSessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function checkSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return origin === url.origin;
}

function isLocalhost(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

function getRoomStub(env: Env): DurableObjectStub<VotingRoom> {
  const roomName = (env.ROOM_NAME || "default").trim() || "default";
  return env.VOTING_ROOM.getByName(roomName);
}

function buildWsUrl(url: URL): string {
  const proto = url.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${url.host}/ws`;
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const lenHeader = request.headers.get("Content-Length");
  if (lenHeader) {
    const declared = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_ADMIN_BODY_BYTES) {
      throw new Error("请求体过大");
    }
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_ADMIN_BODY_BYTES) {
    throw new Error("请求体过大");
  }
  const text = new TextDecoder().decode(buf);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求格式无效");
  }
  return parsed as Record<string, unknown>;
}

function jsonNoStore(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

async function isAuthorizedAdmin(
  request: Request,
  url: URL,
  env: Env,
  stub: DurableObjectStub<VotingRoom>,
): Promise<boolean> {
  if (env.ALLOW_UNAUTHENTICATED_LOCAL === "true" && isLocalhost(url)) {
    return true;
  }
  const cookies = parseCookies(request.headers.get("Cookie"));
  const token = cookies[SESSION_COOKIE] ?? null;
  return stub.verifySession(token);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 1. 投票器硬件 WebSocket 接入（兼容原有 /ws 协议）
      if (path === "/ws") {
        if (request.method !== "GET") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        const stub = getRoomStub(env);
        return stub.fetch(request);
      }

      // 2. 认证状态 / 登录 / 登出
      if (path === "/api/auth/status" && request.method === "GET") {
        const stub = getRoomStub(env);
        const configured = Boolean(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 4);
        const authenticated = await isAuthorizedAdmin(request, url, env, stub);
        return jsonNoStore({
          cloud_mode: true,
          password_configured: configured,
          authenticated,
        });
      }

      if (path === "/api/auth/login" && request.method === "POST") {
        if (!checkSameOrigin(request, url)) {
          return jsonNoStore({ error: "不允许跨站请求" }, 403);
        }
        const expected = env.ADMIN_PASSWORD;
        if (!expected || expected.length < 4) {
          return jsonNoStore(
            { error: "服务端尚未设置 ADMIN_PASSWORD，请先执行 wrangler secret put ADMIN_PASSWORD" },
            503,
          );
        }
        let body: Record<string, unknown>;
        try {
          body = await readBoundedJson(request);
        } catch (err) {
          return jsonNoStore({ error: err instanceof Error ? err.message : "请求格式无效" }, 400);
        }
        const password = typeof body.password === "string" ? body.password : "";
        const stub = getRoomStub(env);
        const result = await stub.login(password, expected);
        if (!result.ok) {
          return jsonNoStore({ error: result.error }, result.status);
        }
        const cookie = buildSessionCookie(result.token, url.protocol === "https:", Math.floor(SESSION_TTL_MS / 1000));
        return jsonNoStore({ ok: true }, 200, { "Set-Cookie": cookie });
      }

      if (path === "/api/auth/logout" && request.method === "POST") {
        if (!checkSameOrigin(request, url)) {
          return jsonNoStore({ error: "不允许跨站请求" }, 403);
        }
        const cookies = parseCookies(request.headers.get("Cookie"));
        const stub = getRoomStub(env);
        await stub.logout(cookies[SESSION_COOKIE] ?? null);
        const expired = buildSessionCookie("", url.protocol === "https:", 0);
        return jsonNoStore({ ok: true }, 200, { "Set-Cookie": expired });
      }

      // 3. 主持台状态（支持已登录管理员，或携带合法只读 stage_token 的投屏大屏）
      if (path === "/api/state" && request.method === "GET") {
        const stub = getRoomStub(env);
        const authed = await isAuthorizedAdmin(request, url, env, stub);
        if (authed) {
          const state = await stub.getHostState(buildWsUrl(url), false);
          return jsonNoStore(state);
        }
        const stageToken = url.searchParams.get("stage_token");
        if (stageToken && (await stub.verifyStageToken(stageToken))) {
          const state = await stub.getHostState(buildWsUrl(url), true);
          return jsonNoStore(state);
        }
        return jsonNoStore({ error: "请先登录主持台", auth_required: true }, 401);
      }

      // 4. 其余管理端只读接口（题库 / 历史 / CSV）
      if (path === "/api/question_library" && request.method === "GET") {
        const stub = getRoomStub(env);
        if (!(await isAuthorizedAdmin(request, url, env, stub))) {
          return jsonNoStore({ error: "请先登录主持台", auth_required: true }, 401);
        }
        return jsonNoStore(await stub.getQuestionLibrary());
      }

      if (path === "/api/history" && request.method === "GET") {
        const stub = getRoomStub(env);
        if (!(await isAuthorizedAdmin(request, url, env, stub))) {
          return jsonNoStore({ error: "请先登录主持台", auth_required: true }, 401);
        }
        const beforeRaw = url.searchParams.get("before");
        let before: number | null = null;
        if (beforeRaw !== null) {
          if (!/^[1-9][0-9]{0,18}$/.test(beforeRaw)) {
            return new Response("历史分页编号无效", { status: 400 });
          }
          const parsed = Number(beforeRaw);
          if (!Number.isSafeInteger(parsed)) {
            return new Response("历史分页编号无效", { status: 400 });
          }
          before = parsed;
        }
        return jsonNoStore(await stub.getHistory(before));
      }

      const historyCsvMatch = path.match(/^\/api\/history\/([0-9a-f]+)\/csv$/);
      if (historyCsvMatch && request.method === "GET") {
        const stub = getRoomStub(env);
        if (!(await isAuthorizedAdmin(request, url, env, stub))) {
          return jsonNoStore({ error: "请先登录主持台", auth_required: true }, 401);
        }
        const report = await stub.getReport(historyCsvMatch[1]);
        if (!report) {
          return new Response("找不到已结束的投票", { status: 404 });
        }
        return new Response(formatReportCsv(report), {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="vote-${report.id}.csv"`,
            "Cache-Control": "no-store",
          },
        });
      }

      const historyDetailMatch = path.match(/^\/api\/history\/([0-9a-f]+)$/);
      if (historyDetailMatch && request.method === "GET") {
        const stub = getRoomStub(env);
        if (!(await isAuthorizedAdmin(request, url, env, stub))) {
          return jsonNoStore({ error: "请先登录主持台", auth_required: true }, 401);
        }
        const report = await stub.getReport(historyDetailMatch[1]);
        if (!report) {
          return new Response("找不到已结束的投票", { status: 404 });
        }
        return jsonNoStore(report);
      }

      // 5. 主持台写操作接口
      const actionMatch = path.match(/^\/api\/([a-z_]+)$/);
      if (actionMatch && request.method === "POST") {
        if (!checkSameOrigin(request, url)) {
          return jsonNoStore({ error: "不允许跨站请求" }, 403);
        }
        const stub = getRoomStub(env);
        if (!(await isAuthorizedAdmin(request, url, env, stub))) {
          return jsonNoStore({ error: "主持会话失效，请重新登录", auth_required: true }, 401);
        }
        const nonce = request.headers.get("X-Host-Nonce");
        if (!(await stub.verifyNonce(nonce))) {
          return jsonNoStore({ error: "主持会话失效，请刷新页面" }, 403);
        }
        let body: Record<string, unknown>;
        try {
          body = await readBoundedJson(request);
        } catch (err) {
          return jsonNoStore({ error: err instanceof Error ? err.message : "请求格式无效" }, 400);
        }
        const result = await stub.handleAdminAction(actionMatch[1], body);
        if ("error" in result) {
          return jsonNoStore({ error: result.error }, result.status);
        }
        return jsonNoStore(result);
      }

      // 6. 静态前端资源（复用 host/static，附加安全头）
      if ((request.method === "GET" || request.method === "HEAD") && STATIC_FILES.has(path)) {
        const assetResp = await env.ASSETS.fetch(request);
        const headers = new Headers(assetResp.headers);
        headers.set("Content-Security-Policy", CSP_HEADER);
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "same-origin");
        return new Response(assetResp.body, {
          status: assetResp.status,
          statusText: assetResp.statusText,
          headers,
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ message: "unhandled worker error", path, method: request.method, error: message }));
      return jsonNoStore({ error: "服务内部异常，请稍后重试" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
