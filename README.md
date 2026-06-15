# wechat-mp-client | 公众号文章抓取客户端

基于 wechat-article-exporter 源码分析后的轻量重写版，实现微信公众号文章定时抓取、AI 分析和 IMA 知识库存储。

**日常自动化走 `daily-workflow.js`**，底层 CLI 工具 `cli.js` 供调试和手动操作使用。

---

## 快速开始（自动化）

```bash
# 检查 session 状态
node scripts/check_session.js

# 运行完整工作流（自动检查所有未完成的日期）
node scripts/daily-workflow.js --backlog

# 指定日期运行
node scripts/daily-workflow.js --date 2026-06-15
```

详细说明见 [SKILL.md](./SKILL.md)。

---

## 手动 CLI 使用（调试用）

### 安装

```bash
cd {managed_skill_dir}/wechat-article-surfer
npm install
```

### 登录

```bash
node src/cli.js login
```
浏览器打开 http://localhost:3000 → 扫码登录 → cookies 保存到 `.data/wechat-cookies.json`（有效期约 4 天）

### 搜索公众号

```bash
node src/cli.js search 投资明见
```

### 获取文章列表

```bash
node src/cli.js articles <fakeid>
```

### 批量导出（Markdown）

```bash
node src/cli.js dump <fakeid> 10
```

### 单篇下载

```bash
node src/cli.js download https://mp.weixin.qq.com/s/xxx
```

## 与原版的区别

| 维度 | 原版 wechat-article-exporter | 本版 |
|------|------------------------------|------|
| 技术栈 | Nuxt 3 + Vue 3 + TailwindCSS + 50+ 依赖 | 纯 Node.js + turndown + cheerio |
| 安装 | ~500MB node_modules | ~50MB (17 packages) |
| 启动 | `nuxt dev` 全栈 | 按需执行 CLI / 自动化脚本 |
| 定位 | 完整 Web 应用 | 轻量级 API 客户端 |
| 日常使用 | 手动逐号操作 | `daily-workflow.js` 全自动 |

## 架构

```
自动化路径（日常）：
  cron (02:00) → scripts/daily-workflow.js → src/proxy.js → mp.weixin.qq.com
                                                 ↑
                                           src/cookie-store.js (文件存储)
                                             .data/wechat-cookies.json

调试路径（手动）：
  用户 → src/cli.js (CLI) → src/proxy.js → mp.weixin.qq.com
```

## 文件结构

```
├── package.json             # 依赖声明 (turndown + cheerio)
├── config.json              # 配置文件（飞书、IMA、微信、Kimi API Key）
├── config.example.json      # 配置模板
├── SKILL.md                 # 自动化工作流完整文档
├── src/                     # 核心源码
│   ├── login-server.js      # 登录服务器（一次性扫码）
│   ├── cli.js               # CLI 主入口（手动调试用）
│   ├── proxy.js             # 微信 MP 后端 API 代理核心
│   └── cookie-store.js      # 本地文件 Cookie 存储
├── scripts/                 # 业务脚本
│   ├── daily-workflow.js    # 每日工作流（唯一入口）
│   ├── ima-upload.cjs       # IMA上传助手
│   ├── check_session.js     # 微信 session 检查
│   ├── generate-summary-prompt.js  # AI分析提示词生成器
│   ├── fix-fakeids.js       # FakeId 修复工具
│   └── search_batch.js      # 批量搜索测试
├── bin/
│   └── start-login.sh       # 一键启动登录
└── .data/                   # 运行时数据（不提交 git）
    ├── wechat-cookies.json  # Cookie 持久化
    └── articles/            # 下载的文章（Markdown）
```
