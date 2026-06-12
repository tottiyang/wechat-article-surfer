#!/usr/bin/env node
/**
 * daily-workflow.js — 微信公众号文章每日工作流
 *
 * 每日自动：拉取文章 → 转Markdown → 上传IMA → AI观点提炼 → 飞书Wiki归档
 *
 * 命名规范（硬编码）：
 *   IMA文件名:  {公众号}-{YYYY-MM-DD}-{标题}.md
 *   本地文件名:  {公众号}-{YYYY-MM-DD}-{标题}.md
 *   飞书Wiki:   GROcqEQ.../YYYY/MM/YYYY-MM-DD.md
 *
 * 用法: node scripts/daily-workflow.js [--date 2026-06-09]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ═══════════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════════

const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
const ARTICLE_DIR = join(ROOT, '.data', 'articles');
const ANALYSIS_DIR = join(ROOT, '.data', 'analysis');
const CACHE_DIR = join(ROOT, '.data', 'workflow-cache');
const IMA_UPLOADER = join(__dirname, 'ima-upload.cjs');

// ═══════════════════════════════════════════════════════════════════
// 多日期支持
// ═══════════════════════════════════════════════════════════════════

// --date=YYYY-MM-DD  : 单个日期（默认昨天）
// --from-date=YYYY-MM-DD : 起止范围，到 --to-date 或 --date
// --backlog            : 自动检测未处理的 backlog 日期
// 默认：昨天（向后兼容）

function parseDateArgs() {
  const singleDate = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];
  const fromDate = process.argv.find(a => a.startsWith('--from-date='))?.split('=')[1];
  const toDate = process.argv.find(a => a.startsWith('--to-date='))?.split('=')[1] || singleDate;
  const isBacklog = process.argv.includes('--backlog');
  return { singleDate, fromDate, toDate, isBacklog };
}

/** 返回 YYYY-MM-DD 字符串数组 */
function generateDateRange(from, to) {
  const dates = [];
  const d = new Date(from);
  const end = new Date(to);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/**
 * 检测未处理的 backlog 日期
 * 规则：扫描 articles/ 目录，找出已下载文章但尚未完成 AI 分析的日期
 *       同时包含昨天（cron 正常目标日期）如果它还没处理
 */
function detectBacklogDates() {
  if (!existsSync(ARTICLE_DIR)) return [];
  const files = readdirSync(ARTICLE_DIR).filter(f => f.endsWith('.md'));
  
  // 提取所有日期
  const dateSet = new Set();
  for (const f of files) {
    const m = f.match(/-((2026)-\d{2}-\d{2})-/);
    if (m) dateSet.add(m[1]);
  }
  
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (!dateSet.has(yesterday)) dateSet.add(yesterday);
  
  // 过滤出需要处理的日期：有文章但无分析文件
  const backlog = [];
  for (const date of [...dateSet].sort()) {
    const analysisFile = join(ANALYSIS_DIR, `${date}-观点汇总.md`);
    if (existsSync(analysisFile) && readFileSync(analysisFile, 'utf-8').trim().length > 100) {
      console.log(`  ⏭️  ${date}: 分析已存在，跳过`);
      continue;
    }
    // 检查是否有文章文件
    const articleCount = files.filter(f => f.includes(date)).length;
    if (articleCount > 0 || date === yesterday) {
      backlog.push({ date, articleCount });
    }
  }
  
  return backlog.sort();
}

// 确定本次运行的日期列表
const dateArgs = parseDateArgs();
const DATES_TO_PROCESS = (() => {
  if (dateArgs.isBacklog) {
    const bl = detectBacklogDates();
    const dates = bl.map(d => typeof d === 'object' ? d.date : d);
    console.log(`📋  Backlog 模式: ${dates.length} 个日期待处理: ${dates.join(', ')}`);
    return dates;
  }
  if (dateArgs.fromDate) {
    const to = dateArgs.toDate || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return generateDateRange(dateArgs.fromDate, to);
  }
  // 单日期模式
  const d = dateArgs.singleDate || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return [d];
})();

// 获取第一天的年月用于目录创建
const FIRST_DATE = DATES_TO_PROCESS[0];
if (!FIRST_DATE) {
  console.log('没有需要处理的日期');
  process.exit(0);
}

// 断点续跑：模块级日期变量，供 phase1Partial / publishToWiki 使用
let TARGET_DATE = FIRST_DATE;
let YEAR = FIRST_DATE?.split('-')[0] || '';
let MONTH = FIRST_DATE?.split('-')[1] || '';

// ═══════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════

function sanitize(s) { return s.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100); }
const imaName = (biz, title) => `${sanitize(biz)}-${TARGET_DATE}-${sanitize(title)}.md`;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-'); }

