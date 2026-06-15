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
 * 解析 E 列时间戳中的日期
 * E 列格式: "2026/6/15 18:58:00|成功|4篇"
 * @param {string} ts - 时间戳字符串
 * @returns {string|null} - "YYYY-MM-DD" 格式，解析失败返回 null
 */
function parseTimestampDate(ts) {
  if (!ts) return null;
  const m = ts.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!m) return null;
  const mo = m[2].padStart(2, '0');
  const d = m[3].padStart(2, '0');
  return `${m[1]}-${mo}-${d}`;
}

/**
 * 判断账号是否需要补跑（日期感知）
 * 
 * E 列记录的是某次拉取的结果，但那个结果可能来自旧日期。
 * 例：账号A 6/12 拉过但 6/15 没拉过，E 列显示 "2026/6/12 09:00|无文章"
 * 此时对 6/15 而言，该账号是"从未拉取"状态，不能因为 6/12 没文章就推断 6/15 也没文章。
 * 
 * @param {Object} account - 账号信息
 * @param {string} [targetDate] - 目标日期 "YYYY-MM-DD"，不传时保持旧行为
 * @returns {boolean} - 是否需要补跑
 */
function needRetry(account, targetDate) {
  // 非启用状态不补跑
  if (account.status !== '启用') return false;
  
  // 从未拉取过，需要补跑
  if (!account.lastResult || account.lastResult === FETCH_RESULT.PENDING) return true;
  
  // 解析：E 列格式为 "2026/6/15 18:58:00|成功|4篇"
  const parts = account.lastResult.split('|');
  const ts = parts[0];
  const result = parts[1] || parts[0];
  
  // 日期感知：检查结果日期是否等于目标日期
  if (targetDate) {
    const tsDate = parseTimestampDate(ts);
    if (tsDate && tsDate !== targetDate) {
      // 结果是旧日期的，对当前目标日期来说该账号未处理
      return true;
    }
  }
  
  // 只有特定错误需要重试
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

// 逐篇提取提示词（每批批量提取）
const EXTRACT_PROMPT_TEMPLATE = `你是一位专业的财经数据提取员。从以下文章中提取关键投资信息。

## 输出格式（严格遵循，不要添加任何额外叙述）

对每篇文章，输出以下字段，每行一个字段，格式为"字段名: 内容"：

来源: <公众号名> — <文章标题>
板块/行业: <涉及的具体板块、行业、概念，多个用逗号分隔>
具体标的: <明确提到的股票/ETF/转债名称和代码，多个用逗号分隔>
市场判断: <对大盘/板块的判断，1-2句话>
核心观点: <关键逻辑、定性观点、情绪判断、市场观察、案例对比。如有具体数据必须附上。无则写"无">
操作建议: <推荐的操作和条件>
风险提示: <提示的风险点>

## 重要规则

1. 如果某项数据原文确实未提及，写"无"
2. 允许提取定性观点、情绪判断、市场观察，不要只认数字
3. 叙事类内容（案例、段子、对比）也是信息，提取其反映的市场情绪或观点
4. 不要添加"文章一/二/三"等编号
5. 不要添加"我来提取"等自说自话
6. 不要添加任何markdown标题（如###）
7. 只输出字段行，每行格式必须是"字段名: 内容"
8. 文章之间用"---"分隔
9. 如果文章不是财经内容（如电影评论、纯数据记录），所有字段写"无"，并在来源后标注"[非财经]"`;

// 跨批次聚合提示词（1次调用合并所有提取结果）
const MERGE_PROMPT = `你是一位专业的财经汇总分析师。以下是多篇财经公众文章的分析结果。请将它们合并成一份扎实的每日市场总结。

## 合并铁律

### 铁律一：具体标的全量保留
所有文章提及的股票/ETF/转债/期货品种，一个都不能少。
格式：[标的名称（代码）] 方向: 观点 (来源)

### 铁律二：每条观点标注具体来源公众号
禁止用"来源涵盖多家公众号"式模糊表述

### 铁律三：保留特色观点
保留反共识判断、有趣比喻、极端观点、独特分析框架

### 铁律四：过滤非财经内容
如果某篇文章标注[非财经]，直接跳过不纳入汇总

### 输出格式

## 一、热点板块与个股
按板块/主题归类，每种观点标注源公众号

## 二、核心观点分类
### 市场趋势判断
逐条列出，每条标注来源

### 行业分析观点
逐条展开，含具体逻辑和数据，标注来源

### 个股推荐/看空
表格形式：标的 | 方向 | 观点 | 原因 | 来源

### 操作策略建议
每条含条件/理由和来源

### 风险警示
每条含风险点和来源

## 三、共识与分歧
- 多家共同认可（标注来源）
- 不一致的立场和依据
- 核心分歧原因`;

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
    // 🔧 优先从环境变量读，如果没有则从 config.json 读（解决 cron 子进程不加载 ~/.zshrc 的问题）
    let apiKey = process.env.KIMI_API_KEY;
    if (!apiKey) {
      try {
        const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
        apiKey = cfg.kimi?.api_key;
      } catch (e) {
        // ignore
      }
    }
    if (!apiKey) {
      reject(new Error('KIMI_API_KEY not set'));
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Kimi API timeout after 180s'));
    }, 180000);

    fetch('https://api.kimi.com/coding/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'kimi-for-coding',
        max_tokens: 16384,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })
      .then(r => {
        if (!r.ok) throw new Error(`Kimi API ${r.status}`);
        return r.json();
      })
      .then(data => {
        clearTimeout(timeout);
        const content = data.content?.[0]?.text || '';
        if (content) {
          resolve(content);
        } else {
          reject(new Error('Kimi API returned empty content'));
        }
      })
      .catch(err => {
        clearTimeout(timeout);
        reject(err);
      });
  });
}

