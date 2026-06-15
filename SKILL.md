---
name: wechat-article-surfer
description: |
  微信公众号文章自动化抓取与分析 Skill。
  定时拉取指定公众号的文章，按统一格式保存为 Markdown，AI 提取观点和标的后，
  存入 IMA 知识库指定文件夹。
keywords:
  - "公众号文章"
  - "微信公众号"
  - "wechat article"
  - "投资明见"
  - "文章抓取"
  - "wechat-article-exporter"
triggers:
  - "抓取公众号文章"
  - "拉取公众号"
  - "公众号自动化"
metadata:
  openclaw:
    emoji: "📰"
---

# wechat-article-surfer — 公众号文章自动抓取分析 Skill

基于 wechat-article-exporter 源码提取核心逻辑后的轻量本地实现（wechat-mp-client），实现微信公众号文章定时抓取、AI 分析和 IMA 知识库存储。

---

## 工作流程总览

```mermaid
flowchart TD
    A[Cron: 每日02:00触发] --> B[读取公众号配置]
    B --> C[调用WX-Exporter API搜索公众号]
    C --> D[获取文章列表]
    D --> E[按日期过滤: 前一日文章]
    E --> F[逐篇下载为Markdown]
    F --> G[按命名规则保存到本地]
    G --> H[AI聚合分析: 观点+标的+原因]
    H --> I[生成分析报告]
    I --> J[存入IMA知识库指定文件夹]
    J --> K[飞书推送结果摘要]
```

---

## 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│              wechat-article-surfer                           │
│  {managed_skill_dir}/wechat-article-surfer/                   │
│                                                              │
│  src/login-server.js ── 一次性扫码登录服务器                  │
│  src/cli.js          ── CLI 命令行工具                      │
│  src/proxy.js        ── 微信 MP 后端 API 代理核心            │
│  src/cookie-store.js ── 本地文件 Cookie 存储                │
│  .data/              ── Cookie 持久化 + 文章存储            │
└──────────────────────────────────────────────────────────────┘

登录流程：用户扫码 → WeChat session cookie 存储本地 → cookies 有效期 4 天

## 配置要求

### 前置依赖

| 依赖 | 说明 |
|------|------|
| **Node.js** | 22+，依赖仅 turndown + cheerio（约 17 个包）|
| **IMA OpenAPI 凭证** | IMA 笔记的 client_id + api_key，存于 `~/.config/ima/` |
| **飞书 Token** | 用户 access_token，用于读取公众号列表和写入 Wiki |

### 首次登录

```bash
cd {managed_skill_dir}/wechat-article-surfer
node src/cli.js login
# 或：npm run login
# 浏览器打开 http://localhost:3000
# 扫码登录 → 自动保存 cookies 到 .data/wechat-cookies.json
```

> ⚠️ **登录会话有效期约 4 天**，到期后需重新登录。建议每 3 天重新扫码一次。

### 配置文件

所有配置写在 `config.json` 中（不提交 git，已加入 .gitignore）：

```json
{
  "feishu": {
    "sheet_token": "飞书表格token",
    "sheet_id": "工作表ID",
    "token_file": "~/.qclaw/skills-config/feishu/tokens/user_token.json",
    "space_id": "Wiki空间ID",
    "default_parent_node": "Wiki父节点token"
  },
  "wechat": {
    "cookies_path": ".data/wechat-cookies.json"
  },
  "ima": {
    "credential_dir": "~/.config/ima",
    "knowledge_base_id": "知识库ID"
  },
  "article_storage": ".data/articles"
}
```

---

## 核心功能

### 1. 公众号搜索与文章拉取

通过 CLI 操作：

**Step 1: 检查登录状态**
```bash
node src/cli.js status
```

**Step 2: 搜索公众号 → 获取 fakeid**
```bash
node src/cli.js search 投资明见
```
输出 fakeid。

**Step 3: 获取文章列表**
```bash
node src/cli.js articles <fakeid>
```
返回文章列表，含 `title`、`create_time`、`link` 等字段。

**Step 4: 批量下载文章**
```bash
node src/cli.js dump <fakeid> 20
```
自动下载为 Markdown 文件，保存到 `.data/articles/` 目录。