function getFeishuToken() {
  const f = CONFIG.feishu.token_file.replace(/^~/, process.env.HOME || '');
  const t = JSON.parse(readFileSync(f, 'utf-8'));
  return t.user_access_token || t.access_token;
}

// ═══════════════════════════════════════════════════════════════════
// 飞书 Sheet 操作
// ═══════════════════════════════════════════════════════════════════

async function feishuSheet(path, method = 'GET', body = null) {
  const token = getFeishuToken();
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.sheet_token}${path}`;
  const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

function parseSheetRows(data) {
  return (data.data?.valueRange?.values || []);
}

function parseSheetRowsWithHeader(data) {
  return parseSheetRows(data).slice(1);
}

async function readSubscriptions() {
  const sid = CONFIG.feishu.sheet_id;
  const data = await feishuSheet(`/values/${sid}!A:H`);
  const rows = parseSheetRowsWithHeader(data);
  return rows.filter(r => (r[3] || '').trim() === '启用').map((r, i) => ({
    name: r[0] || '', wechat_id: r[1] || '', fakeid: r[2] || '',
    status: r[3] || '', classification: r[7] || '',
    rowIndex: i + 2, // 1-indexed + header
  }));
}

async function getOriginalNames() {
  const sid = CONFIG.feishu.sheet_id;
  const data = await feishuSheet(`/values/${sid}!A2:A89`);
  return parseSheetRows(data).map(r => r[0]).filter(Boolean);
}

export // ═══════════════════════════════════════════════════════════════════
// 拉取结果枚举（穷举所有可能情况）
// ═══════════════════════════════════════════════════════════════════

const FETCH_RESULT = {
  // 成功
  SUCCESS: '成功',
  // 公众号无文章（真没有）
  NO_ARTICLE: '无文章',
  // 微信频控限制
  FREQ_CONTROL: '频控限制',
  // API参数无效（fakeid错误等）
  INVALID_ARGS: '参数无效',
  // 其他API错误
  API_ERROR: 'API错误',
  // 文章下载失败
  DOWNLOAD_ERROR: '下载失败',
  // 账号禁用/手动
  DISABLED: '已禁用',
  MANUAL: '手动模式',
  // 未处理（初始状态）
  PENDING: '待处理',
};

// 需要补跑的结果类型
const NEED_RETRY = [FETCH_RESULT.FREQ_CONTROL, FETCH_RESULT.API_ERROR, FETCH_RESULT.DOWNLOAD_ERROR];

// ═══════════════════════════════════════════════════════════════════
// 飞书表格操作
// ═══════════════════════════════════════════════════════════════════

async function getFakeids() {
  const sid = CONFIG.feishu.sheet_id;
  // 读取 A:名称, C:FakeId, D:状态, E:最后拉取结果
  const data = await feishuSheet(`/values/${sid}!A2:E89`);
  return parseSheetRows(data).filter(r => r[2]).map((r, i) => ({
    name: r[0] || '',
    fakeid: r[2],
    status: (r[3] || '').trim(), // D列: 状态（启用/手动/禁用）
    lastResult: (r[4] || '').trim(), // E列: 最后拉取结果
    rowIndex: i + 2, // 1-indexed + header
  }));
}

async function updateSheetResult(rowIndex, result, detail = '') {
  const sid = CONFIG.feishu.sheet_id;
  const cell = `E${rowIndex}`; // E列: 最后拉取结果
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-');
  const value = detail ? `${now}|${result}|${detail}` : `${now}|${result}`;
  return feishuSheet(`/values`, 'PUT', {
    valueRange: { range: `${sid}!${cell}:${cell}`, values: [[value]] }
  });
}

// ═══════════════════════════════════════════════════════════════════
// WeChat 操作
// ═══════════════════════════════════════════════════════════════════

async function getRegularArticles(fakeid, size = 50) {
  const { getRegularArticles } = await import(join(ROOT, 'src/proxy.js'));
  return getRegularArticles(fakeid, { size: String(size) });
}

async function downloadArticle(url) {
  const { downloadArticle } = await import(join(ROOT, 'src/proxy.js'));
  return downloadArticle(url);
}

export function htmlToMarkdown(html, title) {
  let body = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  const contentMatch = body.match(/id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<(script|div)/);
  let content = contentMatch ? contentMatch[1] : body;

  // Simple to text
  content = content.replace(/<br\s*\/?>/gi, '\n');
  content = content.replace(/<[^>]+>/g, '');
  content = content.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  content = content.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  return `# ${title}\n\n${content}`;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1: 文章拉取
// ═══════════════════════════════════════════════════════════════════

