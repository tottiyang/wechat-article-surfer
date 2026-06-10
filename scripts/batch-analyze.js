#!/usr/bin/env node
/**
 * batch-analyze.js — 批量分析文章并写入飞书 Wiki
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ARTICLES_FILE = path.join(ROOT, '.data', 'workflow-cache', 'articles.json');
const ANALYSIS_DIR = path.join(ROOT, '.data', 'analysis');

const articles = JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf-8'));

// Batch size for subagent calls
const BATCH_SIZE = 3;

// Prompt template (固化提示词)
const ANALYSIS_PROMPT_TEMPLATE = `你是一个专业的财经文章分析助手。分析以下多篇财经文章的核心要点。

要求：
1. **核心观点**：逐篇提取，不要遗漏任何观点
2. **提及标的**：股票代码/板块/基金/概念，附作者观点（看多/看空/中性）
3. **大盘判断**：对市场走势的判断（上涨/下跌/震荡/筑底/止跌等）
4. **操作建议**：如有明确的买入/卖出/持有建议，提取出来
5. **只做提取不做评价**，不要添加原文没有的内容，不要自我发挥
6. 按公众号分组输出

输出格式（Markdown）：
## 核心观点
- [公众号] 观点...

## 提及标的
| 标的 | 来源 | 观点 | 原因 |

## 大盘判断
- ...

## 操作建议
- ...
`;

async function analyzeBatch(batch) {
  const prompt = [
    ANALYSIS_PROMPT_TEMPLATE,
    '',
    ...batch.flatMap(a => [
      '---',
      `## ${a.bizName}`,
      `### ${a.title}`,
      a.content,
      '',
    ]),
  ].join('\n');

  // Use subagent via sessions_spawn
  const { sessions_spawn } = require('../../../../../.openclaw/workspace/skills/skillhub-preference/SKILL.md');
  
  // For now, just save the prompt for manual processing
  return { batch, promptLength: prompt.length };
}

async function main() {
  console.log(`Analyzing ${articles.length} articles in batches of ${BATCH_SIZE}...`);
  
  const batches = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    batches.push(articles.slice(i, i + BATCH_SIZE));
  }
  
  console.log(`Total batches: ${batches.length}`);
  
  // Process each batch
  const results = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`\nBatch ${i + 1}/${batches.length}`);
    const batch = batches[i];
    const result = await analyzeBatch(batch);
    results.push(result);
  }
  
  console.log('\nDone!');
}

main().catch(console.error);
