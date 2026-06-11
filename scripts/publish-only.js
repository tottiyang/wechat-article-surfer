/**
 * 仅飞书发布（AI 分析已手动完成）
 * 用法: node scripts/publish-only.js
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ANALYSIS_DIR = path.join(ROOT, '.data', 'analysis');
const REPORT_FILE = path.join(ANALYSIS_DIR, '2026-06-10-观点汇总.md');

async function main() {
  const content = readFileSync(REPORT_FILE, 'utf-8');
  console.log(`报告内容: ${content.length} 字符\n`);

  const { publishToWiki } = await import('./daily-workflow.js');
  const result = await publishToWiki(content);
  if (result) {
    const url = result.match(/https:\/\/[^\s_]+/)?.[0] || '无URL';
    console.log(`\n✅ 发布成功\n🔗 ${url}`);
  } else {
    console.log(`\n❌ 发布失败`);
  }
}

main().catch(e => { console.error('\n❌', e); process.exit(1); });
