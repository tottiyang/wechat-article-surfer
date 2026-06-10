# wechat-mp-client | 公众号文章抓取客户端

基于 wechat-article-exporter 源码分析后的轻量重写版。

## 与原版的区别

| 维度 | 原版 wechat-article-exporter | 本版 |
|------|------------------------------|------|
| 技术栈 | Nuxt 3 + Vue 3 + TailwindCSS + 50+ 依赖 | 纯 Node.js + turndown + cheerio |
| 安装 | ~500MB node_modules | ~50MB (17 packages) |
| 启动 | `nuxt dev` 全栈 | 按需执行 CLI 命令 |
| 定位 | 完整 Web 应用 | 轻量级 API 客户端 |

## 安装

```bash
cd {managed_skill_dir}/wechat-article-surfer
npm install
```

## 使用流程

### 第一步：登录

```bash
node src/cli.js login
```
浏览器打开 http://localhost:3000 → 扫码登录 → cookies 保存到 `.data/wechat-cookies.json`

### 第二步：搜索公众号

```bash
node src/cli.js search 投资明见
```

### 第三步：获取文章列表

```bash
node src/cli.js articles <fakeid>
```

### 第四步：批量导出（Markdown）

```bash
node src/cli.js dump <fakeid> 10
```

## 架构

```
用户 → src/cli.js (CLI) → src/proxy.js → mp.weixin.qq.com
                                    ↑
                              src/cookie-store.js (文件存储)
                                .data/wechat-cookies.json
```

登录流程：
```
用户扫码 → login-server → mp.weixin.qq.com/cgi-bin/scanloginqrcode
       → 获取 session cookie → 存储到 .data/wechat-cookies.json
       → cookies 有效期 4 天
```

## 文件结构

```
├── package.json        # 依赖声明 (turndown + cheerio)
├── config.json         # 配置文件（飞书、IMA、微信等）
├── config.example.json # 配置模板
├── src/
│   ├── login-server.js # 登录服务器（一次性扫码）
│   ├── cli.js          # CLI 主入口
│   ├── proxy.js        # 微信 MP 后端 API 代理核心
│   └── cookie-store.js # 本地文件 Cookie 存储
├── scripts/            # 业务脚本
│   ├── daily-workflow.js   # 每日工作流
│   ├── ima-upload.cjs      # IMA上传助手
│   └── ...
├── bin/
│   └── start-login.sh  # 一键启动登录
└── .data/
    ├── wechat-cookies.json  # Cookie 持久化文件
    └── articles/            # 下载的文章（Markdown）
```