/**
 * 在 [min, max] 范围内生成随机整数
 */
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * 将数组随机打乱 (Fisher-Yates)
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════════════
// 补跑逻辑
// ═══════════════════════════════════════════════════════════════════

/**
 * 判断账号是否需要补跑
 * @param {Object} account - 账号信息
 * @returns {boolean} - 是否需要补跑
 */
function needRetry(account) {
  // 非启用状态不补跑
  if (account.status !== '启用') return false;
  
  // 从未拉取过，需要补跑
  if (!account.lastResult || account.lastResult === FETCH_RESULT.PENDING) return true;
  
  // 解析最后拉取结果
  const parts = account.lastResult.split('|');
  const result = parts[1] || parts[0];
  
  // 只有特定错误需要补跑
  return NEED_RETRY.includes(result);
}

/**
 * 获取需要补跑的账号列表
 */
export async function getRetryAccounts() {
  const accounts = await getFakeids();
  return accounts.filter(needRetry);
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1: 文章拉取（含频控防护 + 结果记录）
// ═══════════════════════════════════════════════════════════════════

const FREQ = {
  // 每个公众号 API 调用后的等待间隔（秒）- 增加以应对频控
  ACCOUNT_DELAY_MIN: 15,
  ACCOUNT_DELAY_MAX: 45,
  // 每个批次包含的公众号数量 - 减少以降低会话级频控风险
  BATCH_SIZE: 5,
  // 批次之间的等待间隔（秒）- 增加以应对频控
  BATCH_PAUSE_MIN: 120,
  BATCH_PAUSE_MAX: 180,
  // 每日最大 API 调用量（保护，防止意外跑飞）
  DAILY_CAP: 200,
  // 遇到频控(200013)后的重试等待（秒）
  RETRY_AFTER_BLOCK: 300,
  // 遇到通用API错误的重试等待（秒）- 较短，因为可能是瞬态错误
  RETRY_AFTER_ERROR: 15,
  // 最大重试次数
  MAX_RETRIES: 2,
};

export async function phase1Partial(accounts, startIdx = 0, count = 10) {
  if (!existsSync(ARTICLE_DIR)) mkdirSync(ARTICLE_DIR, { recursive: true });

  const results = { downloaded: [], errors: [], skipped: [], noArticle: [] };
  const enabledAccounts = accounts.filter(a => a.status === '启用');
  const batchAccounts = enabledAccounts.slice(startIdx, startIdx + count);
  
  console.log(`\n📦  Partial Batch (${startIdx}-${startIdx + count}/${enabledAccounts.length})`);

  for (let j = 0; j < batchAccounts.length; j++) {
    const { name, fakeid, status, rowIndex } = batchAccounts[j];

    if (status !== '启用') {
      console.log(`  ⏭️  状态=${status}（${name}）`);
      results.skipped.push({ name, reason: status === '手动' ? FETCH_RESULT.MANUAL : FETCH_RESULT.DISABLED });
      await updateSheetResult(rowIndex, status === '手动' ? FETCH_RESULT.MANUAL : FETCH_RESULT.DISABLED);
      continue;
    }
    console.log(`\n[${startIdx + j + 1}/${enabledAccounts.length}] ${name}`);

    try {
      let retries = 0;
      let result;
      let finalResult = FETCH_RESULT.API_ERROR;
      let detail = '';
      
      while (retries <= FREQ.MAX_RETRIES) {
        result = await getRegularArticles(fakeid, 50);

        const actualRet = result.ret ?? result.base_resp?.ret;

        // ret=0 or app_msg_list present → 成功
        if (actualRet === 0 || result.app_msg_list) {
          finalResult = FETCH_RESULT.SUCCESS;
          break;
        }

        // 200002: 参数无效 → 永久跳过，不重试
        if (actualRet === 200002) {
          console.log(`  ⚠️  API参数无效(ret=200002)，跳过`);
          finalResult = FETCH_RESULT.INVALID_ARGS;
          detail = 'ret=200002';
          results.errors.push({ name, error: '参数无效(ret=200002)' });
          break;
        }

        // 其他错误(-1/200013/undefined等) → 重试
        retries++;
        if (retries <= FREQ.MAX_RETRIES) {
          let wait = actualRet === 200013 ? FREQ.RETRY_AFTER_BLOCK * retries : FREQ.RETRY_AFTER_ERROR * retries;
          const retLabel = actualRet === 200013 ? '频控' : 'API错误';
          console.log(`  ⚠️  ${retLabel}(ret=${actualRet})，等待 ${wait}s 后重试(${retries}/${FREQ.MAX_RETRIES})...`);
          await sleep(wait * 1000);
          continue;
        } else {
          console.log(`  ⛔  ${actualRet === 200013 ? '频控' : 'API'}重试耗尽(ret=${actualRet})，跳过`);
          finalResult = actualRet === 200013 ? FETCH_RESULT.FREQ_CONTROL : FETCH_RESULT.API_ERROR;
          detail = `ret=${actualRet}`;
          results.errors.push({ name, error: `${actualRet === 200013 ? '频控限制' : 'API不可用'}(ret=${actualRet})` });
          break;
        }
      }
      
      if (finalResult !== FETCH_RESULT.SUCCESS) {
        await updateSheetResult(rowIndex, finalResult, detail);
        continue;
      }

      const yestArticles = (result.articles || []).filter(a =>
        new Date(a.create_time * 1000).toISOString().slice(0, 10) === TARGET_DATE
      );
      console.log(`  ${TARGET_DATE}: ${yestArticles.length} 篇`);

      if (yestArticles.length === 0) {
        await updateSheetResult(rowIndex, FETCH_RESULT.NO_ARTICLE, `${TARGET_DATE}无文章`);
        results.noArticle.push({ name, date: TARGET_DATE });
        continue;
      }

      for (const a of yestArticles) {
        const title = (a.title || '').trim() || '无标题';
        const fname = imaName(name, title);
        const localPath = join(ARTICLE_DIR, fname);

        try {
          const html = await downloadArticle(a.link);
          const md = htmlToMarkdown(html, title);
          writeFileSync(localPath, md, 'utf-8');
          results.downloaded.push({ filePath: localPath, bizName: name, title, url: a.link, imaName: fname });
          console.log(`  ✅ ${fname}`);
          await sleep(800);
        } catch (e) {
          console.log(`  ❌ 下载失败: ${e.message}`);
          finalResult = FETCH_RESULT.DOWNLOAD_ERROR;
          detail = e.message.slice(0, 50);
          results.errors.push({ name, title, error: e.message });
        }
      }
      
      await updateSheetResult(rowIndex, finalResult, `${yestArticles.length}篇`);
    } catch (e) {
      console.log(`  ❌ 拉取失败: ${e.message}`);
      await updateSheetResult(rowIndex, FETCH_RESULT.API_ERROR, e.message.slice(0, 50));
      results.errors.push({ name, error: e.message });
    }

    // 每个公众号处理完毕后随机等待
    if (j < batchAccounts.length - 1) {
      const delay = randInt(FREQ.ACCOUNT_DELAY_MIN, FREQ.ACCOUNT_DELAY_MAX);
      console.log(`  ⏳ 等待 ${delay}s...（防频控）`);
      await sleep(delay * 1000);
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1b: IMA 上传
// ═══════════════════════════════════════════════════════════════════

async function phase1b(downloaded) {
  let ok = 0, fail = 0;
  for (const f of downloaded) {
    process.stdout.write(`  ↑ ${f.imaName}...`);
    try {
      execSync(`node "${IMA_UPLOADER}" "${f.filePath}" "${f.imaName}" 2>&1`, {
        encoding: 'utf-8', timeout: 120000
      });
      console.log(` ✅`);
      ok++;
    } catch (e) {
      console.log(` ❌ ${e.stderr?.substring(0, 120) || e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

// ═══════════════════════════════════════════════════════════════════
// Phase 2: AI 观点分析 — 提示词（固化配置）
// ═══════════════════════════════════════════════════════════════════

const ANALYSIS_PROMPT_TEMPLATE = `你是一位专业的财经文章深度分析师，擅长从财经公众号文章中提取具体的投资标的、板块产业链、操作策略和关键数据。

## 任务
对以下财经文章进行深度分析和汇总，生成一份结构化的投资观点汇总报告。

## 输出要求（严格按以下6个部分输出，禁止省略）

### 一、个股与板块深度提炼
**这是最重要的部分，必须详细提取。**

对于每篇文章，必须提取：
1. **具体股票名称和代码**：如"泰和XC"、"圣泉JT"、"亨通GD"等，必须保留原始简称
2. **板块产业链位置**：如"PCB上游的上游的上游 - 电子布材料 - 芳纶龙头"、"光纤预制棒"、"覆铜板"、"MLCC镍粉"等
3. **涨价/业绩数据**：具体金额、百分比、时间节点
4. **供需关系**：产能缺口百分比、扩产周期、订单情况
5. **核心逻辑**：为什么看好，具体催化剂

**输出格式（每篇文章独立输出）**：
| 公众号 | 文章标题 | 具体标的 | 板块/产业链位置 | 核心逻辑 | 关键数据 | 作者观点 |
|--------|----------|----------|----------------|----------|----------|----------|

### 二、大盘判断汇总
- 汇总所有文章对大盘的判断（上涨/下跌/震荡/筑底/止跌）
- 列出判断依据和关键数据
- 标注观点来源（公众号名）

### 三、核心观点分类
- 市场趋势判断（保留原文关键措辞）
- 行业分析观点（具体到细分环节）
- 个股推荐/看空观点（含具体标的）
- 操作策略建议（具体到买入/卖出/持有条件）
- 风险警示（具体风险因素）

### 四、操作建议汇总
- 明确的买入建议（含具体标的和条件）
- 明确的卖出建议（含条件）
- 持有/观望建议
- 套利/波段操作建议（含具体手法）

### 五、风险提示汇总
- 市场风险
- 个股风险（具体到标的）
- 行业风险（具体到细分环节）
- 宏观风险

### 六、共识与分歧
- 多篇文章共同认可的观点（共识）
- 观点不一致的地方（分歧）
- 需要进一步验证的假设

## 输出原则

1. **具体性优先**：必须提取具体股票名称、代码、板块名称、数据，禁止抽象概括
2. **保留原文措辞**：关键观点必须保留原文措辞，如"芳纶CTE较低，相比于玻纤布有更好的性能，是高端电子布的首选材料"
3. **产业链深度**：必须梳理清楚产业链上下游关系，如"PPE树脂 → 覆铜板 → PCB → 电子布 → 芳纶"
4. **数据完整性**：所有百分比、金额、时间节点必须保留
5. **观点来源**：每个观点必须标注来源公众号
6. **禁止省略**：6个部分必须全部输出，禁止用"详见上文"等省略
7. **禁止抽象**：禁止用"科技板块"、"AI概念"等抽象词汇，必须用"光纤预制棒"、"MLCC镍粉"等具体词汇

## 注意事项
- 只提取原文明确表达的观点，不要过度推断
- 无明确观点的文章标注"无明确观点"
- 禁止输出"分析摘要"、"共性结论"等额外内容
- 按要求的6个部分输出，不要遗漏
- 每个部分必须包含具体内容，禁止一句话概括
- 表格必须包含表头
`;

// ═══════════════════════════════════════════════════════════════════
// Phase 2: AI 观点分析
// ═══════════════════════════════════════════════════════════════════

// Direct HTTP call to gateway chat completions API (bypasses slow openclaw infer CLI)
const GATEWAY_AUTH = {
  port: JSON.parse(readFileSync(join(process.env.HOME || '~', '.qclaw', 'openclaw.json'), 'utf-8')).gateway.port,
  token: JSON.parse(readFileSync(join(process.env.HOME || '~', '.qclaw', 'openclaw.json'), 'utf-8')).gateway.auth.token,
};

function callLlm(prompt) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('callLlm timeout after 180s'));
    }, 180000);

    fetch(`http://127.0.0.1:${GATEWAY_AUTH.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_AUTH.token}`,
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8192,
      }),
      signal: controller.signal,
    })
      .then(r => r.json())
      .then(data => {
        clearTimeout(timeout);
        resolve(data.choices?.[0]?.message?.content || '');
      })
      .catch(err => {
        clearTimeout(timeout);
        reject(err);
      });
  });
}

export async function analyzeArticles(downloaded) {
  // 清理残留 zombie openclaw-infer 进程，避免阻塞新推理
  try {
    execSync(`ps aux | grep 'openclaw-infer' | grep -v grep | awk '{print $2}' | xargs -r kill -9 2>/dev/null`, { timeout: 5000 });
  } catch { /* non-fatal */ }

  if (downloaded.length === 0) { console.log('⚠️  没有文章需要分析'); return null; }

  console.log(`\n🧠  AI 分析 ${downloaded.length} 篇`);

  // Read all articles
  const articles = downloaded.map(f => ({
    bizName: f.bizName,
    title: f.title,
    url: f.url,
    content: readFileSync(f.filePath, 'utf-8').slice(0, 2000),
  }));

  // Process one article per batch for faster response
  const BATCH_SIZE = 1;
  const allResults = [];

  for (let b = 0; b < articles.length; b += BATCH_SIZE) {
    const batch = articles.slice(b, b + BATCH_SIZE);
    console.log(`  批 ${Math.floor(b / BATCH_SIZE) + 1}/${Math.ceil(articles.length / BATCH_SIZE)}`);

    const prompt = [
      ANALYSIS_PROMPT_TEMPLATE,
      '',
      ...batch.flatMap(a => [
        '---',
        `## ${a.bizName}`,
        `### ${a.title}`,
        a.content,
        '',
      ]),
    ].join('\n');

    try {
      const result = await callLlm(prompt);
      allResults.push(result);
      console.log(`  ✅`);
    } catch (e) {
      console.log(`  ❌ ${e.message}`);
    }

    if (b + BATCH_SIZE < articles.length) await sleep(2000);
  }

  if (allResults.length === 0) return null;

  // Phase 2b: Aggregation - synthesize all individual analyses into a real summary
  console.log(`\n🧠  Phase 2b: 跨文章汇总合成`);
  const aggregatedReport = await aggregateAllResults(allResults, TARGET_DATE);

  // Save per-article file (for IMA)
  const rawConcat = [
    `# 财经观点汇总 — ${TARGET_DATE}`,
    `> 数据来源：微信公众号 | AI自动提取，仅供参考`,
    ``,
    ...allResults,
  ].join('\n\n');

  if (!existsSync(ANALYSIS_DIR)) mkdirSync(ANALYSIS_DIR, { recursive: true });
  
  // Save both versions
  const rp = join(ANALYSIS_DIR, `${TARGET_DATE}-观点汇总.md`);
  writeFileSync(rp, rawConcat, 'utf-8');
  
  // Phase 3 uses the aggregated report (smaller, cleaner)
  const reportForPublish = aggregatedReport || rawConcat;

  return { reportPath: rp, content: reportForPublish };
}

/**
 * Phase 2b: Aggregate individual analysis results into a topic-based summary
 */
async function aggregateAllResults(allResults, targetDate) {
  if (!allResults || allResults.length === 0) return null;

  // If only 1-5 articles, skip aggregation (already good)
  if (allResults.length <= 5) return null;

  const AGGR_BATCH = 8; // process 8 analyses per batch
  const AGGREGATION_PROMPT = `你是一位专业的财经汇总分析师，擅长将多篇财经文章分析结果整合成一份精简的每日市场总结。

## 任务
将以下每篇文章的分析结果整合成一份连贯的每日市场总结。你的输出必须按以下结构组织，且必须跨文章进行横向整合。

## 输出结构

### 一、当日热点板块与个股
- 按板块/主题归类，每个板块描述市场关注度
- 列出讨论该板块的公众号，标注观点一致或分歧
- 只包含有实质性内容的板块，不要生造

### 二、核心观点分类
#### 市场趋势判断
#### 行业分析观点（具体到细分环节）
#### 个股推荐/看空观点（含具体标的）
#### 操作策略建议
#### 风险警示

### 三、共识与分歧
- 多篇文章共同认可的观点
- 观点不一致的地方
- 需要进一步验证的假设

## 输出原则
1. 跨文章整合同板块/同话题的观点，避免按公众号逐个排列
2. 每个观点标注来源公众号
3. 对同一话题的共识和分歧要突出
4. 只提取原文明确表达的观点
5. 如果一组内内容不够完整，基于已有信息输出
6. 输出简洁，避免冗长的表格`;

  const FINAL_AGGR_PROMPT = `以下是你已经生成的${Math.ceil(allResults.length / AGGR_BATCH)}份每日市场总结。请将它们合并成一份最终的每日市场总结报告。

注意：
1. 避免重复同一内容
2. 合并对同一板块/话题的观点
3. 保持精简结构
4. 标注来源公众号
5. 输出格式保持与上文一致`;

  try {
    // Step 1: Aggregate in batches
    const partialResults = [];
    const totalBatches = Math.ceil(allResults.length / AGGR_BATCH);
    
    for (let i = 0; i < allResults.length; i += AGGR_BATCH) {
      const batch = allResults.slice(i, i + AGGR_BATCH);
      const batchNum = Math.floor(i / AGGR_BATCH) + 1;
      console.log(`  聚合 ${batchNum}/${totalBatches}`);
      
      const prompt = AGGREGATION_PROMPT + `\n\n---\n以下是第 ${batchNum}/${totalBatches} 组分析结果：\n\n` + batch.join('\n---\n');
      
      try {
        const result = await callLlm(prompt);
        partialResults.push(result);
        console.log(`  ✅`);
      } catch (e) {
        console.log(`  ⚠️ 单组聚合失败: ${e.message}`);
        partialResults.push(batch.slice(0, 3).join('\n'));
      }
      
      if (i + AGGR_BATCH < allResults.length) await sleep(2000);
    }

    if (partialResults.length === 0) return null;

    // Step 2: Final merge
    let finalReport;
    if (partialResults.length <= 1) {
      finalReport = partialResults[0];
    } else {
      console.log(`  最终合并`);
      const finalPrompt = FINAL_AGGR_PROMPT + `\n\n` + partialResults.join('\n\n---\n\n');
      try {
        finalReport = await callLlm(finalPrompt);
        console.log(`  ✅`);
      } catch (e) {
        console.log(`  ⚠️ 最终合并失败，使用分组结果拼接`);
        finalReport = partialResults.join('\n\n---\n\n');
      }
    }

    // Wrap with title
    const report = [
      `# 财经观点汇总 — ${targetDate}`,
      `> 数据来源：微信公众号 | AI自动提取，仅供参考`,
      ``,
      finalReport,
    ].join('\n\n');

    const fp = join(ANALYSIS_DIR, `${targetDate}-汇总.md`);
    writeFileSync(fp, report, 'utf-8');
    console.log(`  💾 ${fp}`);
    console.log(`  📊 ${allResults.length} 篇分析 → 1 份汇总报告`);

    return report;
  } catch (e) {
    console.error(`  ❌ 聚合失败: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 3: 飞书 Wiki 发布
// ═══════════════════════════════════════════════════════════════════

async function feishuApi(method, endpoint, body = null) {
  const token = getFeishuToken();
  const url = `https://open.feishu.cn/open-apis${endpoint}`;
  const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

async function findChild(parent, title) {
  const { sheet_token: _, ...cfg } = CONFIG.feishu;
  const data = await feishuApi('GET',
    `/wiki/v2/spaces/${CONFIG.feishu.space_id}/nodes?parent_node_token=${parent}&page_size=50`);
  if (data.code !== 0) return null;
  for (const item of data.data?.items || []) {
    if (item.title === title) return item.node_token;
  }
  return null;
}

async function createNode(parent, title) {
  const data = await feishuApi('POST', `/wiki/v2/spaces/${CONFIG.feishu.space_id}/nodes`, {
    parent_node_token: parent, title, obj_type: 'docx', node_type: 'origin',
  });
  if (data.code !== 0) throw new Error(`创建节点失败: ${JSON.stringify(data)}`);
  return data.data.node.node_token;
}

async function ensurePath(root) {
  const yearNode = await findChild(root, YEAR) || await createNode(root, YEAR);
  const monthNode = await findChild(yearNode, MONTH) || await createNode(yearNode, MONTH);
  return monthNode;
}

export async function publishToWiki(reportContent) {
  if (!reportContent) return;

  console.log(`\n📤  飞书 Wiki 发布`);

  // Ensure year/month path
  const parent = CONFIG.feishu.default_parent_node;
  const monthToken = await ensurePath(parent);
  console.log(`  📁 ${YEAR}/${MONTH} → ${monthToken}`);

  // Write to temp file for publisher
  const tmpFile = join(ANALYSIS_DIR || '.', `${TARGET_DATE}-report.md`);
  writeFileSync(tmpFile, reportContent, 'utf-8');

  const publisher = '/Users/totti/.qclaw/skills/feishu-md-publisher/publish.py';
  const title = `${TARGET_DATE} 财经观点汇总`;

  try {
    const out = execSync(`python3 "${publisher}" --title "${title}" --file "${tmpFile}" --parent ${monthToken}`, {
      encoding: 'utf-8', timeout: 60000,
    });
    const urlMatch = out.match(/https:\/\/[^\s]+/);
    console.log(`  ✅ ${title}`);
    if (urlMatch) console.log(`  🔗 ${urlMatch[0]}`);
    return out;
  } catch (e) {
    // feishu-md-publisher 可能在内容写入时因 size 限制失败, 但文档已创建
    // 从 stdout 中提取 doc_token
    const stdout = e.stdout || '';
    const docTokenMatch = stdout.match(/文档创建成功:\s*([a-zA-Z0-9]+)/);
    if (docTokenMatch) {
      const docToken = docTokenMatch[1];
      console.log(`  ⚠️ 内容写入受限，但文档已创建: https://my.feishu.cn/docx/${docToken}`);
      return { docToken, partial: true };
    }
    console.error(`  ❌ ${e.stderr?.substring(0, 300) || e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════

/**
 * 获取构建日期已下载的文章列表
 */
function getExistingArticles(date) {
  if (!existsSync(ARTICLE_DIR)) return [];
  const files = readdirSync(ARTICLE_DIR).filter(f => f.includes(date) && f.endsWith('.md'));
  
  function parseFilename(fname) {
    const prefix = fname.slice(0, -3);
    const dateMarker = `-${date}-`;
    const idx = prefix.indexOf(dateMarker);
    if (idx === -1) return null;
    return {
      bizName: prefix.slice(0, idx),
      title: prefix.slice(idx + dateMarker.length),
    };
  }
  
  const sanitize2 = s => s.replace(/[<>:"\/\\|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  
  return files.map(f => {
    const parsed = parseFilename(f);
    return {
      filePath: join(ARTICLE_DIR, f),
      bizName: parsed?.bizName || 'unknown',
      title: parsed?.title || f,
      imaName: f,
      url: '',
    };
  });
}

/**
 * 处理单个日期
 */
async function processDate(date) {
  // 设置模块级日期变量（供 phase1Partial / publishToWiki 使用）
  TARGET_DATE = date;
  YEAR = date.split('-')[0];
  MONTH = date.split('-')[1];
  
  console.log('\n' + '═'.repeat(58));
  console.log(`📅  处理日期: ${date}`);
  console.log('═'.repeat(58));
  
  // 检查已下载的文章
  const existing = getExistingArticles(date);
  let downloaded = [];
  
  if (existing.length > 0) {
    console.log(`\n📂  检测到已存 ${existing.length} 篇文章，跳过 Phase 1 下载`);
    downloaded = existing;
  } else {
    // Phase 1: Fetch + Download（分批冷却，防 session 频控）
    console.log('\n🚀  Phase 1: 文章拉取');
    const BATCH_SIZE_FETCH = 10;
    const COOLDOWN_MS = 10 * 60 * 1000; // 10 分钟 session 冷却
    const allP1 = { downloaded: [], errors: [], skipped: [], noArticle: [] };
    const allAccounts = await getFakeids();
    const enabledAccounts = allAccounts.filter(a => a.status === '启用');
    
    for (let batchStart = 0; batchStart < enabledAccounts.length; batchStart += BATCH_SIZE_FETCH) {
      const batchNo = Math.floor(batchStart / BATCH_SIZE_FETCH) + 1;
      const totalBatches = Math.ceil(enabledAccounts.length / BATCH_SIZE_FETCH);
      console.log(`\n📦  下载批次 ${batchNo}/${totalBatches} (账号 ${batchStart+1}-${Math.min(batchStart+BATCH_SIZE_FETCH, enabledAccounts.length)})`);
      const p1 = await phase1Partial(enabledAccounts, batchStart, BATCH_SIZE_FETCH);
      allP1.downloaded.push(...p1.downloaded);
      allP1.errors.push(...p1.errors);
      allP1.skipped.push(...p1.skipped);
      allP1.noArticle.push(...p1.noArticle);
      // 批次间冷却
      if (batchStart + BATCH_SIZE_FETCH < enabledAccounts.length) {
        const coolMin = Math.ceil(COOLDOWN_MS / 60000);
        console.log(`\n⏳ Session 冷却 ${coolMin}min...（剩余 ${enabledAccounts.length - batchStart - BATCH_SIZE_FETCH} 个账号）`);
        await sleep(COOLDOWN_MS);
      }
    }
    downloaded = allP1.downloaded;
    console.log(`\n  已下载: ${downloaded.length} 篇 | 错误: ${allP1.errors.length} | 无文章: ${allP1.noArticle.length}`);
  }
  
  if (downloaded.length === 0) {
    console.log('\n⏭️  无文章需要处理');
    return { date, downloaded: 0, analysis: false, wiki: false };
  }
  
  // Phase 1b: IMA Upload
  console.log('\n📤  Phase 1b: IMA 上传');
  const p1b = await phase1b(downloaded);
  console.log(`  ✅ ${p1b.ok} 成功 | ❌ ${p1b.fail} 失败`);
  
  // Phase 2: AI Analysis
  console.log('\n🧠  Phase 2: AI 分析');
  const analysis = await analyzeArticles(downloaded);
  
  // Phase 3: Feishu Wiki publish
  const publishOk = await publishToWiki(analysis?.content);
  
  return {
    date,
    downloaded: downloaded.length,
    analysis: analysis !== null,
    wiki: publishOk !== null,
  };
}

async function main() {
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║  📰 WeChat 公众号工作流 — 多日期模式');
  console.log('║  ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
  console.log('╚' + '═'.repeat(58) + '╝');
  
  // Session check
  const { checkSession } = await import(join(ROOT, 'src/proxy.js'));
  const sess = await checkSession();
  if (!sess.valid) { console.error(`❌ ${sess.message}`); process.exit(1); }
  console.log(`🔑  ${sess.message}\n`);
  
  console.log(`📋  目标日期: ${DATES_TO_PROCESS.join(', ')}`);
  
  // 逐个日期处理
  const results = [];
  for (let i = 0; i < DATES_TO_PROCESS.length; i++) {
    const date = DATES_TO_PROCESS[i];
    const r = await processDate(date);
    results.push(r);
    // 日期间冷却（10秒足够）
    if (i < DATES_TO_PROCESS.length - 1) await sleep(10000);
  }
  
  // 汇总
  console.log('\n' + '═'.repeat(58));
  console.log('🎯  全部完成');
  console.log('═'.repeat(58));
  for (const r of results) {
    console.log(`  📅 ${r.date}: 下载 ${r.downloaded} 篇`);
  }
  console.log('═'.repeat(58));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(`\n❌ ${e.message}`); process.exit(1); });
}
