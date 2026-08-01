#!/usr/bin/env node
/**
 * verify-unrecommended.js
 * 
 * 1. 将暂不推荐账号的分类标记为"不推荐"
 * 2. 逐个拉取最新文章进行判别
 * 3. 评价结果写入新列
 * 
 * 用法: node scripts/verify-unrecommended.js [--mark-only] [--start N]
 *   --mark-only: 仅标记分类，不拉文章验证
 *   --start N: 从第N个不推荐开始（用于断点续跑）
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ========== Config ==========
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
const ST = CONFIG.feishu.sheet_token;
const SID = CONFIG.feishu.sheet_id;
const TOKEN_FILE = CONFIG.feishu.token_file.replace(/^~/, process.env.HOME || '');
const WC = JSON.parse(readFileSync(join(ROOT, '.data', 'wechat-cookies.json'), 'utf-8'));
const WC_TOKEN = WC.token;
const WC_COOKIE = (WC.cookies||[]).filter(c=>c.value!=='EXPIRED').map(c=>c.name+'='+c.value).join('; ');

const ARGS = process.argv.slice(2);
const MARK_ONLY = ARGS.includes('--mark-only');
const START_AT = parseInt(ARGS.find(a => a.startsWith('--start='))?.split('=')[1] || '0', 10);

// ========== 评估结果数据 ==========
// 从之前两次评估综合得出的"不推荐"名单（名称精确匹配飞书表）
const NOT_RECOMMENDED = [
  // === Run1 中评分为不推荐（评分低或非投资类）===
  "火鸟台风","高工锂电","亿万鑫","零零之间","击球区小能手",
  "机器人前瞻","半导体综研","小明聊投","先知突发","驱动逻辑",
  "晚点LatePost","AI算力局","冷眼局中人","走进北交所","华为计算",
  "幻方量化","星图测控","胖米球","东昌路打工人","爱讲道理的斌叔",
  "调研纪要miracle","智东西","梅森投研","爱在冰川","星辰大海的边界",
  "超短龙补切","Unstoppable复盘与思考","线缆行业朋友分享圈",
  "商业航天ER","智元AGIBOT","万种心法","慢慢游资路","沪上十三少",
  "Lee话","北研君的小小号","节点空节点","商业航天Online","ymi0418",
  "擒龙正威","双子窥天","腾讯云","叙事平权old","柚子小杰杰",
  "调研鹏",  // 无FakeId
  
  // === Run2(签名)中不推荐 ===
  "古北路烧烤哥","沪上十三","洞见终局","羽绒金网","邢者团队午评",
  "川说60秒","震岳1994","划重点keypoints","发酵之翼","丨发酵之前丨",
  "小熊跑得快","增的逻辑","180K","盘前纪要","盘前早咖",
  "源深路炒家","这股有毒","粲然一笑2021","全网小作文",
  "爱在冰川同学","我思故我在日记","渣A情报处","JOKER皇杂谈",
  "财闻私享","韭研公社","乐晴智库精选","悟道的可","盘面说",
  "格隆","中国算力大会","十倍游资","道与术抓妖","小明的退路",
  "唐十诫的自留地","傅立叶的猫","橙子不糊涂","预期差寻找",
  "指北君-Beijiao","炒家信条抄底大师","计算机司令部","正昊蓝天",
  "守望核心","海里的小龙龙","捌个点","计算机的畅想","萌生般",
  "北哥生活","虹果皮","福禄娃爷爷","题材梳理社","总龙头战法",
  "新三板评论","逻辑研究社","老韭菜生存日记","林不再的选股思路",
  "逐鹿大北交","雪涛宏观笔记","震家军",
];

// ========== Feishu API ==========
let accessToken = '';
async function refreshToken() {
  const t = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  accessToken = t.access_token;
}
function feishuApi(method, endpoint, body = null) {
  const url = `https://open.feishu.cn/open-apis${endpoint}`;
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json());
}

// ========== Wechat API ==========
async function getArticleTitles(fakeid) {
  if (!fakeid || fakeid.length < 5) return null;
  const url = `https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_ex&begin=0&count=5&fakeid=${encodeURIComponent(fakeid)}&type=9&query=&token=${WC_TOKEN}&lang=zh_CN&f=json&ajax=1`;
  for (let retry = 0; retry < 5; retry++) {
    try {
      const r = await fetch(url, {
        headers: { 'Cookie': WC_COOKIE, 'Referer': 'https://mp.weixin.qq.com/' }
      });
      const d = JSON.parse(await r.text());
      const err = d.base_resp?.ret;
      if (err === 200013) { // freq control
        const wait = 30 + 5 * retry;
        console.log(`  ⏳ 频控，等待${wait}s...`);
        await sleep(wait * 1000);
        continue;
      }
      if (err === 200002) return { error: '参数无效', titles: [] }; // bad fakeid
      if (err !== 0) return { error: `API错误(${err})`, titles: [] };
      return { titles: (d.app_msg_list || []).map(a => a.title) };
    } catch(e) { return { error: `网络错误: ${e.message}`, titles: [] }; }
  }
  return { error: '频控重试耗尽', titles: [] };
}

function evaluateAccount(name, titles) {
  if (!titles || titles.length === 0) return { score: 0, category: 'none', valuable: false, reason: '无文章/API错误' };
  
  const investK = ['股','涨停','跌停','板块','大盘','A股','行情','涨幅','回调','布局','上车','主线','低位','估值','牛','熊','上涨','下跌','套利','短线','长线','趋势','龙头','北向','资金','成交量','突破','支撑','压力','操作','策略','复盘','早盘','午盘','收评','赚钱','亏钱','做T','加仓','减仓','调研','标的','关注','看多','看空'];
  const marketK = ['市场','震荡','放量','缩量','周期','轮动','切换','分歧','一致','超跌','反弹','补涨','高低切'];
  
  const txt = titles.join(' ');
  let score = 0;
  for (const k of investK) if (txt.includes(k)) score += 2;
  for (const k of marketK) if (txt.includes(k)) score += 1;
  const hasR = titles.some(t => /复盘|策略|操作|观点|分析|研报|调研/.test(t));
  const hasStock = titles.some(t => /\d{6}/.test(t));  // has stock code
  
  let cat = '其他';
  if (score >= 8) cat = '⭐投资分析';
  else if (score >= 4) cat = '行业研究';
  else if (score >= 2) cat = '财经资讯';
  else cat = '无关';
  
  let valuable = false, reason = '';
  if (score >= 10 && hasR) { valuable = true; reason = `高质量投资分析(${score}分)有复盘`; }
  else if (score >= 8) { valuable = true; reason = `投资信息丰富(${score}分)`; }
  else if (score >= 6 && hasStock) { valuable = true; reason = `有明确标的(${score}分)`; }
  else if (score >= 4 && titles.length >= 2) { valuable = true; reason = `有投资参考(${score}分)`; }
  else { valuable = false; reason = `信号弱(${score}分)${titles.length > 0 ? ' 标题示例: '+titles[0].substring(0,30) : ''}`; }
  
  return { score, category: cat, valuable, reason, sampleTitle: titles[0]?.substring(0, 40) };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========== Log file for resume ==========
const STATE_FILE = '/tmp/verify_unc_state.json';
function saveState(data) {
  writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); }
  catch { return null; }
}

// ========== Main ==========
async function main() {
  await refreshToken();
  console.log(`📋 不推荐账号验证脚本`);
  console.log(`   模式: ${MARK_ONLY ? '仅标记分类' : '完整验证'}`);
  console.log(`   起始偏移: ${START_AT}`);
  
  // Step 0: 读取飞书表格
  console.log('\n📖 读取飞书表格...');
  const meta = await feishuApi('GET', `/sheets/v2/spreadsheets/${ST}/metainfo`);
  const sheetList = meta.data?.sheets || [];
  console.log(`   找到 ${sheetList.length} 个子表`);
  
  const dataResp = await feishuApi('GET', `/sheets/v2/spreadsheets/${ST}/values/${SID}!A1:H203`);
  const rows = dataResp.data?.valueRange?.values || [];
  console.log(`   读取 ${rows.length} 行`);
  
  if (rows.length < 2) { console.log('❌ 表格为空'); return; }
  
  // Step 1: 建立名称→行号映射
  const nameToRow = {};
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][0] || '').trim();
    if (name) nameToRow[name] = i;
  }
  console.log(`   可识别账号数: ${Object.keys(nameToRow).length}`);
  
  // Step 2: 找出需要标记的不推荐账号及其行
  const toMark = [];
  for (const name of NOT_RECOMMENDED) {
    const row = nameToRow[name];
    if (!row) {
      console.log(`  ⚠️ 未找到: "${name}"`);
      continue;
    }
    // 跳过已标记的
    const currentF = rows[row][5] || '';
    if (currentF === '不推荐' && !MARK_ONLY) {
      // 已标记，跳过
      continue;
    }
    // 跳过"重点"（如果之前评估错了，保留重点）
    if (currentF === '重点') {
      console.log(`  ⚠️ "${name}" 之前标记为重点，跳过覆盖`);
      continue;
    }
    toMark.push({ name, row, fakeid: rows[row][2] || '' });
  }
  console.log(`\n🎯 需要标记的不推荐账号: ${toMark.length} 个`);
  
  // Step 3: 标记分类
  console.log('\n🏷️  标记分类为「不推荐」...');
  // batch update (feishu sheets supports batch range updates)
  const BATCH_SIZE = 20;
  let marked = 0;
  for (let i = 0; i < toMark.length; i += BATCH_SIZE) {
    const batch = toMark.slice(i, i + BATCH_SIZE);
    // Build update data: each cell = (row, col_F, value)
    const valueCells = batch.map(a => ({
      row: a.row,
      col: 6, // F column (1-indexed: 6=F)
      value: '不推荐'
    }));
    await refreshToken();
    const updateResp = await feishuApi('PUT', `/sheets/v2/spreadsheets/${ST}/values`, {
      valueRange: {
        range: `${SID}!F${batch[0].row}:F${batch[batch.length-1].row}`,
        values: batch.map(() => ['不推荐'])
      }
    });
    if (updateResp.code !== 0) {
      console.log(`  ❌ 批量更新失败: ${JSON.stringify(updateResp)}`);
    } else {
      marked += batch.length;
      console.log(`  ✅ 已标记 ${marked}/${toMark.length}`);
    }
    await sleep(500);
  }
  console.log(`\n✅ 分类标记完成: ${marked} 个设为「不推荐」`);
  
  if (MARK_ONLY) {
    console.log('\n--mark-only 模式，结束。');
    console.log(`  未拉取验证的账号: ${toMark.length - marked} 个`);
    return;
  }
  
  // Step 4: 逐个拉取文章验证
  // Sort: accounts with fakeid first (no fakeid skip)
  const toVerify = toMark.filter(a => a.fakeid && a.fakeid.length >= 5);
  console.log(`\n🔍 开始逐个验证 (${toVerify.length} 个有FakeId)...`);
  
  // Load resume state if exists
  let state = loadState();
  let startIdx = state ? state.processed : START_AT;
  if (state) {
    console.log(`   断点续跑: 已处理 ${state.processed} 个`);
  }
  
  for (let i = startIdx; i < toVerify.length; i++) {
    const acct = toVerify[i];
    process.stdout.write(`[${i+1}/${toVerify.length}] ${acct.name.substring(0,16).padEnd(16)}...`);
    
    // Pull articles
    const result = await getArticleTitles(acct.fakeid);
    const titles = result.titles || [];
    
    if (result.error) {
      console.log(` ❌ ${result.error}`);
      const evalNote = `API验证失败: ${result.error}`;
      await updateCell(acct.row, 7, evalNote);
      await sleep(1500);
      saveState({ processed: i + 1, lastName: acct.name, timestamp: new Date().toISOString() });
      continue;
    }
    
    // Evaluate
    const evalResult = evaluateAccount(acct.name, titles);
    const icon = evalResult.valuable ? '✅' : '⏹️';
    
    // Build note
    let note = `文章评估: ${evalResult.category}(${evalResult.score}分)`;
    if (!evalResult.valuable) note += ` | ${evalResult.reason}`;
    else note += ` | 有价值: ${evalResult.reason}`;
    if (evalResult.sampleTitle) note += ` | 例: ${evalResult.sampleTitle}`;
    
    console.log(` ${icon} ${evalResult.category}(${evalResult.score}分) ${evalResult.valuable ? '✨价值确认!' : '确认为不推荐'}`);
    
    // Update sheet
    await updateCell(acct.row, 7, note);
    saveState({ processed: i + 1, lastName: acct.name, timestamp: new Date().toISOString() });
    
    // Be gentle with rate limits: 1.5s between calls
    await sleep(1500);
  }
  
  console.log(`\n✅ 验证完成!`);
  console.log(`   已验证: ${Math.min(toVerify.length, startIdx + toVerify.length)} 个`);
  
  // Summary
  const remaining = toVerify.length - (state?.processed || 0);
  if (remaining > 0) console.log(`   剩余: ${remaining} 个（可在下次运行）`);
}

async function updateCell(row, col, value) {
  await refreshToken();
  const colLetter = String.fromCharCode(64+col);
  await feishuApi('PUT', `/sheets/v2/spreadsheets/${ST}/values`, {
    valueRange: {
      range: `${SID}!${colLetter}${row}:${colLetter}${row}`,
      values: [[value]]
    }
  });
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
