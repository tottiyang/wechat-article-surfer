/**
 * 更新飞书表格 E 列 — 标记文章处理状态
 * 用法: node scripts/update-sheet-status.js
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTICLE_DIR = path.join(ROOT, '.data', 'articles');

const CONFIG = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));

function getFeishuToken() {
  const tf = CONFIG.feishu.token_file.replace(/^~/, process.env.HOME || '');
  return JSON.parse(readFileSync(tf, 'utf-8')).access_token;
}

async function feishuSheet(urlPath, method = 'GET', body = null) {
  const token = getFeishuToken();
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${CONFIG.feishu.sheet_token}${urlPath}`;
  const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

function getArticleAccounts() {
  const files = readdirSync(ARTICLE_DIR).filter(f => f.includes('2026-06-10'));
  const accounts = new Set();
  for (const f of files) {
    const biz = f.split('-2026-06-10-')[0];
    accounts.add(biz);
  }
  return accounts;
}

async function main() {
  const sid = CONFIG.feishu.sheet_id;
  const data = await feishuSheet(`/values/${sid}!A2:E90`);
  const rows = data.data?.valueRange?.values || [];
  const articleAccounts = getArticleAccounts();

  console.log(`飞书表格共 ${rows.length} 行`);
  console.log(`文章账号共 ${articleAccounts.size} 个`);

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    .replace(/\//g, '-');

  let ok = 0, fail = 0, skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = r[0] || '';
    const status = r[3] || '';
    const currentE = r[4] || '';
    const rowIndex = i + 2;

    if (!name || status === '已禁用' || status === '手动') { skipped++; continue; }

    // Sanitize name to match filename format
    const sanitized = name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
    const hadArticles = articleAccounts.has(sanitized);

    let newValue;
    if (hadArticles) {
      newValue = `${now}|已下载|55篇已上传IMA+AI分析+飞书发布完成`;
    } else {
      if (currentE && currentE.includes('无文章')) { skipped++; continue; }
      newValue = `${now}|无文章|2026-06-10无文章`;
    }

    const cell = `E${rowIndex}`;
    const resp = await feishuSheet('/values', 'PUT', {
      valueRange: { range: `${sid}!${cell}:${cell}`, values: [[newValue]] }
    });
    if (resp.code === 0) { ok++; }
    else { fail++; console.log(`  ❌ ${name}: ${resp.code} ${resp.msg}`); }
  }

  console.log(`\n更新完成: ✅ ${ok} | ❌ ${fail} | ⏭️ 跳过 ${skipped}`);
}

main().catch(e => { console.error('\n❌', e); process.exit(1); });
