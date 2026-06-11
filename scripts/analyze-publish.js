/**
 * 仅 AI 分析 + 飞书发布（IMA 上传已完成）
 * 用法: node scripts/analyze-publish.js
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTICLE_DIR = path.join(ROOT, '.data', 'articles');
const TARGET_DATE = '2026-06-10';

const sanitize = s => s.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
const imaName = (biz, title) => `${sanitize(biz)}-${TARGET_DATE}-${sanitize(title)}.md`;

function parseFilename(fname) {
  if (!fname.endsWith('.md')) return null;
  const prefix = fname.slice(0, -3);
  const dateMarker = `-${TARGET_DATE}-`;
  const idx = prefix.indexOf(dateMarker);
  if (idx === -1) return null;
  return {
    bizName: prefix.slice(0, idx),
    title: prefix.slice(idx + dateMarker.length),
    fname,
  };
}

async function main() {
  console.log('=== AI 分析 + 飞书发布 ===\n');

  const files = readdirSync(ARTICLE_DIR).filter(f => f.includes(TARGET_DATE));
  const downloaded = [];
  for (const f of files) {
    const parsed = parseFilename(f);
    if (!parsed) { console.log(`  ⚠️ 跳过: ${f}`); continue; }
    downloaded.push({
      filePath: path.join(ARTICLE_DIR, f),
      bizName: parsed.bizName,
      title: parsed.title,
      imaName: imaName(parsed.bizName, parsed.title),
      url: '',
    });
  }
  console.log(`${downloaded.length} 篇文章, IMA 已上传 ✅`);

  const { analyzeArticles, publishToWiki } = await import('./daily-workflow.js');

  // Phase 2: AI Analysis
  console.log('\n🧠 Phase 2: AI 分析（timeout 20min）');
  const analysis = await analyzeArticles(downloaded);
  if (!analysis) {
    console.log('⚠️ 分析失败或为空');
    return;
  }
  console.log('✅ 分析完成');

  // Phase 3: Feishu Wiki publish
  console.log('\n📰 Phase 3: 飞书 Wiki 发布');
  const result = await publishToWiki(analysis.content);
  if (result) {
    const url = result.match(/https:\/\/[^\s_]+/)?.[0] || '无URL';
    console.log(`✅ 发布成功\n🔗 ${url}`);
  } else {
    console.log('❌ 发布失败');
  }

  console.log('\n=== 全部完成 ===');
}

main().catch(e => { console.error('\n❌', e); process.exit(1); });
