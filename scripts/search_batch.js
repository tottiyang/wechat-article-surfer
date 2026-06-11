import { proxyMpRequest } from "../src/proxy.js";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { token, cookies } = JSON.parse(readFileSync(join(ROOT, '.data', 'wechat-cookies.json'), "utf-8"));
const cookieStr = (cookies || [])
  .filter(c => c.value !== "EXPIRED")
  .map(c => `${c.name}=${c.value}`)
  .join("; ");

console.log("Token:", token, "| Cookie length:", cookieStr.length);

const names = [
  "奇点财讯社","中泰证券资管","小豆小瓜","三年一倍","价值事务所",
  "君临策","基民柠檬","骑行夜幕统计客","林奇","顽主杯实盘大赛",
  "孥孥的大树","猫笔刀","隔壁老投","先知研报","盘前纪要",
  "研讯社","一瓢之饮","集思录","林立涛","奶员外",
  "星辰投研","尽量完美","刘备教授","鲲鹏哥","九财花",
  "股市的逻辑","毛豆实盘","看多杯实盘大赛","哨兵ZH","彼岸花开生财有道",
  "暴躁老王点评","三味人间集","丹湖渔翁","养基之前","孜孜有知",
  "亨特研究笔记","古月大局观","新能源正前方","逢吉--FK","看盘日记",
  "发财老博士","芝士起源","芝sir","大作手燕十三","行走黑暗间"
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchOne(name) {
  await sleep(500); // rate limit
  try {
    const resp = await proxyMpRequest({
      method: "GET",  // ⚠️ 必须用 GET！POST 返回 200005
      endpoint: "https://mp.weixin.qq.com/cgi-bin/searchbiz",
      query: { action: "search_biz", begin: "0", count: "5", query: name, token, lang: "zh_CN", f: "json", ajax: "1" },
      cookie: cookieStr,
      parseJson: true,
    });
    if (resp.base_resp?.ret !== 0) {
      return { name, found: false, reason: `API错误: ${resp.base_resp?.err_msg}(ret=${resp.base_resp?.ret})` };
    }
    const list = resp.list || [];
    if (list.length === 0) return { name, found: false, reason: "无结果" };
    const exact = list.find(x => x.nickname === name);
    if (exact) return { name, found: true, fakeid: exact.fakeid, nickname: exact.nickname, alias: exact.alias || "" };
    return { name, found: false, reason: "无精确匹配", candidates: list.map(x => ({ nickname: x.nickname, fakeid: x.fakeid, alias: x.alias || "" })) };
  } catch (e) {
    return { name, found: false, reason: e.message };
  }
}

// Test first
console.log("\n--- 测试搜索第一条 ---");
const testResult = await searchOne(names[0]);
console.log(JSON.stringify(testResult, null, 2));

if (testResult.found) {
  // Batch (sequential to avoid rate limiting)
  const results = [];
  for (let i = 0; i < names.length; i++) {
    console.log(`[${i+1}/${names.length}] ${names[i]}...`);
    const r = await searchOne(names[i]);
    results.push(r);
    const icon = r.found ? '✅' : '❌';
    console.log(`  ${icon} ${r.found ? r.fakeid : (r.reason || '?')}`);
    if (r.candidates) r.candidates.forEach(c => console.log(`    → ${c.nickname} | ${c.fakeid}`));
  }

  const exacts = results.filter(r => r.found);
  const misses = results.filter(r => !r.found);
  console.log(`\n📊 汇总：精确匹配 ${exacts.length}个，未匹配 ${misses.length}个`);
  if (misses.length > 0) {
    console.log("\n❌ 未精确匹配：");
    misses.forEach(r => {
      console.log(`  ${r.name}: ${r.reason}`);
      if (r.candidates) r.candidates.forEach(c => console.log(`    → ${c.nickname} (${c.fakeid})`));
    });
  }
  writeFileSync("/tmp/search_results.json", JSON.stringify({ exacts, misses }, null, 2));
  console.log("\n结果已保存到 /tmp/search_results.json");
} else {
  console.log("\n❌ 测试失败，先排查问题");
}
