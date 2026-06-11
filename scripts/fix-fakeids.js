#!/usr/bin/env node
/**
 * fix-fakeids.js — 重新搜索公众号并修复飞书表格中的 FakeId
 *
 * 读取飞书表格 A 列(名称) → 搜索微信 → 更新 C 列(FakeId)
 * 处理频率限制(ret=200013)，自动等待后重试
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname; // scripts/
const PROJECT = join(ROOT, '..');

// Load config
const cfg = JSON.parse(readFileSync(join(PROJECT, 'config.json'), 'utf-8'));
const ftokens = JSON.parse(readFileSync(cfg.feishu.token_file, 'utf-8'));
const FB_TOKEN = ftokens.user_access_token || ftokens.access_token;
const SHEET_TOKEN = cfg.feishu.sheet_token;
const SHEET_ID = cfg.feishu.sheet_id;

// WeChat credentials
const WC_CK = JSON.parse(readFileSync(join(PROJECT, '.data', 'wechat-cookies.json'), 'utf-8'));
const WC_TOKEN = WC_CK.token;
const COOKIE_STR = (WC_CK.cookies||[]).filter(c=>c.value!=='EXPIRED').map(c=>c.name+'='+c.value).join('; ');

const SLEEP_MS = 1500; // delay between searches
const RATE_LIMIT_SLEEP = 30000; // 30s on rate limit

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Search one account, return fakeid or null */
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
      if (ret === 200013) { // rate limit
        console.log(`   ⏳ 频控，等待 ${RATE_LIMIT_SLEEP/1000}s...`);
        await sleep(RATE_LIMIT_SLEEP);
        continue;
      }
      if (ret !== 0) {
        console.log(`   ❌ ret=${ret}: ${data.base_resp?.err_msg || ''}`);
        return null;
      }
      
      const list = data.list || [];
      // Find exact name match
      const match = list.find(a => a.nickname === name);
      if (match) return match.fakeid;
      
      // Fuzzy: first result if it starts with the search term
      if (list.length > 0 && list[0].nickname.startsWith(name)) {
        console.log(`   ⚠️  模糊匹配: "${list[0].nickname}" → ${list[0].fakeid}`);
        return list[0].fakeid;
      }
      
      console.log(`   ❌ 未找到精确匹配，结果: ${list.map(a=>a.nickname).join(', ') || '空'}`);
      return null;
    } catch (e) {
      console.log(`   ❌ 请求异常: ${e.message}`);
      return null;
    }
  }
  return null;
}

/** Update a cell value in Feishu sheet */
async function updateSheetValue(cell, value) {
  const range = `${SHEET_ID}!${cell}:${cell}`;
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values`;
  const body = { valueRange: { range, values: [[value]] } };
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${FB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  return data.code === 0;
}

async function main() {
  console.log('🔍  公众号 FakeId 修复工具');
  console.log('═'.repeat(50));
  
  // Read names from sheet rows 2-31
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${SHEET_ID}!A2:A31`;
  const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${FB_TOKEN}` } });
  const data = await resp.json();
  const names = (data.data?.valueRange?.values || []).map(v => v[0]).filter(Boolean);
  
  console.log(`读取 ${names.length} 个待搜索公众号`);
  console.log('');
  
  let success = 0;
  let fail = 0;
  
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const rowNum = i + 2; // Sheet row (2-indexed, skip header)
    console.log(`[${i+1}/${names.length}] ${name}`);
    
    const fakeid = await searchOne(name);
    
    if (fakeid) {
      // Update C column (FakeId)
      const ok = await updateSheetValue(`C${rowNum}`, fakeid);
      console.log(`   ✅ ${ok ? '已更新' : '飞书更新失败'} fakeid=${fakeid}`);
      if (ok) success++;
      else fail++;
    } else {
      console.log(`   ❌ 搜索失败`);
      fail++;
    }
    
    await sleep(SLEEP_MS);
  }
  
  console.log('\n' + '═'.repeat(50));
  console.log(`✅ 完成: ${success} 成功, ${fail} 失败`);
}

main().catch(e => { console.error('致命错误:', e.message); process.exit(1); });
