#!/usr/bin/env node
/**
 * verify-only.js v2 - 逐篇拉取验证
 * 
 * 策略: 遇频控跳过，记入重试队列。一轮跑完后再统一重试。
 * 状态保持: /tmp/verify_state.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
const ST = CONFIG.feishu.sheet_token;
const SID = CONFIG.feishu.sheet_id;
const TOKEN_FILE = CONFIG.feishu.token_file.replace(/^~/, process.env.HOME || '');
const WC = JSON.parse(readFileSync(join(ROOT, '.data', 'wechat-cookies.json'), 'utf-8'));
const WC_TOKEN = WC.token;
const WC_COOKIE = (WC.cookies||[]).filter(c=>c.value!=='EXPIRED').map(c=>c.name+'='+c.value).join('; ');

const STATE_FILE = '/tmp/verify_state.json';

let accessToken = '';
async function refreshToken() {
  const t = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  accessToken = t.access_token;
}
async function feishu(method, endpoint, body = null) {
  const r = await fetch(`https://open.feishu.cn/open-apis${endpoint}`, {
    method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
async function writeCell(row, col, value) {
  await refreshToken();
  const cl = String.fromCharCode(64 + col);
  await feishu('PUT', `/sheets/v2/spreadsheets/${ST}/values`, {
    valueRange: { range: `${SID}!${cl}${row}:${cl}${row}`, values: [[value]] }
  });
}

async function getArticleTitles(fakeid) {
  if (!fakeid || fakeid.length < 5) return null;
  const url = `https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_ex&begin=0&count=5&fakeid=${encodeURIComponent(fakeid)}&type=9&query=&token=${WC_TOKEN}&lang=zh_CN&f=json&ajax=1`;
  try {
    const r = await fetch(url, {
      headers: { 'Cookie': WC_COOKIE, 'Referer': 'https://mp.weixin.qq.com/' }
    });
    const d = JSON.parse(await r.text());
    const err = d.base_resp?.ret;
    if (err === 200013) return { retry: true, titles: [], error: '频控' };
    if (err === 200002) return { titles: [], error: '参数无效(fakeid)' };
    if (err !== 0) return { titles: [], error: `API错误(${err})` };
    return { titles: (d.app_msg_list || []).map(a => a.title) };
  } catch(e) { return { titles: [], error: `网络错误: ${e.message}` }; }
}

function evaluate(name, titles) {
  if (!titles || titles.length === 0) return { score: 0, cat: 'none', note: '❌ 无文章' };
  const investK = ['股','涨停','跌停','板块','大盘','A股','行情','涨幅','回调','布局','上车','主线','低位','估值','牛','熊','上涨','下跌','套利','短线','长线','趋势','龙头','北向','资金','成交量','突破','支撑','压力','操作','策略','复盘','早盘','午盘','收评','赚钱','亏钱','做T','加仓','减仓','调研','标的','关注','看多','看空','标的','仓位'];
  const txt = titles.join(' ');
  let score = 0;
  for (const k of investK) if (txt.includes(k)) score += 2;
  const hasR = titles.some(t => /复盘|策略|操作|观点|分析|研报|调研/.test(t));
  const hasCode = titles.some(t => /\b\d{6}\b/.test(t));

  let cat = '其他', note = '';
  if (score >= 12 && hasR) { cat = '⭐投资分析'; note = `高质量投资建议(${score}分)有复盘`; }
  else if (score >= 8) { cat = '投资相关'; note = `投资信息丰富(${score}分)`; }
  else if (score >= 4 && (hasR || hasCode)) { cat = '财经投资'; note = `有一定投资参考(${score}分)`; }
  else if (score >= 2) { cat = '财经资讯'; note = `投资信号弱(${score}分)`; }
  else { cat = '无关'; note = `无关内容(${score}分)`; }
  
  if (titles.length > 0) note += ` | 例: ${titles[0].substring(0,36)}`;
  return { score, cat, note: `${cat}(${score}分) ${note}` };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await refreshToken();
  console.log(`🔍 不推荐账号验证 (遇频控跳过，最后统一重试)`);
  console.log(`   时间: ${new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})}`);

  // Read sheet
  const d = await feishu('GET', `/sheets/v2/spreadsheets/${ST}/values/${SID}!A1:G203`);
  const rows = d.data?.valueRange?.values || [];
  if (rows.length < 2) { console.log('❌ 空表'); return; }

  // Find accounts with F=不推荐 and G=空
  const toVerify = [];
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][0] || '').trim();
    const fVal = (rows[i][5] || '').trim();
    const gVal = (rows[i][6] || '').trim();
    const fakeid = (rows[i][2] || '').trim();
    if (!name) continue;
    if (fVal === '不推荐' && !gVal && fakeid.length >= 5) {
      toVerify.push({ row: i + 1, name, fakeid });
    }
  }
  console.log(`待验证: ${toVerify.length} 个`);

  let success = 0, skip = 0;
  let retryQueue = [];
  let retryCount = 0;

  // Two rounds: fast pass first, then retry rate-limited ones
  for (let round = 1; round <= 3; round++) {
    const batch = round === 1 ? toVerify : retryQueue;
    if (batch.length === 0) { console.log(`  轮次${round}: 无待处理\n`); break; }

    console.log(`\n=== 轮次 ${round} ===`);
    console.log(`待处理: ${batch.length} 个`);
    retryQueue = [];
    retryCount = 0;

    for (let i = 0; i < batch.length; i++) {
      const acct = batch[i];
      process.stdout.write(`[${i+1}/${batch.length}] ${acct.name.substring(0,16).padEnd(16)}...`);

      const result = await getArticleTitles(acct.fakeid);

      if (result.retry) {
        console.log(` 🔴 频控 -> 加入重试队列`);
        retryQueue.push(acct);
        retryCount++;
        // Don't waste time waiting
        await sleep(100);
        continue;
      }

      if (result.error) {
        const note = `❌ ${result.error}`;
        console.log(note);
        await writeCell(acct.row, 7, note);
        await sleep(500);
        continue;
      }

      const ev = evaluate(acct.name, result.titles);
      console.log(` ${ev.cat}(${ev.score}分)`);
      await writeCell(acct.row, 7, ev.note.substring(0, 180));
      success++;

      saveState({ processed: success, last: acct.name, r: round, t: new Date().toISOString() });

      // 1.5-2s cooldown
      await sleep(1500 + Math.random() * 500);
    }

    if (retryQueue.length > 0 && round < 3) {
      console.log(`\n⏳ 重试队列 ${retryQueue.length} 个，等待 10 分钟让频控窗口重置...`);
      await sleep(600 * 1000); // 10 minutes
      retryCount = 0;
    }
  }

  console.log(`\n✅ 完成`);
  console.log(`   成功: ${success}`);
  if (retryQueue.length > 0) {
    console.log(`   ⚠️ 仍有 ${retryQueue.length} 个频控未解封:`);
    retryQueue.forEach(a => console.log(`      ${a.name}`));
  }
}

function saveState(data) {
  writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