// ═══════════════════════════════════════════════════════════════════
// 确定性报告聚合（无LLM合并，不丢数据）
// ═══════════════════════════════════════════════════════════════════

/** 解析单篇文章的字段提取结果 */
function parseArticleFields(text) {
  const fields = {};
  const lines = text.split('\n');
  let currentKey = null, currentVal = [];
  
  for (const line of lines) {
    const m = line.match(/^(来源|板块\/行业|具体标的|市场判断|核心观点|操作建议|风险提示):\s*(.*)/);
    if (m) {
      if (currentKey) fields[currentKey] = currentVal.join('\n').trim();
      currentKey = m[1];
      currentVal = [m[2]];
    } else if (currentKey && line.trim()) {
      currentVal.push(line);
    }
  }
  if (currentKey) fields[currentKey] = currentVal.join('\n').trim();
  
  const src = fields['来源'] || '';
  const sep = src.indexOf(' — ');
  const rawTitle = sep > 0 ? src.slice(sep + 3).trim() : '';
  const isNonFinance = src.includes('[非财经]');
  return {
    source: sep > 0 ? src.slice(0, sep).trim() : src,
    title: rawTitle.replace(/\s*\[非财经\]\s*$/, '').trim(),
    sectors: (fields['板块/行业'] || '').split(',').map(s => s.trim()).filter(Boolean),
    stocks: (fields['具体标的'] || '').split(',').map(s => s.trim()).filter(s => s && s !== '无'),
    marketView: fields['市场判断'] || '',
    coreView: fields['核心观点'] || '',
    strategy: fields['操作建议'] || '',
    risk: fields['风险提示'] || '',
    isNonFinance,
    isEmpty: ['来源','板块/行业','具体标的','市场判断','核心观点','操作建议','风险提示'].every(k => !fields[k] || fields[k] === '无'),
  };
}

/** 解析全部批次的提取结果 */
function parseAllArticles(rawText) {
  // 按 --- 分割每个公众号的提取
  const blocks = rawText.split(/\n---\s*\n/);
  const articles = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed === '---') continue;
    const a = parseArticleFields(trimmed);
    if (a.source || a.coreView !== '无') articles.push(a);
  }
  return articles;
}