**或单篇下载：**
```bash
node src/cli.js download https://mp.weixin.qq.com/s/xxx
```

### 2. 文件命名规则

```
{公众号名}-{YYYY-MM-DD}-{标题}.md
```

规则：
- **公众号名**：公众号名称（去除非法字符）
- **YYYY-MM-DD**：文章发布时间
- **标题**：原文章标题（去除非法字符，限制 100 字符）
- 非法字符（`\ / : * ? " < > |`）替换为空格后合并
- 存放目录：`.data/articles/`（集中存储，不按公众号分目录）

### 3. AI 分析

每批次文章需产出两份内容：

**A) 每篇文章的 Markdown 文件** — 原始下载内容

**B) 聚合分析报告** — 提取以下信息：

```markdown
# 公众号「投资明见」日报 YYYY-MM-DD

## 📊 概览
- 日期：YYYY-MM-DD
- 文章数：N 篇
- 抓取时间：YYYY-MM-DD 02:00

---

## 1. 《文章标题一》
### 📌 核心观点
[AI 提取的主要观点]

### 🎯 标的与方向
| 标的 | 方向 | 原因 |
|------|------|------|
| 标的名称 | 看好/看空 | AI 分析的原因 |

### 💡 关键论据
- 论据1
- 论据2

---

## 2. 《文章标题二》
...
```

**分析维度：**
- **核心观点**：每篇文章的核心论点、判断
- **标的识别**：提及的股票、基金、行业、板块等投资标的
- **方向判断**：看多/看空/中性，以及置信度
- **关键论据**：支撑该判断的数据、逻辑、引用
- **潜在风险**：文章中提及的风险因素

### 4. IMA 知识库存储

通过 IMA OpenAPI 将文件存入指定文件夹：

**方式一：上传 Markdown 文件到知识库**

利用 IMA knowledge-base 模块的上传文件能力：

```bash
# 1. 创建媒体凭证
curl -s -X POST "https://ima.qq.com/openapi/wiki/v1/create_media" \
  -H "ima-openapi-clientid: $IMA_CLIENT_ID" \
  -H "ima-openapi-apikey: $IMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "file_name": "YYYY-MM-DD-作者-标题.md",
    "file_size": <文件大小>,
    "content_type": "text/markdown",
    "knowledge_base_id": "<kb_id>",
    "file_ext": "md"
  }'

# 2. COS 上传
# 3. add_knowledge 关联到知识库
```

**方式二：创建 IMA 笔记**

利用 notes 模块：

```bash
curl -s -X POST "https://ima.qq.com/openapi/note/v1/import_doc" \
  -H "ima-openapi-clientid: $IMA_CLIENT_ID" \
  -H "ima-openapi-apikey: $IMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content_format": 1,
    "content": "# 标题\n\n正文内容",
    "folder_id": "<文件夹ID>"
  }'
```

**方式三：将笔记关联到知识库**

```bash
curl -s -X POST "https://ima.qq.com/openapi/wiki/v1/add_knowledge" \
  -H "ima-openapi-clientid: $IMA_CLIENT_ID" \
  -H "ima-openapi-apikey: $IMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "media_type": 11,
    "note_info": { "content_id": "<doc_id>" },
    "title": "YYYY-MM-DD-作者-标题",
    "knowledge_base_id": "<kb_id>"
  }'
```

### 5. 推送与通知

分析完成后：
1. 汇总抓取结果（文章数、分析摘要）
2. 通过飞书/当前渠道推送给用户
3. 附上 IMA 知识库链接（如可获取）

---

## 定时任务配置

### 每日 Cron（02:00 AM）

```bash
# 方式 A - 内置 cron 工具
cron(schedule: {"kind":"cron","cron":"0 2 * * *"}, prompt: "...")
```

### 一次性测试（立即执行）

```bash
openclaw cron add --message "立即执行公众号文章抓取分析" --no-cron
```

### 手动触发

用户发送"抓取公众号文章"时，按 SKILL.md 流程执行一次。

---

## 执行流程（Agent 执行路径）

当 cron 触发或用户手动请求时，按以下步骤执行：

### Step 0: 检查登录状态
```bash
cd {managed_skill_dir}/wechat-article-surfer
node src/cli.js status
```
- 有有效会话 → 继续
- 无有效会话 → 通知用户重新扫码登录 (`node src/cli.js login`)

