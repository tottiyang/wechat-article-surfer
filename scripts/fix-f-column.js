#!/usr/bin/env node
/** Fix F column for recommended accounts still marked as 不推荐 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
const TOKEN_FILE = CONFIG.feishu.token_file.replace(/^~/, process.env.HOME || '');
const ST = CONFIG.feishu.sheet_token;
const SID = CONFIG.feishu.sheet_id;

let accessToken = '';
async function refresh() {
  const t = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  accessToken = t.access_token;
}
async function call(method, endpoint, body) {
  const r = await fetch(`https://open.feishu.cn/open-apis${endpoint}`, {
    method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}
async function writeCell(row, col, value) {
  const cl = String.fromCharCode(64 + col);
  await refresh();
  const r = await call('PUT', `/sheets/v2/spreadsheets/${ST}/values`, {
    valueRange: { range: `${SID}!${cl}${row}:${cl}${row}`, values: [[value]] }
  });
  return r.code || 0;
}

// Rows to fix: (row, name, eval_marker)
const fixes = [
  [167, '复盘逻辑', '⭐⭐'],
  [188, '守望核心', '⭐⭐'],
  [200, '总龙头战法', '⭐⭐'],
  [195, '逻辑研究社', '⭐⭐'],
  [191, '林不再的选股思路', '⭐⭐'],
  [190, '海里的小龙龙', '⭐⭐'],
  [197, '新三板评论', '⭐⭐'],
  [196, '逐鹿大北交', '⭐⭐'],
  [193, '老韭菜生存日记', '⭐'],
  [192, '捌个点', '⭐'],
  [194, '计算机的畅想', '⭐'],
  [203, '福禄娃爷爷', '⭐'],
];

async function main() {
  await refresh();
  console.log('=== Fix F=重点 ===');
  for (const [row, name] of fixes) {
    const code = await writeCell(row, 6, '重点');
    console.log(`  F${row} (${name}) = 重点 -> code=${code}`);
  }
  
  console.log('\n=== Update G append ===');
  for (const [row, name, marker] of fixes) {
    // Read current G
    const g = await call('GET', `/sheets/v2/spreadsheets/${ST}/values/${SID}!G${row}:G${row}`);
    const cur = g.data?.valueRange?.values?.[0]?.[0] || '';
    const append = cur ? `${cur} | ✅ 建议启用(${marker})` : `签名评估: ✅ 建议启用(${marker}) | ${name}`;
    const code = await writeCell(row, 7, append.substring(0, 180));
    console.log(`  G${row} (${name}) -> code=${code}`);
  }
  console.log('\n✅ Done');
}
main().catch(e => { console.error(e.message); process.exit(1); });
