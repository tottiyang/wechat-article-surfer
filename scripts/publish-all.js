/**
 * Phase 1b + 2 + 3 — 对已下载的 2026-06-10 文章执行：
 *   IMA 上传 → AI 分析 → 飞书 Wiki 发布
 * 
 * 用法: node scripts/publish-all.js
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTICLE_DIR = path.join(ROOT, '.data', 'articles');
const TARGET_DATE = '2026-06-10';

// Sanitize function (must match daily-workflow.js)
const sanitize = s => s.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
const imaName = (biz, title) => `${sanitize(biz)}-${TARGET_DATE}-${sanitize(title)}.md`;

function parseFilename(fname) {
  if (!fname.endsWith('.md')) return null;
  // Format: bizName-DATE-title.md  (e.g. "投资明见-2026-06-10-徐小明：周四操作策略(0611).md")
  const prefix = fname.slice(0, -3); // remove .md
  const dateMarker = `-${TARGET_DATE}-`;
  const idx = prefix.indexOf(dateMarker);
  if (idx === -1) return null;
  const bizName = prefix.slice(0, idx);
  const title = prefix.slice(idx + dateMarker.length);
  return { bizName, title, fname };
}

async function main() {
  console.log('=== 后续流程开始 ===\n');
  
  // Build downloaded list from files on disk
  const files = readdirSync(ARTICLE_DIR).filter(f => f.includes(TARGET_DATE));
  const downloaded = [];
  for (const f of files) {
    const parsed = parseFilename(f);
    if (!parsed) { console.log(`  ⚠️ 跳过: ${f} (无法解析)`); continue; }
    downloaded.push({
      filePath: path.join(ARTICLE_DIR, f),
      bizName: parsed.bizName,
      title: parsed.title,
      imaName: imaName(parsed.bizName, parsed.title),
      url: ''
    });
  }
  console.log(`共 ${downloaded.length} 篇文章待处理\n`);

  const { analyzeArticles, publishToWiki } = await import('./daily-workflow.js');

  // Phase 1b: IMA Upload
  console.log('📤  Phase 1b: IMA 上传');
  let ok = 0, fail = 0;
  for (const f of downloaded) {
    process.stdout.write(`  ↑ ${f.imaName}...`);
    try {
      const { execSync } = await import('child_process');
      const imaUploader = path.join(ROOT, 'scripts/ima-upload.cjs');
      execSync(`node "${imaUploader}" "${f.filePath}" "${f.imaName}"`, {
        encoding: 'utf-8', timeout: 120000
      });
      console.log(` ✅`);
      ok++;
    } catch (e) {
      console.log(` ❌ ${e.stderr?.substring(0, 120) || e.message}`);
      fail++;
    }
  }
  console.log(`  ✅ ${ok} 成功 | ❌ ${fail} 失败\n`);

  // Phase 2: AI Analysis
  console.log('🧠  Phase 2: AI 分析');
  console.log('  这将需要几分钟时间...');
  const analysis = await analyzeArticles(downloaded);
  if (analysis) {
    console.log(`  ✅ 分析完成\n`);
  } else {
    console.log(`  ⚠️ 无分析结果，跳过飞书发布\n`);
    return;
  }

  // Phase 3: Feishu Wiki publish
  console.log('📰  Phase 3: 飞书 Wiki 发布');
  const result = await publishToWiki(analysis.content);
  if (result) {
    const url = result.match(/https:\/\/[^\s]+/)?.[0] || '无URL';
    console.log(`  ✅ 发布成功`);
    console.log(`  🔗 ${url}`);
  } else {
    console.log(`  ❌ 发布失败`);
  }

  console.log('\n=== 全部完成 ===');
}

main().catch(e => { console.error('\n❌', e); process.exit(1); });
