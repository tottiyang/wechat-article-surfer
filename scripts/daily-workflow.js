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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

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

const TARGET_DATE = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
  || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const [YEAR, MONTH] = TARGET_DATE.split('-');

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
  // 遇到频控后的重试等待（秒）
  RETRY_AFTER_BLOCK: 300,
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
        
        if (result.ret === 200013 || result.base_resp?.ret === 200013) {
          retries++;
          if (retries <= FREQ.MAX_RETRIES) {
            const wait = FREQ.RETRY_AFTER_BLOCK * retries;
            console.log(`  ⚠️  触发频控(ret=200013)，等待 ${wait}s 后重试(${retries}/${FREQ.MAX_RETRIES})...`);
            await sleep(wait * 1000);
            continue;
          } else {
            console.log(`  ⛔ 频控重试耗尽，跳过`);
            finalResult = FETCH_RESULT.FREQ_CONTROL;
            detail = 'ret=200013';
            results.errors.push({ name, error: '频控限制(ret=200013)' });
            break;
          }
        }
        
        if (result.ret === 200002 || result.base_resp?.ret === 200002) {
          console.log(`  ⚠️  API参数无效(ret=200002)，跳过`);
          finalResult = FETCH_RESULT.INVALID_ARGS;
          detail = 'ret=200002';
          results.errors.push({ name, error: '参数无效(ret=200002)' });
          break;
        }
        
        if (result.ret !== 0) {
          console.log(`  ⚠️  API不可用(ret=${result.ret})，跳过`);
          finalResult = FETCH_RESULT.API_ERROR;
          detail = `ret=${result.ret}`;
          results.errors.push({ name, error: `API不可用(ret=${result.ret})` });
          break;
        }
        
        finalResult = FETCH_RESULT.SUCCESS;
        break;
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

function callLlm(prompt) {
  const out = execSync(`openclaw infer model run --model "qclaw/pool-deepseek-v4-flash" --prompt ${JSON.stringify(prompt)} --json 2>/dev/null`, {
    encoding: 'utf-8', timeout: 600000, maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  // Output format: {outputs: [{text: "..."}]}
  return parsed.outputs?.[0]?.text || parsed.response || parsed.text || parsed.content || out;
}

export async function analyzeArticles(downloaded) {
  if (downloaded.length === 0) { console.log('⚠️  没有文章需要分析'); return null; }

  console.log(`\n🧠  AI 分析 ${downloaded.length} 篇`);

  // Read all articles
  const articles = downloaded.map(f => ({
    bizName: f.bizName,
    title: f.title,
    url: f.url,
    content: readFileSync(f.filePath, 'utf-8'),
  }));

  // Process in batches of 3 (reduced from 5 to avoid LLM timeout)
  const BATCH_SIZE = 3;
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
      const result = callLlm(prompt);
      allResults.push(result);
      console.log(`  ✅`);
    } catch (e) {
      console.log(`  ❌ ${e.message}`);
    }

    if (b + BATCH_SIZE < articles.length) await sleep(2000);
  }

  if (allResults.length === 0) return null;

  // Combine into final report
  const report = [
    `# 财经观点汇总 — ${TARGET_DATE}`,
    `> 数据来源：微信公众号 | AI自动提取，仅供参考`,
    ``,
    ...allResults,
  ].join('\n\n');

  if (!existsSync(ANALYSIS_DIR)) mkdirSync(ANALYSIS_DIR, { recursive: true });
  const rp = join(ANALYSIS_DIR, `${TARGET_DATE}-观点汇总.md`);
  writeFileSync(rp, report, 'utf-8');

  return { reportPath: rp, content: report };
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
    console.error(`  ❌ ${e.stderr?.substring(0, 300) || e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log(`║  📰 WeChat 公众号每日工作流`);
  console.log(`║  日期: ${TARGET_DATE}`);
  console.log('╚' + '═'.repeat(58) + '╝');

  // 0. Session check
  const { checkSession } = await import(join(ROOT, 'src/proxy.js'));
  const sess = await checkSession();
  if (!sess.valid) { console.error(`❌ ${sess.message}`); process.exit(1); }
  console.log(`🔑  ${sess.message}\n`);

  // 1. Read all accounts with fakeids
  console.log('📖  读取公众号列表...');
  const allAccounts = await getFakeids();
  console.log(`  共 ${allAccounts.length} 个公众号\n`);

  // Phase 1: Fetch + Download
  console.log('🚀  Phase 1: 文章拉取');
  const p1 = await phase1Partial(allAccounts, 0, allAccounts.length);
  console.log(`\n  已下载: ${p1.downloaded.length} 篇 | 错误: ${p1.errors.length}`);

  // Phase 1b: IMA Upload
  if (p1.downloaded.length > 0) {
    console.log('\n📤  Phase 1b: IMA 上传');
    const p1b = await phase1b(p1.downloaded);
    console.log(`  ✅ ${p1b.ok} 成功 | ❌ ${p1b.fail} 失败`);
  }

  // Phase 2: AI Analysis
  console.log('\n🧠  Phase 2: AI 分析');
  const analysis = await analyzeArticles(p1.downloaded);

  // Phase 3: Feishu Wiki publish
  const publishOk = await publishToWiki(analysis?.content);

  // Summary
  console.log('\n' + '═'.repeat(58));
  console.log('🎯  完成');
  console.log(`  日期: ${TARGET_DATE}`);
  console.log(`  下载: ${p1.downloaded.length} 篇`);
  console.log(`  分析: ${analysis ? '✅' : '⏭️'}`);
  console.log(`  飞书: ${publishOk ? '✅' : '⏭️'}`);
  console.log(`  频控: 公众号间隔 ${FREQ.ACCOUNT_DELAY_MIN}-${FREQ.ACCOUNT_DELAY_MAX}s`);
  console.log(`  批次: ${FREQ.BATCH_SIZE} 个/批, 批次间隔 ${FREQ.BATCH_PAUSE_MIN}-${FREQ.BATCH_PAUSE_MAX}s`);
  console.log('═'.repeat(58));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(`\n❌ ${e.message}`); process.exit(1); });
}