/** 构建结构化汇总报告 */
function buildStructuredReport(articles, targetDate, totalCount) {
  const hasContent = a => !a.isEmpty && !a.isNonFinance;
  const valid = articles.filter(hasContent);
  
  // 若无一篇文章有有效提取，退回简单串联模式
  if (valid.length === 0) {
    return [`# 财经观点汇总 — ${targetDate}`,
      `> 数据来源：微信公众号 | AI自动提取，仅供参考`,
      `> 共分析 ${totalCount} 篇文章（均无有效提取）`,
      '',
      ...articles.map(a => `- **${a.source}** — ${a.title}${a.isNonFinance ? ' [非财经]' : ''}`),
    ].join('\n');
  }
  
  // ── 1. 大盘判断 ──
  const marketViews = valid.filter(a => a.marketView && a.marketView !== '无');
  
  // ── 2. 热点板块聚合 ──
  const sectorMap = new Map();  // sector → [{ source, coreView, strategy }]
  for (const a of valid) {
    for (const s of a.sectors) {
      if (!s || s === '无') continue;
      if (!sectorMap.has(s)) sectorMap.set(s, []);
      sectorMap.get(s).push({ source: a.source, coreView: a.coreView, strategy: a.strategy });
    }
  }
  // 按提及频率排序
  const sortedSectors = [...sectorMap.entries()].sort((a, b) => b[1].length - a[1].length);
  
  // ── 3. 投资标的（表格）──
  const stockRows = [];
  for (const a of valid) {
    for (const s of a.stocks) {
      // 从核心观点里提取方向
      let direction = '关注';
      const cv = a.coreView || '';
      if (/看好|利好|受益|值得|建议买入|建议加仓|放量/.test(cv)) direction = '🔺 看好';
      else if (/警惕|风险|谨慎|卖出|回避|减仓/.test(cv)) direction = '🔻 谨慎';
      stockRows.push({ stock: s, source: a.source, direction, logic: cv.slice(0, 80) });
    }
  }
  
  // ── 4. 操作策略 ──
  const strategies = [];
  for (const a of valid) {
    if (a.strategy && a.strategy !== '无') {
      strategies.push({ source: a.source, text: a.strategy });
    }
  }
  
  // ── 5. 风险提示 ──
  const risks = [];
  for (const a of valid) {
    if (a.risk && a.risk !== '无') {
      risks.push({ source: a.source, text: a.risk });
    }
  }
  
  // ── 构建 Markdown ──
  const lines = [
    `# 财经观点汇总 — ${targetDate}`,
    `> 数据来源：微信公众号 | AI自动提取，仅供参考`,
    `> 共分析 ${totalCount} 篇文章`,
    '',
  ];
  
  // 1. 大盘判断
  if (marketViews.length > 0) {
    lines.push('## 一、大盘判断', '');
    for (const a of marketViews) {
      lines.push(`**${a.source}**：${a.marketView}`);
      if (a.coreView && a.coreView !== '无') {
        const short = a.coreView.length > 120 ? a.coreView.slice(0, 120) + '…' : a.coreView;
        lines.push(`> ${short}`);
      }
      lines.push('');
    }
  }
  
  // 2. 热点板块
  if (sortedSectors.length > 0) {
    lines.push('## 二、热点板块', '');
    const topSectors = sortedSectors.slice(0, 15);
    for (const [sector, entries] of topSectors) {
      const sources = [...new Set(entries.map(e => e.source))];
      lines.push(`### ${sector}（${sources.length} 个来源）`);
      lines.push(`涵盖：${sources.join('、')}`);
      // 取代表性观点
      const views = entries.filter(e => e.coreView && e.coreView !== '无');
      if (views.length > 0) {
        const sample = views.slice(0, 3).map(v => `- [${v.source}] ${v.coreView.slice(0, 150)}`).join('\n');
        lines.push(sample);
      }
      lines.push('');
    }
  }
  
  // 3. 投资标的
  if (stockRows.length > 0) {
    lines.push('## 三、投资标的', '');
    lines.push('| 标的 | 来源 | 方向 | 逻辑 |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of stockRows.slice(0, 50)) {
      lines.push(`| ${r.stock} | ${r.source} | ${r.direction} | ${r.logic} |`);
    }
    if (stockRows.length > 50) {
      lines.push(`| … | 共 ${stockRows.length} 个标的 |  |  |`);
    }
    lines.push('');
  }
  
  // 4. 操作策略
  if (strategies.length > 0) {
    lines.push('## 四、操作策略', '');
    for (const s of strategies) {
      lines.push(`- **[${s.source}]** ${s.text}`);
    }
    lines.push('');
  }
  
  // 5. 风险提示
  if (risks.length > 0) {
    lines.push('## 五、风险提示', '');
    for (const r of risks) {
      lines.push(`- **[${r.source}]** ${r.text}`);
    }
    lines.push('');
  }
  
  // 6. 原始文章列表
  lines.push('---');
  lines.push('');
  lines.push('### 原文清单');
  lines.push('');
  for (const a of articles) {
    const tag = a.isNonFinance ? ' [非财经]' : a.isEmpty ? ' [无有效提取]' : '';
    lines.push(`- **${a.source}** — ${a.title}${tag}`);
  }
  
  return lines.join('\n');
}