### Step 1: 搜索公众号
```bash
node src/cli.js search "公众号名称"
```
获取目标公众号的 `fakeid`。

### Step 2: 获取文章列表
分页拉取（每次 10 条），直到覆盖前一日所有文章。

### Step 3: 批量下载文章
```bash
node src/cli.js dump <fakeid> <article_count>
```
自动下载为 Markdown 文件，保存到 `.data/articles/`。

### Step 4: AI 分析
读取 `.data/articles/` 中当日的文件，提取观点/标的/原因，生成聚合分析报告。

### Step 5: 存入 IMA
- 将每篇文章的 Markdown 上传到 IMA 知识库
- 将聚合分析报告也存入 IMA

### Step 6: 推送结果
发送结果摘要给用户。

---

## 错误处理

| 场景 | 处理 |
|------|------|
| 登录会话过期 | 通知用户重新扫码登录 (`node src/cli.js login`) |
| 公众号搜索不到 | 检查名称是否准确 |
| 当日无文章 | 记录"无新文章"，跳过 |
| IMA 上传失败 | 本地文件保留，下次重试 |
| 某篇文章下载失败 | 跳过该篇，记录错误，继续处理其他篇 |

---

## 数据目录结构

```
{skill_dir}/
├── SKILL.md
├── README.md
├── config.json              # 真实配置（不提交 git）
├── config.example.json      # 配置模板
├── package.json             # 依赖
├── .gitignore
├── src/                     # 核心源码
│   ├── proxy.js             # 微信API代理
│   ├── login-server.js      # 扫码登录服务器
│   ├── cookie-store.js      # Cookie持久化
│   └── cli.js               # 命令行工具
├── scripts/                 # 业务脚本
│   ├── daily-workflow.js    # 每日工作流（全自动）
│   ├── ima-upload.cjs       # IMA上传助手
│   ├── fix-fakeids.js       # FakeId修复
│   ├── search_batch.js      # 批量搜索
│   └── fetch-daily-articles.js  # 旧版拉取脚本
├── bin/                     # 可执行脚本
│   └── start-login.sh       # 一键启动登录
└── .data/                   # 运行时数据（不提交 git）
    ├── wechat-cookies.json  # 微信登录cookies
    └── articles/            # 已下载的Markdown文章
```

---

## 飞书表格结构

公众号订阅列表存储在飞书表格中，结构如下：

| 列 | 字段 | 说明 |
|----|------|------|
| A | 公众号名称 | 显示名称 |
| B | 微信号 | 原始微信号 |
| C | FakeId | 微信内部ID（用于API调用）|
| D | 状态 | 启用/手动/禁用 |
| E | 最后拉取结果 | 时间\|结果\|详情（见下方枚举）|

### 拉取结果枚举（FETCH_RESULT）

所有可能的结果类型，固化在代码中：

| 结果 | 说明 | 是否需要补跑 |
|------|------|-------------|
| 成功 | 成功拉取文章 | 否 |
| 无文章 | 该日期无文章（真没有） | 否 |
| 频控限制 | ret=200013，微信频率限制 | **是** |
| 参数无效 | ret=200002，fakeid错误等 | 否（需人工修复） |
| API错误 | 其他API错误 | **是** |
| 下载失败 | 文章下载失败 | **是** |
| 已禁用 | 账号状态为禁用 | 否 |
| 手动模式 | 账号状态为手动 | 否 |
| 待处理 | 从未拉取过 | **是** |

### 补跑逻辑

```javascript
// 需要补跑的结果类型
const NEED_RETRY = ['频控限制', 'API错误', '下载失败'];

// 判断是否需要补跑
function needRetry(account) {
  if (account.status !== '启用') return false;
  if (!account.lastResult) return true;
  const result = account.lastResult.split('|')[1];
  return NEED_RETRY.includes(result);
}
```

补跑策略：
- **只补** 频控限制/API错误/下载失败/待处理
- **不补** 无文章/已禁用/手动模式/参数无效
- 参数无效需人工修复 fakeid

### 结果格式

E列格式：`YYYY-MM-DD HH:MM:SS|结果|详情`

