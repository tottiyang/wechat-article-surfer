#!/usr/bin/env node
/**
 * 批量分析所有文章并汇总到飞书Wiki
 * 分批处理：每批3篇，避免超时
 * 使用子Agent方式调用AI分析
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ARTICLE_DIR = '.data/articles';
const ANALYSIS_DIR = '.data/analysis';
const TARGET_DATE = '2026-06-09';

// 获取所有文章
function getAllArticles() {
  const files = readdirSync(ARTICLE_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();
  
  return files.map(fname => {
    const parts = fname.replace('.md', '').split('-');
    const bizName = parts[0];
    const date = parts.slice(1, 4).join('-'); // YYYY-MM-DD
    const title = parts.slice(4).join('-');
    const content = readFileSync(join(ARTICLE_DIR, fname), 'utf-8');
    return { fname, bizName, date, title, content };
  }).filter(a => a.date === TARGET_DATE);
}

// 构建提示词
function buildPrompt(batch) {
  const articlesText = batch.map((a, i) => `
文章${i + 1}：${a.bizName} - ${a.title}
内容：
${a.content}
`).join('\n---\n');

  return `分析以下${batch.length}篇财经文章，提取所有有价值的投资信息。

${articlesText}

要求：
1. 核心观点：逐篇提取，不遗漏。每篇文章至少提取5个核心观点（如果内容足够）
2. 提及标的：股票代码、板块、基金、概念。必须附具体论据
3. 论据数据：支撑观点的具体数据、事实、百分比、金额
4. 大盘判断：对市场走势的判断
5. 操作建议：明确的买入/卖出/持有/等待建议
6. 风险提示：提到的风险因素

重要原则：
- 按公众号分组，每篇文章独立分析
- 不合并相似观点，不省略任何信息
- 禁止一句话概括，必须展开具体论据
- 保留原文措辞，不做概括性改写
- 无明确投资观点的文章标注"无投资观点"
- 禁止输出摘要、共性结论、分析总结等额外内容
- 每篇文章必须包含：核心观点（至少5条）、提及标的（表格）、大盘判断、操作建议、风险提示
- 表格必须包含表头

格式：
## {公众号名} - {文章标题}
### 核心观点
- [具体观点1，保留原文关键措辞]
- [具体观点2，保留原文关键措辞]
...

### 提及标的
| 标的 | 作者观点 | 具体论据 |
|------|----------|----------|
| [标的1] | [观点] | [论据] |
...

### 大盘判断
- [判断及依据]

### 操作建议
- [建议及条件]

### 风险提示
- [风险因素]

---

注意：
- 只输出上述格式的内容，不要输出"分析摘要"、"共性结论"、"总结"等
- 每篇文章必须完整输出所有5个部分
- 表格必须包含表头
- 禁止省略任何信息`;
}

// 保存批次提示词到文件
function saveBatchPrompt(batch, batchNum) {
  const prompt = buildPrompt(batch);
  const promptFile = join(ANALYSIS_DIR, `batch-${batchNum}-prompt.txt`);
  writeFileSync(promptFile, prompt, 'utf-8');
  return promptFile;
}

// 主函数
async function main() {
  const articles = getAllArticles();
  console.log(`📊 共 ${articles.length} 篇文章待分析`);

  const BATCH_SIZE = 3;
  const batches = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    batches.push(articles.slice(i, i + BATCH_SIZE));
  }
  console.log(`📦 分 ${batches.length} 批处理`);

  // 创建分析目录
  if (!existsSync(ANALYSIS_DIR)) mkdirSync(ANALYSIS_DIR, { recursive: true });

  // 保存每批的提示词文件
  const promptFiles = [];
  for (let b = 0; b < batches.length; b++) {
    const promptFile = saveBatchPrompt(batches[b], b + 1);
    promptFiles.push(promptFile);
    console.log(`  💾 批次 ${b + 1} 提示词已保存: ${promptFile}`);
  }

  // 生成汇总脚本
  const summaryScript = generateSummaryScript(promptFiles, articles.length);
  const scriptPath = join(ANALYSIS_DIR, 'run-analysis.sh');
  writeFileSync(scriptPath, summaryScript, 'utf-8');
  
  console.log(`\n✅ 准备完成！`);
  console.log(`\n📋 执行步骤：`);
  console.log(`1. 逐批调用子Agent分析（共 ${batches.length} 批）`);
  console.log(`2. 收集所有结果到 ${ANALYSIS_DIR}`);
  console.log(`3. 汇总并发布到飞书Wiki`);
  console.log(`\n💡 提示词文件保存在: ${ANALYSIS_DIR}/batch-*-prompt.txt`);
  console.log(`💡 执行脚本: ${scriptPath}`);
}

function generateSummaryScript(promptFiles, totalArticles) {
  return `#!/bin/bash
# 批量分析执行脚本
# 共 ${promptFiles.length} 批，${totalArticles} 篇文章

ANALYSIS_DIR=".data/analysis"
TARGET_DATE="2026-06-09"

# 逐批分析
${promptFiles.map((f, i) => `
echo "🔄 分析批次 ${i + 1}/${promptFiles.length}..."
# 使用子Agent分析
# openclaw infer model run --model "qclaw/pool-deepseek-v4-flash" --prompt-file "${f}" --json > "${ANALYSIS_DIR}/batch-${i + 1}-result.json"
`).join('\n')}

echo "✅ 所有批次分析完成"
`;
}

main().catch(console.error);
