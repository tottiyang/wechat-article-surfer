#!/usr/bin/env node
/**
 * 高效汇总所有文章
 * 1. 提取所有文章关键信息
 * 2. 按主题分类汇总
 * 3. 生成结构化报告
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

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
    const date = parts.slice(1, 4).join('-');
    const title = parts.slice(4).join('-');
    const content = readFileSync(join(ARTICLE_DIR, fname), 'utf-8');
    return { fname, bizName, date, title, content: content.slice(0, 500) }; // 只取前500字符作为摘要
  }).filter(a => a.date === TARGET_DATE);
}

// 生成汇总报告
function generateSummaryReport(articles) {
  const sections = [];
  
  // 1. 文章清单
  sections.push(`## 文章清单\n\n共 ${articles.length} 篇文章：\n\n`);
  articles.forEach((a, i) => {
    sections.push(`${i + 1}. **${a.bizName}** - ${a.title}`);
  });
  
  // 2. 按公众号分类
  sections.push(`\n\n---\n\n## 按公众号分类\n`);
  const byBiz = {};
  articles.forEach(a => {
    if (!byBiz[a.bizName]) byBiz[a.bizName] = [];
    byBiz[a.bizName].push(a);
  });
  
  Object.entries(byBiz).forEach(([biz, list]) => {
    sections.push(`\n### ${biz}\n`);
    list.forEach(a => {
      sections.push(`- ${a.title}`);
    });
  });
  
  // 3. 内容摘要（前200字符）
  sections.push(`\n\n---\n\n## 内容摘要\n`);
  articles.forEach((a, i) => {
    sections.push(`\n### ${i + 1}. ${a.bizName} - ${a.title}\n`);
    sections.push(a.content.slice(0, 200) + '...');
  });
  
  return sections.join('\n');
}

// 生成AI分析提示词（优化版 - 深度提取个股和板块信息）
function generateAnalysisPrompt(articles) {
  // 提取所有文章标题和摘要（增加内容长度以保留更多细节）
  const articleSummaries = articles.map((a, i) => {
    // 保留更多内容细节，特别是股票代码、板块名称、具体数据
    const contentPreview = a.content.slice(0, 800); // 增加到800字符
    return `${i + 1}. ${a.bizName} - ${a.title}\n   内容摘要: ${contentPreview}...`;
  }).join('\n\n');
  
  return `你是一位专业的财经文章深度分析师，擅长从财经公众号文章中提取具体的投资标的、板块产业链、操作策略和关键数据。

## 任务
对以下${articles.length}篇财经文章进行深度分析和汇总，生成一份结构化的投资观点汇总报告。

## 文章列表

${articleSummaries}

## 分析要求（严格按以下6个部分输出，禁止省略）

### 一、个股与板块深度提炼
**这是最重要的部分，必须详细提取。**

对于每篇文章，必须提取：
1. **具体股票名称和代码**：如"泰和XC"、"圣泉JT"、"亨通GD"等，必须保留原始简称
2. **板块产业链位置**：如"PCB上游的上游的上游 - 电子布材料 - 芳纶龙头"、"光纤预制棒"、"覆铜板"、"MLCC镍粉"等
3. **涨价/业绩数据**：具体金额、百分比、时间节点
4. **供需关系**：产能缺口百分比、扩产周期、订单情况
5. **核心逻辑**：为什么看好，具体催化剂

**输出格式（每篇文章独立输出）**：
| 公众号 | 文章标题 | 具体标的 | 板块/产业链位置 | 核心逻辑 | 关键数据 | 作者观点 |
|--------|----------|----------|----------------|----------|----------|----------|

### 二、大盘判断汇总
- 汇总所有文章对大盘的判断（上涨/下跌/震荡/筑底/止跌）
- 列出判断依据和关键数据
- 标注观点来源（公众号名）

### 三、核心观点分类
- 市场趋势判断（保留原文关键措辞）
- 行业分析观点（具体到细分环节）
- 个股推荐/看空观点（含具体标的）
- 操作策略建议（具体到买入/卖出/持有条件）
- 风险警示（具体风险因素）

### 四、操作建议汇总
- 明确的买入建议（含具体标的和条件）
- 明确的卖出建议（含条件）
- 持有/观望建议
- 套利/波段操作建议（含具体手法）

### 五、风险提示汇总
- 市场风险
- 个股风险（具体到标的）
- 行业风险（具体到细分环节）
- 宏观风险

### 六、共识与分歧
- 多篇文章共同认可的观点（共识）
- 观点不一致的地方（分歧）
- 需要进一步验证的假设

## 输出原则

1. **具体性优先**：必须提取具体股票名称、代码、板块名称、数据，禁止抽象概括
2. **保留原文措辞**：关键观点必须保留原文措辞，如"芳纶CTE较低，相比于玻纤布有更好的性能，是高端电子布的首选材料"
3. **产业链深度**：必须梳理清楚产业链上下游关系，如"PPE树脂 → 覆铜板 → PCB → 电子布 → 芳纶"
4. **数据完整性**：所有百分比、金额、时间节点必须保留
5. **观点来源**：每个观点必须标注来源公众号
6. **禁止省略**：6个部分必须全部输出，禁止用"详见上文"等省略
7. **禁止抽象**：禁止用"科技板块"、"AI概念"等抽象词汇，必须用"光纤预制棒"、"MLCC镍粉"等具体词汇

## 注意事项
- 只提取原文明确表达的观点，不要过度推断
- 无明确观点的文章标注"无明确观点"
- 禁止输出"分析摘要"、"共性结论"等额外内容
- 按要求的6个部分输出，不要遗漏
- 每个部分必须包含具体内容，禁止一句话概括
- 表格必须包含表头
`;
`;

## 文章列表

${articleSummaries}

## 分析要求

请生成一份结构化的投资观点汇总报告，包含以下部分：

### 一、大盘判断汇总
- 汇总所有文章对大盘的判断（上涨/下跌/震荡/筑底/止跌）
- 列出判断依据和关键数据
- 标注观点来源（公众号名）

### 二、重点提及标的
- 汇总所有文章提及的股票、板块、基金、概念
- 按看多/看空/中性分类
- 列出具体论据和数据
- 标注观点来源

### 三、核心观点分类
- 市场趋势判断
- 行业分析观点
- 个股推荐/看空观点
- 操作策略建议
- 风险警示

### 四、操作建议汇总
- 明确的买入建议（含条件）
- 明确的卖出建议（含条件）
- 持有/观望建议
- 套利/波段操作建议

### 五、风险提示汇总
- 市场风险
- 个股风险
- 行业风险
- 宏观风险

### 六、共识与分歧
- 多篇文章共同认可的观点（共识）
- 观点不一致的地方（分歧）
- 需要进一步验证的假设

## 输出格式

请使用Markdown格式，包含表格和列表。
每个观点必须标注来源公众号。
数据必须准确，不要编造。

## 注意事项
- 只提取原文明确表达的观点，不要过度推断
- 保留原文关键措辞
- 无明确观点的文章标注"无明确观点"
- 禁止输出"分析摘要"、"共性结论"等额外内容
`;
}

// 主函数
async function main() {
  const articles = getAllArticles();
  console.log(`📊 共 ${articles.length} 篇文章`);

  if (!existsSync(ANALYSIS_DIR)) mkdirSync(ANALYSIS_DIR, { recursive: true });

  // 生成汇总报告（文章清单）
  const summaryReport = generateSummaryReport(articles);
  const summaryPath = join(ANALYSIS_DIR, `${TARGET_DATE}-文章清单.md`);
  writeFileSync(summaryPath, summaryReport, 'utf-8');
  console.log(`✅ 文章清单已保存: ${summaryPath}`);

  // 生成AI分析提示词
  const analysisPrompt = generateAnalysisPrompt(articles);
  const promptPath = join(ANALYSIS_DIR, `${TARGET_DATE}-分析提示词.txt`);
  writeFileSync(promptPath, analysisPrompt, 'utf-8');
  console.log(`✅ 分析提示词已保存: ${promptPath}`);
  console.log(`📄 提示词长度: ${analysisPrompt.length} 字符`);

  console.log(`\n💡 下一步：`);
  console.log(`1. 使用子Agent分析: 读取 ${promptPath} 并调用AI分析`);
  console.log(`2. 将结果保存到: ${ANALYSIS_DIR}/${TARGET_DATE}-AI分析结果.md`);
  console.log(`3. 发布到飞书Wiki`);
}

main().catch(console.error);
