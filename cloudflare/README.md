# 共选 · Cloudflare 云端主持台

将「共选」投票主持台部署到 **Cloudflare Workers + Durable Objects（SQLite + WebSocket Hibernation + Alarms）**，彻底摆脱主持电脑：

- **开箱即用免域名**：默认使用 Cloudflare 免费提供的 `https://<worker-name>.<你的子域>.workers.dev`，无需绑定自定义域名；也支持通过 `wrangler.local.jsonc` 绑定自己的 Cloudflare 域名（国内网络直连更稳定）。
- **手机直接控场**：iPhone / Android 浏览器直接打开页面，输入管理员密码即可发题、计票、公布、导出 CSV/PNG，手机随时息屏或切换应用也不影响收票与定时截止。
- **大屏只读投屏**：主持台一键复制「大屏只读链接」，可在现场任意电脑/平板免登录投屏，且自动屏蔽控场按钮防误触。
- **原生兼容硬件投票器**：配合本分支升级后的 ESP32-C3 固件（支持 `wss://` TLS 加密连接），投票器连上任意可上网的 2.4 GHz Wi-Fi 或手机热点即可接入，同时完整保留原有局域网模式。

---

## 快速部署步骤

### 1. 安装依赖并同步前端资源

```bash
cd cloudflare
npm install
npm run sync:assets
```

### 2. 登录 Cloudflare（如尚未登录）

```bash
npx wrangler login
```

### 3. 部署到 `*.workers.dev`（免自定义域名）

```bash
npm run deploy
```

部署成功后终端会输出类似地址：

```text
https://gongxuan-vote.<你的子域>.workers.dev
```

### 4. 设置主持台管理员密码（必须，防止公网未授权操作）

```bash
npx wrangler secret put ADMIN_PASSWORD
```

> 密码通过 Cloudflare Secrets 加密存储，不会写入源码或配置文件；修改密码直接重新执行此命令即可。

### （可选）绑定自己的 Cloudflare 自定义域名

如果在国内网络环境下 `*.workers.dev` 访问不稳定，可将 [wrangler.jsonc](wrangler.jsonc) 复制为本机专用的 `wrangler.local.jsonc`（已被 `.gitignore` 忽略，不会提交到 GitHub），取消 `routes` 注释并填入你的域名：

```jsonc
"routes": [
  {
    "pattern": "vote.example.com",
    "custom_domain": true
  }
]
```

然后执行：

```bash
npm run deploy:custom
```

Cloudflare 会自动配置 DNS 记录并签发免费 Edge SSL 证书，ESP32-C3 固件内置的根证书包原生信任。

---

## 现场使用流程

1. **手机控场**：手机浏览器打开你的主持台 HTTPS 地址，输入 `ADMIN_PASSWORD` 登录（会话默认保持 30 天）。
2. **投票器配网**：
   - 先给 AI Passport 投票器刷写本分支构建的固件（支持 `wss://` 与常用根证书包）。
   - 手机扫码加入投票器热点并打开配网页（`http://192.168.4.1/`），选现场 2.4 GHz Wi-Fi 或手机热点。
   - 点开「**云端主持台或手动指定地址**」，填入你的域名（如 `vote.example.com` 或 `gongxuan-vote.<子域>.workers.dev`，会自动补全为 `wss://.../ws`），输入主持台显示的 6 位入场码并提交。
   - 下次更换场地 Wi-Fi 时，配网页会自动回填上次保存的云端地址，无需重输。
3. **现场大屏**：在手机主持台「参与设备」区域点击「**复制大屏只读链接**」，发给现场投影电脑的浏览器打开即可。

---

## 本地开发与自动化测试

```bash
cd cloudflare
cp .dev.vars.example .dev.vars   # 按需修改本地 ADMIN_PASSWORD
npm run dev                      # 本地启动 http://127.0.0.1:8787
npm run typecheck                # TypeScript 类型检查
npm test                         # 在真实 workerd 运行时运行 Vitest 全套测试
npm run deploy:dry-run           # 构建并干跑部署检查（不上传线上）
```