export async function analyzeArticles(downloaded) {
  // 清理残留 zombie openclaw-infer 进程，避免阻塞新推理
  try {
    execSync(`ps aux | grep 'openclaw-infer' | grep -v grep | awk '{print $2}' | xargs -r kill -9 2>/dev/null`, { timeout: 5000 });
  } catch { /* non-fatal */ }

  if (downloaded.length === 0) { console.log('⚠️  没有文章需要分析'); return null; }

  console.log(`\n🧠  AI 分析 ${downloaded.length} 篇`);

  // Read all articles (increase content length for better extraction)
  const articles = downloaded.map(f => ({
    bizName: f.bizName,
    title: f.title,
    url: f.url,
    content: readFileSync(f.filePath, 'utf-8').slice(0, 4000),
  }));

  // 分批提取（10篇/批→6批=6次调用，减少超时风险）
  const BATCH_SIZE = 10;
  const allResults = [];

  for (let b = 0; b < articles.length; b += BATCH_SIZE) {
    const batch = articles.slice(b, b + BATCH_SIZE);
    console.log(`  批${Math.floor(b / BATCH_SIZE) + 1}/${Math.ceil(articles.length / BATCH_SIZE)} (${batch.length}篇)`);

    const prompt = [
      EXTRACT_PROMPT_TEMPLATE,
      '',
      ...batch.flatMap(a => [
        '---',
        `公众号: ${a.bizName}`,
        `标题: ${a.title}`,
        a.content,
        '',
      ]),
    ].join('\n');

    try {
      const result = await callLlm(prompt);
      allResults.push(result);
      console.log(`  ✅ (${(result.length / 1024).toFixed(1)}KB)`);
    } catch (e) {
      console.log(`  ❌ ${e.message}`);
    }

    if (b + BATCH_SIZE < articles.length) await sleep(2000);
  }

  if (allResults.length === 0) return null;

  // Phase 2b: 直接串联各批提取结果（跳过LLM合并，保留完整细节）
  // 之前的实践表明LLM合并阶段会被过度精简→丢失具体标的和特色观点
  console.log(`\n📎  串联 ${allResults.length} 批提取结果（跳过LLM合并，保留完整细节）`);
  
  // 清理每批结果中的LLM自说自话和格式问题
  const cleanedResults = allResults.map(r => {
    // 去除常见的LLM自说自话前缀
    let cleaned = r
      .replace(/^我来(逐一)?提取.*\n?/gi, '')
      .replace(/^以下是.*\n?/gi, '')
      .replace(/^开始(分析|提取).*\n?/gi, '')
      .replace(/^好的[，,].*\n?/gi, '')
      .trim();
    return cleaned;
  });
  
  // Phase 2b: 确定性聚合（解析字段 → 结构化报告）
  const articlesParsed = parseAllArticles(cleanedResults.join('\n\n'));
  const structuredReport = buildStructuredReport(articlesParsed, TARGET_DATE, downloaded.length);

  if (!existsSync(ANALYSIS_DIR)) mkdirSync(ANALYSIS_DIR, { recursive: true });
  const rp = join(ANALYSIS_DIR, `${TARGET_DATE}-观点汇总.md`);
  writeFileSync(rp, structuredReport, 'utf-8');
  
  const reportSizeKB = (structuredReport.length / 1024).toFixed(1);
  console.log(`  💾 ${rp} (${reportSizeKB}KB)`);

  return { reportPath: rp, content: structuredReport };
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
  let downloaded = existing.length > 0 ? [...existing] : [];
  
  // ============================================================
  // Phase 1: 文章拉取（日期感知的断点续传）
  // ============================================================
  // 设计原则：
  // 1. E 列记录了每个账号在特定日期的拉取结果
  // 2. 对当前日期而言，如果一个账号的 E 列没有当日结果 → 需要拉取（从未处理/旧日期结果）
  // 3. 如果一个账号的 E 列有当日成功/无文章结果 → 跳过（已处理完毕）
  // 4. 如果一个账号的 E 列有当日错误结果 → 需要重试
  // 5. 这天然支持中断续传：第1批10个账号已写E列，重启后只拉第11个开始的账号
  // 6. 也支持 backlog 旧日期：账号的 E 列有旧日期结果 → 对 backlog 日期仍需拉取
  {
    const allAccounts = await getFakeids();
    const enabled = allAccounts.filter(a => a.status === '启用');
    
    // 日期感知过滤：对于当前 TARGET_DATE，哪些账号需要拉取
    const pending = enabled.filter(a => needRetry(a, TARGET_DATE));
    const skipped = enabled.filter(a => !needRetry(a, TARGET_DATE));
    
    if (skipped.length > 0) {
      console.log(`\n📋  跳过 ${skipped.length} 个已处理账号（当日结果已记录）`);
    }
    
    if (pending.length === 0) {
      console.log(`\n📂  全部 ${enabled.length} 个启用账号已完成当日拉取，跳过 Phase 1 下载`);
    } else {
      console.log(`\n🚀  Phase 1: 文章拉取（断点续传）`);
      console.log(`  📊 启用: ${enabled.length} | 待拉取: ${pending.length} | 已完成: ${skipped.length}`);
      
      const BATCH_SIZE_FETCH = 10;
      const COOLDOWN_MS = 10 * 60 * 1000;
      const allP1 = { downloaded: [], errors: [], skipped: [], noArticle: [] };
      
      for (let batchStart = 0; batchStart < pending.length; batchStart += BATCH_SIZE_FETCH) {
        const batchNo = Math.floor(batchStart / BATCH_SIZE_FETCH) + 1;
        const totalBatches = Math.ceil(pending.length / BATCH_SIZE_FETCH);
        console.log(`\n📦  下载批次 ${batchNo}/${totalBatches} (账号 ${batchStart+1}-${Math.min(batchStart+BATCH_SIZE_FETCH, pending.length)})`);
        const p1 = await phase1Partial(pending, batchStart, BATCH_SIZE_FETCH);
        allP1.downloaded.push(...p1.downloaded);
        allP1.errors.push(...p1.errors);
        allP1.skipped.push(...p1.skipped);
        allP1.noArticle.push(...p1.noArticle);
        // 批次间冷却
        if (batchStart + BATCH_SIZE_FETCH < pending.length) {
          const coolMin = Math.ceil(COOLDOWN_MS / 60000);
          console.log(`\n⏳ Session 冷却 ${coolMin}min...（剩余 ${pending.length - batchStart - BATCH_SIZE_FETCH} 个账号）`);
          await sleep(COOLDOWN_MS);
        }
      }
      downloaded = allP1.downloaded;
      console.log(`\n  文章: ${downloaded.length} 篇 | 无文章: ${allP1.noArticle.length} | 错误: ${allP1.errors.length}`);
    }
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
