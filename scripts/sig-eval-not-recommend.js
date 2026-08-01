#!/usr/bin/env node
/**
 * sig-eval-not-recommend.js
 * 
 * 对F=不推荐+G为空的账号，通过searchbiz获取签名评估
 * searchbiz API不受频控影响
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
const WC = JSON.parse(readFileSync(join(ROOT, '.data', 'wechat-cookies.json'), 'utf-8'));
const WC_TOKEN = WC.token;
const WC_COOKIE = (WC.cookies||[]).filter(c=>c.value!=='EXPIRED').map(c=>c.name+'='+c.value).join('; ');
const TOKEN_FILE = CONFIG.feishu.token_file.replace(/^~/, process.env.HOME || '');

let accessToken = '';
async function refreshToken() {
  const t = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  accessToken = t.access_token;
}
async function feishu(method, endpoint, body = null) {
  const r = await fetch(`https://open.feishu.cn/open-apis${endpoint}`, {
    method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}
async function readSheet() {
  await refreshToken();
  const r = await feishu('GET', `/sheets/v2/spreadsheets/${CONFIG.feishu.sheet_token}/values/${CONFIG.feishu.sheet_id}!A1:G220`);
  return r.data?.valueRange?.values || [];
}
async function writeCell(row, value) {
  await refreshToken();
  await feishu('PUT', `/sheets/v2/spreadsheets/${CONFIG.feishu.sheet_token}/values`, {
    valueRange: { range: `${CONFIG.feishu.sheet_id}!G${row}:G${row}`, values: [[value]] }
  });
}

const INVEST_KEYWORDS = ['投资','股票','股市','基金','理财','金融','A股','财经','证券','交易','操盘','涨停','跌停','复盘','研报','调研','研究','经济','牛股','黑马','量化','趋势','价值投资','策略','市','期','资','财富'];

function evaluateSignature(name, sig) {
  if (!sig || sig.trim() === '') {
    return `签名评估: 无签名信息 → 无法判断`;
  }
  let score = 0;
  const reasons = [];
  const lowerSig = sig.toLowerCase();
  const lowerName = name.toLowerCase();

  for (const kw of INVEST_KEYWORDS) {
    if (lowerSig.includes(kw)) { score += 2; reasons.push(kw); }
  }
  if (lowerName.includes('投资') || lowerName.includes('股') || lowerName.includes('财') || lowerName.includes('金')) {
    score += 1;
  }

  const sigShort = sig.length > 30 ? sig.substring(0,30) + '...' : sig;

  if (score >= 4) {
    return `签名评估: 投资相关(${score}分) | ${sigShort}`;
  } else if (score >= 2) {
    return `签名评估: 弱投资信号(${score}分) | ${sigShort}`;
  } else {
    return `签名评估: 无关(${score}分) | ${sigShort}`;
  }
}

async function getSignature(name) {
  if (!name) return '';
  const url = `https://mp.weixin.qq.com/cgi-bin/searchbiz?action=search_biz&begin=0&count=5&query=${encodeURIComponent(name)}&token=${WC_TOKEN}&lang=zh_CN&f=json&ajax=1`;
  try {
    const r = await fetch(url, {
      headers: { 'Cookie': WC_COOKIE, 'Referer': 'https://mp.weixin.qq.com/' }
    });
    const d = JSON.parse(await r.text());
    const list = d.list || [];
    const match = list.find(a => a.nickname === name);
    if (match) return match.signature || '';
    if (list.length > 0) return list[0].signature || '';
    return '';
  } catch(e) { return ''; }
}

async function main() {
  await refreshToken();
  const rows = await readSheet();
  if (rows.length < 2) { console.log('❌ 空表'); return; }

  // Find F=不推荐 + G=空
  const needEval = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = (row[0] || '').trim();
    const fVal = (row[5] || '').trim();
    const gVal = (row[6] || '').trim();
    if (!name) continue;
    if (fVal === '不推荐' && !gVal) {
      needEval.push({ row: i + 1, name });
    }
  }

  console.log(`待评估: ${needEval.length} 个\n`);
  let success = 0;
  let skipped = 0;

  for (let i = 0; i < needEval.length; i++) {
    const a = needEval[i];
    process.stdout.write(`[${i+1}/${needEval.length}] ${a.name.substring(0,16).padEnd(16)} →`);

    const sig = await getSignature(a.name);
    const note = evaluateSignature(a.name, sig);

    await writeCell(a.row, note.substring(0, 180));
    success++;
    process.stdout.write(` ✅\n`);

    // 1s cooldown
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 500));
  }

  console.log(`\n✅ 完成: ${needEval.length} 个已评估`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