示例：
- `2026-06-10 15:30:00|成功|3篇`
- `2026-06-10 15:31:00|无文章|2026-06-09无文章`
- `2026-06-10 15:32:00|频控限制|ret=200013`
- `2026-06-10 15:33:00|参数无效|ret=200002`

---

## 📊 拉取状态（2026-06-15 更新）

电子表格 E 列记录了每个公众号的拉取时间、结果。当前 68 个启用账号：

### 最近拉取覆盖情况

| 日期 | 已拉取账号数 | 文章数 | 备注 |
|------|-------------|--------|------|
| 2026-06-09 周二 | 68 | ~50篇 | ✅ 已分析+发布 |
| 2026-06-10 周三 | 68 | ~50篇 | ✅ 已分析+发布 |
| 2026-06-11 周四 | 68 | ~50篇 | ✅ 已分析+发布 |
| 2026-06-12 周五 | 68 | ~50篇 | 已拉取，未分析日志 |
| 2026-06-14 周日 | ⚠️ 10/68 | 4篇 | 被 bug 截断（见下） |
| 2026-06-15 周一 | — | — | 待处理 |

**说明**：6/14 周日只有前 10 个公众号被拉取（3个有文章=4篇），剩余 58 个因代码 bug 被跳过。6/15 周一尚未开始拉取。

## 配置说明

### config.json 关键字段

```json
{
  "feishu": { ... },          // 飞书表格/知识库配置
  "wechat": { ... },          // 微信 cookies 路径
  "ima": { ... },             // IMA 知识库配置
  "article_storage": ".data/articles",
  "kimi": {
    "api_key": "sk-kimi-..."  // Kimi API Key（解决 cron 子进程不加载 ~/.zshrc 的问题）
  }
}
```

**注意**：KIMI_API_KEY 除了在 `~/.zshrc` 中，也写入了 `config.json` 的 `kimi.api_key` 字段。
`callLlm()` 会优先从 `process.env.KIMI_API_KEY` 读取，fallback 到 `config.json`。

## 🐛 已知 Bug 与踩坑记录

### Bug 1: backlog 模式 Phase 1 被 existing.length > 0 跳过 (2026-06-15)

**修复 commit**: (每日工作流同目录)

**症状**：cron 第1批下载了4篇文章后，第2批开始前碰了 10 分钟冷却，之后进程恢复时发现已有文章 → 跳过了 Phase 1 → 剩余 58 个账号从未拉取。

**根因**：`daily-workflow.js` 第836行逻辑：
```javascript
if (existing.length > 0) {
    // ❌ backlog 模式下直接跳过了剩余账号的拉取
    downloaded = existing;
}
```

同时第 845-869 行的 backlog 恢复模式调用了 `needRetry()`，该函数检查 E 列的上次拉取结果：
```javascript
function needRetry(account) {
  if (!account.lastResult || account.lastResult === '待处理') return true;
  const result = account.lastResult.split('|')[1];
  return ['频控限制','API错误','下载失败'].includes(result);
  // ❌ "成功"和"无文章"都返回 false
  // 但 "成功" 是针对旧日期的，不是新日期
}
```

**修复**（2026-06-15）：在 backlog 模式下强制 `isNewDate = true`，全量拉取
```javascript
const isBacklogMode = process.argv.includes('--backlog');
const isNewDate = existing.length === 0 || isBacklogMode;
```

### Bug 2: KIMI_API_KEY 在 cron 子进程中丢失 (2026-06-15)

**症状**：AI 分析失败报 `KIMI_API_KEY not set`

**根因**：API Key 定义在 `~/.zshrc` 中，cron 启动的子进程不加载 shell profile

**临时解决**：在 exec 前 source ~/.zshrc

**彻底解决**：在 `daily-workflow.js` 中将 KIMI_API_KEY 写入 config.json 或 .env 文件，不走环境变量。

### Bug 3: 文章命名双下划线 (2026-06-15)

**症状**：`fetch-daily-articles.js` 使用 `{名}_{日期}_{标题}.md`（下划线），`daily-workflow.js` 使用 `{名}-{日期}-{标题}.md`（连字符）。两者文件名不一致，互不识别。

**影响**：
- `getExistingArticles()` 用文件包含日期来查找，两种命名都能找到
- 但 duplicate 去重可能失效


