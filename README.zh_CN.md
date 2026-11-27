**简体中文** · [English](README.md)

# 共选 · 多人互动硬件投票器（云端手机控场 + 局域网双模版）

**共选**是一套面向线下活动、课堂、评审与会议的软硬件结合多人实时投票系统。每位参与者手持一台 **FoloToy AI Passport（ESP32-C3、8 MB Flash、三枚实体按键）**，支持 **Cloudflare 云端手机直接控场（彻底告别电脑）** 与 **纯局域网电脑离线主持** 两种模式，同一份投票器固件双模通用。

- 默认支持 10 台投票器，设备上限可按需设至 **1～200 台**；
- 每题 **2～6 个单选项**，支持 **普通单选 / 表决（赞成·反对·弃权） / 五分评分 / 答题测验** 四种模式；
- 支持一次批量发起最多 **50 题**、收票期间**临时加题**、**定时倒计时截止**与**首次确认锁票**；
- 内置**本机/云端题库**、**现场独立大屏投屏（支持只读防误触链接）**、**历史归档回看**与 **CSV / 高清 PNG 导出**。

板级驱动沿用 [AI Passport](https://github.com/Eason-Xi/ai-passport)（MIT 许可证），最初需求见 [投票器 PRD 重建版](docs/LAN_Voting_PRD_v0.1_重建版.md)。

---

## 两种部署模式怎么选

| 维度 | 模式一：Cloudflare 云端主持（推荐 · 摆脱电脑） | 模式二：纯局域网电脑主持（零外网依赖） |
| --- | --- | --- |
| **主持终端** | **任意手机 / 平板浏览器**（iOS / Android 免装 App） | macOS / Windows 电脑（原生客户端或网页） |
| **网络要求** | 投票器连上可上网的 2.4 GHz Wi-Fi 或手机热点即可，**无惧酒店/企业 Wi-Fi 客户端隔离** | 无需外网；电脑与投票器处于同一允许互访的局域网 |
| **手机锁屏影响** | **不影响**（由 Cloudflare Durable Objects 在边缘持续计票与定时截止） | 依赖主持电脑保持运行 |
| **投票器连接方式** | 加密 `wss://`（443 端口），配网页填云端域名 + 6 位入场码 | UDP 48765 自动发现或手动局域网 IP + 6 位入场码 / 5 分钟一键入场 |
| **适用场景** | 随身带手机开投、外出活动、受限 Wi-Fi 环境、无主持电脑 | 保密会议室、无外网地下室/礼堂、纯内网环境 |

---

## 方式一：Cloudflare 云端主持（手机直接控场）

后端位于 [cloudflare/](cloudflare/README.md)，基于 **Cloudflare Workers + Durable Objects（SQLite + WebSocket Hibernation + Alarms）** 构建，免服务器运维，详细文档见 [cloudflare/README.md](cloudflare/README.md)。

### 1. 一键部署到 Cloudflare

```bash
cd cloudflare
npm install
npm run sync:assets
npx wrangler login
npm run deploy
npx wrangler secret put ADMIN_PASSWORD
```

- **无需自定义域名**：默认直接使用 Cloudflare 免费分配的 `https://gongxuan-vote.<你的子域>.workers.dev`。
- **绑定自定义域名（国内网络强烈推荐）**：部分国内网络环境下 `*.workers.dev` 可能直连不稳定。如果你在 Cloudflare 托管了自己的域名，可将 [cloudflare/wrangler.jsonc](cloudflare/wrangler.jsonc) 复制为本机忽略的 `cloudflare/wrangler.local.jsonc`，取消 `routes` 注释并填入你的子域名（如 `vote.example.com`），再执行：
  ```bash
  npm run deploy:custom
  ```
  Cloudflare 会自动签发免费 HTTPS 证书，投票器内置根证书包直接信任，开箱可用。

### 2. 手机控场与投票器接入

1. **手机登录主持台**：用手机浏览器打开部署好的 HTTPS 地址，输入刚才设置的 `ADMIN_PASSWORD` 登录（会话默认保持 30 天，移动端底部提供「出题 / 计票 / 设备 / 历史」毛玻璃快捷导航）。
2. **获取接入信息**：记下页面顶部的 **6 位入场码**，并在「参与设备」卡片查看/复制云端地址（`wss://<你的域名>/ws`）。
3. **投票器扫码配网**：
   - 手机扫投票器屏幕上的二维码加入设备热点，自动弹出配网页（未弹出时扫第二个二维码或访问 `http://192.168.4.1/`）。
   - 选择现场 2.4 GHz Wi-Fi 并输入 Wi-Fi 密码。
   - 点开「**云端主持台或手动指定地址**」，填入你的域名（例如 `vote.example.com`，配网页会自动补全为 `wss://vote.example.com/ws`）。
   - 填入 6 位入场码，点击「**连接并入场**」。验证成功后投票器自动保存配置并重启连入云端（下次换场地 Wi-Fi 时，配网页会自动回填已保存的云端地址）。
4. **独立大屏投屏**：在手机主持台「参与设备」点击「**复制大屏只读链接**」，发给现场投影电脑或平板的浏览器即可免登录打开大屏（大屏端隐藏控场按钮，防止误触）。

---

## 方式二：纯局域网电脑主持（无需互联网）

适合完全断网的场地。可直接从 [GitHub Releases](https://github.com/Eason-Xi/ai-passport-lan-voting/releases/latest) 下载打包好的桌面客户端，或从源码启动。

### 双击桌面客户端

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Apple 芯片 Mac | `gongxuan-desktop-macos-arm64.zip` | 解压双击「共选主持台.app」。首次启动如遇系统提示，在「系统设置 → 隐私与安全性」允许即可。数据保存在 `~/Library/Application Support/GongxuanVoting/votes.sqlite3`。 |
| Windows x64 | `gongxuan-desktop-windows-x64.exe` | 双击启动（基于系统 Edge WebView2，无黑框控制台）。数据保存在 `%APPDATA%\GongxuanVoting\votes.sqlite3`。 |

### 从源码运行

需要 Python 3.12+，macOS 可双击 [host/start.command](host/start.command)，Windows 可双击 [host/start.bat](host/start.bat)，或在项目根目录执行：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r host/requirements-lock.txt
.venv/bin/python host/server.py
```

打开浏览器访问 `http://127.0.0.1:8765`。局域网模式下，投票器配网时**留空服务器地址**即可通过 UDP 48765 自动发现同网段主持电脑；更换会场时也可长按投票器确定键，使用「一键入场（5 分钟免输码窗口）」或三键直接输入新入场码。

---

## 一场活动的完整操作流程

1. **会前备题（题库）**：点击「题库」提前录入常用题目，支持随时选用与版本化编辑；当前草稿也可一键「存入题库」。
2. **调整上限与设备入场**：在「参与设备」设置设备上限（1～200 台），设备上线后可点击铅笔图标备注席位名（如「1号评委」）。建议开场前发一道试投票。
3. **发题与四种投票模式**：每题可自由选择以下模式，一场最多批量发起 50 题，也可在收票期间随时「追加并推送」新题：
   - **普通单选**：自定义 2～6 项，统计各选项票数与占比；
   - **赞成 / 反对 / 弃权**：自动填充选项，按 `赞成 / (赞成 + 反对) > 50%` 判定通过（弃权单独计入总票数）；
   - **五分评分**：自动填充 1～5 分，实时汇总平均分与各分档票数；
   - **答题测验**：设定正确答案，汇总答对人数与正确率。
4. **定时收票与截止**：支持手动截止、预设倒计时（30 秒 / 1 分钟 / 5 分钟）、自定义分钟秒数或指定北京时间，收票中也可动态调整或改回手动截止。倒计时会同步显示在投票器屏幕左上角。
5. **大屏投屏与公布**：按 `F` 或打开独立大屏页（云端支持只读分享链接）。收票期间可先隐藏实时票数防干扰，截止或点击「公布结果」后，所有投票器立即同步显示最终票数与百分比（多题时按确定键翻下一题、长按上下键前后翻题，主持人也可一键指定全场投票器统一展示某题）。
6. **数据留存与导出**：每场结束自动归档至「投票历史」，支持回看、复用题目再次发起、导出带 UTF-8 BOM 的 **CSV 表格** 与高清 **PNG 结果图**。

---

## 硬件固件构建与刷写（ESP32-C3）

本分支固件已升级支持 `wss://` TLS 加密连接（内置精简常用根证书包 `CMN`，涵盖 Google Trust Services、Let's Encrypt ISRG 与 DigiCert，配合 mbedTLS 动态缓冲适配无 PSRAM 的 ESP32-C3），同时完全兼容局域网 `ws://` 模式。

### 刷写到 AI Passport

在已激活 **ESP-IDF 5.5.3** 的环境中，将 `PORT` 替换为实际串口（例如 macOS `/dev/cu.usbmodem101` 或 Windows `COM5`）：

```bash
# 首次刷写或全量刷新（写入 0x0，可能重置原有 NVS 配网）
python -m esptool --chip esp32c3 -p PORT -b 460800 write_flash 0x0 build/FoloToy-AI-Passport-full.bin

# 仅更新应用分区（写入 0x10000，保留原 Wi-Fi 与服务器配置；须确认设备已使用本项目 8 MB 分区表）
python -m esptool --chip esp32c3 -p PORT -b 460800 write_flash 0x10000 build/firmware/<SHA256>/FoloToy-AI-Passport.bin
```

### 校验与自动化测试

```bash
# 1. Cloudflare 后端类型检查、workerd 集成测试与干跑构建
cd cloudflare
npm run typecheck
npm test
npm run deploy:dry-run

# 2. 全量主仓库验证（字库校验、Python 服务端、C 协议/模型 ASan+UBSan 测试、ESP-IDF 5.5.3 固件编译与镜像校验）
./tools/validate.sh

# 3. 桌面客户端单测与 LVGL 界面预览截图
.venv/bin/python tests/test_desktop_host.py
python3 tools/render_vote_preview.py
```

---

## 常见问题

| 现象 | 排查与解决 |
| --- | --- |
| 手机扫投票器二维码没弹出配网页 | 确认手机已连上 `Vote-xxxxxx` 热点，扫设备按上下键切换出的第二个二维码，或在浏览器直接访问 `http://192.168.4.1/`（系统提示热点无互联网时选择保持连接）。 |
| 配网提示「未找到主持台」 | 若使用 Cloudflare 云端模式，请确认已点开「云端主持台或手动指定地址」并填入你的域名（留空只会搜索局域网电脑）。 |
| 填了 `*.workers.dev` 但国内 Wi-Fi 连不上 | 部分国内网络对 `*.workers.dev` 存在访问限制，建议改用你自己的 Cloudflare 自定义域名（参考上方 `wrangler.local.jsonc` 配置）。 |
| 局域网模式下投票器找不到电脑 | 确认接入 2.4 GHz Wi-Fi 且路由器未开启客户端/AP 隔离；UDP 48765 用于自动发现，TCP 8765 用于投票连接。也可以直接切换 Cloudflare 云端模式绕过局域网隔离。 |
| 提示「本场设备已满」 | 在主持台「参与设备」调高设备上限（最高 200 台），或移除闲置的离线设备（移除登记不会删除历史选票）。 |
| 忘记云端管理员密码 | 在 `cloudflare/` 目录重新执行 `npx wrangler secret put ADMIN_PASSWORD` 覆盖即可，不影响已有投票数据。 |

---

## 中文界面与字库

题目上限 60 字，选项上限 24 字。设备与主持台共用 **6,994 个字符**（GB2312 的 6,763 个简体汉字 + ASCII + 常用标点），超出范围的字符会在发题前实时标出拦截。字体资源与许可位于 [assets/fonts/](assets/fonts/)，使用 18 px 4 bpp 思源黑体 SC 子集，校验命令：`python3 tools/gen_vote_font.py check`。

## 许可证

本项目基于原仓库许可发布，详见 [LICENSE](LICENSE)。
