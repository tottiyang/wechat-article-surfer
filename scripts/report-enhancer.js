/**
 * report-enhancer.js (ESM) — Phase 2c (LLM 模式分析) + Phase 2d (质量检查)
 *
 * 设计原则:
 * - 不丢数据：LLM 分析仅作为附加层追加，不替代任何内容
 * - 优雅降级：LLM 失败时不影响主报告
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ============================================================
// Phase 2c: LLM 共识/分歧分析
// ============================================================

/**
 * 对有效文章进行跨博主模式分析
 * @param {Array} valid — 有内容的文章对象数组
 * @returns {string} Markdown 区块，失败或不足3篇时返回空
 */
export async function consensusAnalysis(valid) {
  if (valid.length < 3) return '';

  const summary = {
    totalValid: valid.length,
    marketViews: valid.filter(a => a.marketView && a.marketView !== '无')
      .map(a => '[' + a.source + '] ' + a.marketView),
    topSectors: [...new Set(
      valid.flatMap(a => a.sectors.filter(s => s && s !== '无'))
    )],
    mentionedStocks: [...new Set(
      valid.flatMap(a => a.stocks)
    )].slice(0, 30),
    allRisks: valid.filter(a => a.risk && a.risk !== '无')
      .map(a => '[' + a.source + '] ' + a.risk),
    allStrategies: valid.filter(a => a.strategy && a.strategy !== '无')
      .map(a => '[' + a.source + '] ' + a.strategy),
    allFrameworks: valid.filter(a => a.framework && a.framework !== '无')
      .map(a => '[' + a.source + '] ' + a.framework),
    allSpecials: valid.filter(a => a.specialView && a.specialView !== '无')
      .map(a => '[' + a.source + '] ' + a.specialView),
  };

  const prompt = composeConsensusPrompt(summary);
  try {
    const result = await callLlm(prompt);
    const cleaned = result
      .replace(/^好的[，,].*\n/gi, '')
      .replace(/^以下是.*\n/gi, '')
      .replace(/^我来分析.*\n/gi, '')
      .trim();
    return cleaned.length >= 50 ? cleaned : '';
  } catch (e) {
    console.log('  \u274c LLM模式分析失败: ' + e.message);
    return '';
  }
}

function composeConsensusPrompt(summary) {
  return '你是一位专业的财经汇总分析师。以下是对今日'
    + summary.totalValid + '篇公众号文章的结构化分析摘要。\n\n'
    + JSON.stringify(summary, null, 2) + '\n\n'
    + '请分析以上内容，输出以下格式（无内容则写"无"）：\n\n'
    + '## \ud83d\udcca 模式分析\n\n'
    + '### 核心共识（支持来源\u22653个）\n'
    + '列出跨博主达成共识的观点，每条标注涉及哪些来源。没有写"无"。\n\n'
    + '### 主要分歧\n'
    + '列出博主之间观点不一致的地方。没有写"无"。\n\n'
    + '### 特色观点\n'
    + '列出仅1-2位博主提到的独特判断或反共识观点。没有写"无"。\n\n'
    + '### 风险共识\n'
    + '列出多位博主共同提示的风险点。没有写"无"。\n\n'
    + '## 规则\n'
    + '1. 不重复确定性聚合中已有的详细数据\n'
    + '2. 每条分析标注涉及哪些来源公众号\n'
    + '3. 简明扼要，每条30-100字\n'
    + '4. 用自然段落描述，不要表格\n'
    + '5. 不要添加"总结"或"综上所述"类结尾';
}

// ============================================================
// Phase 2d: 质量检查
// ============================================================

/**
 * 检查报告结构完整性，评分
 * @param {string} report — 完整报告 Markdown
 * @returns {number} 评分 (0-100)
 */
export function qualityCheck(report, validCount, totalArticles) {
  const checks = [
    { name: '大盘判断', required: true },
    { name: '热点板块', required: true },
    { name: '投资标的', required: true },
    { name: '操作策略', required: true },
    { name: '风险提示', required: true },
    { name: '原文清单', required: true },
    { name: '分析框架一览', required: false },
    { name: '特色/反共识观点', required: false },
    { name: '模式分析', required: false },
  ];

  const results = checks.map(c => {
    // 匹配任何包含章节名的标题行: ## 一、大盘判断 / ### 原文清单 / ## 📊 模式分析
    const found = new RegExp('#{2,3}\\s+[^\\n]*?' + escapeRegex(c.name)).test(report);
    if (c.required && !found) {
      console.log('  \u26a0\ufe0f 缺少必需章节: ' + c.name);
    }
    return { name: c.name, required: c.required, found };
  });

  // 文章覆盖率检查
  const coverage = totalArticles > 0 ? validCount / totalArticles : 0;
  if (coverage < 0.5) {
    console.log('  \u26a0\ufe0f 有效文章比例偏低: ' + validCount + '/' + totalArticles + ' (' + Math.round(coverage * 100) + '%)');
  }

  // 计算评分（仅基于必需章节）
  const requiredChecks = results.filter(r => r.required);
  const passes = requiredChecks.filter(r => r.found);
  const score = Math.round(passes.length / requiredChecks.length * 100);

  // 加分项（附加章节每项+5，最多+15）
  const extraSections = results.filter(r => !r.required && r.found).length;
  const bonus = Math.min(extraSections * 5, 15);
  const finalScore = Math.min(score + (score >= 85 ? bonus : 0), 100);

  const icon = finalScore >= 85 ? '\u2705 PASS' : '\u26a0\ufe0f FAIL (低于85)';
  console.log('\n\ud83d\udcca 质量评分: ' + finalScore + '/100 ' + icon);

  if (finalScore < 85) {
    const missing = requiredChecks.filter(r => !r.found).map(r => r.name);
    console.log('  缺失章节: ' + missing.join(', '));
  }

  return finalScore;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// LLM 调用（Kimi API — Anthropic 消息格式）
// ============================================================

function callLlm(prompt) {
  return new Promise((resolve, reject) => {
    let apiKey = process.env.KIMI_API_KEY;
    if (!apiKey) {
      try {
        const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf-8'));
        apiKey = cfg.kimi && cfg.kimi.api_key;
      } catch (e) { /* ignore */ }
    }
    if (!apiKey) {
      reject(new Error('KIMI_API_KEY not set'));
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(function () {
      controller.abort();
      reject(new Error('Kimi API timeout after 180s'));
    }, 180000);

    fetch('https://api.kimi.com/coding/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'kimi-for-coding',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Kimi API ' + res.status);
        return res.json();
      })
      .then(function (data) {
        clearTimeout(timeout);
        var content = data.content && data.content[0] && data.content[0].text || '';
        if (content) {
          resolve(content);
        } else {
          reject(new Error('Kimi API returned empty content'));
        }
      })
      .catch(function (err) {
        clearTimeout(timeout);
        reject(err);
      });
  });
}
