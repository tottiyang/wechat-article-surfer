#!/usr/bin/env node
/**
 * find-new-fakeids.js — 为新增的135个公众号搜索FakeId
 * 
 * 读取飞书表格 Row 69~203 (状态已设为启用) → 搜索微信 → 更新C列(FakeId)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Config
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
const ftokens = JSON.parse(readFileSync(cfg.feishu.token_file, 'utf-8'));
const FB_TOKEN = ftokens.user_access_token || ftokens.access_token;
const SHEET_TOKEN = cfg.feishu.sheet_token;
const SHEET_ID = cfg.feishu.sheet_id;

// WeChat cookies
const WC_CK = JSON.parse(readFileSync(join(ROOT, '.data', 'wechat-cookies.json'), 'utf-8'));
const WC_TOKEN = WC_CK.token;
const COOKIE_STR = (WC_CK.cookies || [])
  .filter(c => c.value !== 'EXPIRED')
  .map(c => c.name + '=' + c.value)
  .join('; ');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Search one account on weixin platform */
async function searchOne(name) {
  const url = `https://mp.weixin.qq.com/cgi-bin/searchbiz?action=search_biz&begin=0&count=5&query=${encodeURIComponent(name)}&token=${WC_TOKEN}&lang=zh_CN&f=json&ajax=1`;
  
  for (let retry = 0; retry < 3; retry++) {
    try {
      const resp = await fetch(url, {
        headers: { 'Cookie': COOKIE_STR, 'Referer': 'https://mp.weixin.qq.com/' }
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { base_resp: { ret: -1, err_msg: 'parse error' } }; }
      
      const ret = data.base_resp?.ret;
      if (ret === 200013) {
        console.log(`   ⏳ 频控，等待 30s...`);
        await sleep(30000);
        continue;
      }
      if (ret !== 0) {
        console.log(`   ❌ ret=${ret}: ${data.base_resp?.err_msg || ''}`);
        return { fakeid: null, alias: null };
      }
      
      const list = data.list || [];
      const match = list.find(a => a.nickname === name);
      if (match) return { fakeid: match.fakeid, alias: match.alias || null };
      
      if (list.length > 0 && list[0].nickname.startsWith(name)) {
        console.log(`   ⚠️  模糊: "${list[0].nickname}" → ${list[0].fakeid}`);
        return { fakeid: list[0].fakeid, alias: list[0].alias || null };
      }
      
      // Try fuzzy with special chars removed
      const stripped = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '');
      const fuzzy = list.find(a => a.nickname.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '') === stripped);
      if (fuzzy) {
        console.log(`   ⚠️  模糊(去符号): "${fuzzy.nickname}" → ${fuzzy.fakeid}`);
        return { fakeid: fuzzy.fakeid, alias: fuzzy.alias || null };
      }
      
      console.log(`   ❌ 未匹配, 候选: ${list.map(a=>a.nickname).join('、') || '空'}`);
      return { fakeid: null, alias: null };
    } catch (e) {
      console.log(`   ❌ 请求异常: ${e.message}`);
      return { fakeid: null, alias: null };
    }
  }
  return { fakeid: null, alias: null };
}

async function updateSheetCell(rowNum, col, value) {
  const cell = `${col}${rowNum}`;
  const range = `${SHEET_ID}!${cell}:${cell}`;
  const body = { valueRange: { range, values: [[value]] } };
  const resp = await fetch(`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${FB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  return data.code === 0;
}

async function main() {
  console.log('🔍  新公众号 FakeId 搜索');
  console.log('═'.repeat(50));
  
  // Step 1: Read new accounts (Row 69~) from sheet
  const resp = await fetch(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${SHEET_ID}!A69:C204`,
    { headers: { 'Authorization': `Bearer ${FB_TOKEN}` } }
  );
  const data = await resp.json();
  const rows = data.data?.valueRange?.values || [];
  
  const accounts = [];
  for (let i = 0; i < rows.length; i++) {
    const name = (rows[i][0] || '').trim();
    const fakeid = (rows[i][2] || '').trim();
    if (!name) break; // break on first empty row
    accounts.push({ rowNum: i + 69, name, existingFakeid: fakeid });
  }
  
  console.log(`需要搜索: ${accounts.length} 个公众号\n`);
  
  // Step 2: Search each account sequentially
  let success = 0;
  let fail = 0;
  const failedList = [];
  
  for (let i = 0; i < accounts.length; i++) {
    const { rowNum, name, existingFakeid } = accounts[i];
    
    // Skip if already has fakeid
    if (existingFakeid) {
      console.log(`[${i+1}/${accounts.length}] ${name} → 已有 FakeId，跳过`);
      continue;
    }
    
    process.stdout.write(`[${i+1}/${accounts.length}] ${name}...`);
    const { fakeid, alias } = await searchOne(name);
    
    if (fakeid) {
      const ok1 = await updateSheetCell(rowNum, 'C', fakeid);
      if (ok1) {
        console.log(` ✅ ${fakeid}`);
        success++;
      } else {
        console.log(` ⚠️ 找到但飞书更新失败: ${fakeid}`);
        fail++;
      }
      // Also update wechat_id (B column) if alias found
      if (alias) {
        await updateSheetCell(rowNum, 'B', alias);
      }
    } else {
      console.log(` ❌`);
      fail++;
      failedList.push(name);
    }
    
    await sleep(1500);
  }
  
  console.log('\n' + '═'.repeat(50));
  console.log(`✅ 完成: ${success} 成功, ${fail} 失败`);
  if (failedList.length > 0) {
    console.log('\n❌ 未找到的公众号:');
    failedList.forEach(n => console.log(`   ${n}`));
  }
}

main().catch(e => { console.error('致命错误:', e.message); process.exit(1); });
