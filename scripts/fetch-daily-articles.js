#!/usr/bin/env node
/**
 * fetch-daily-articles.js
 * 
 * 每日定时：读取飞书表格订阅列表 → 拉取前一天的公众号文章 → 下载Markdown → 上传IMA知识库
 * 
 * 命名规范（硬编码）：{公众号名}_{YYYY-MM-DD}_{原标题}.md
 * 全部敏感信息在 config.json，代码零硬编码，可上GitHub
 * 
 * 配置: 从 ../config.json 读取敏感信息
 * 用法: node scripts/fetch-daily-articles.js [--date YYYY-MM-DD]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ═══════════════════════════════════════════════════════════════════
// 命名规范（硬编码）
// 文件名：{公众号名}-{YYYY-MM-DD}-{原标题}.md
// ═══════════════════════════════════════════════════════════════════

const ARTICLE_DIR = join(ROOT, '.data', 'articles');

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')   // 去掉 Windows/文件系统非法字符
    .replace(/\s+/g, ' ')           // 合并多余空白
    .trim()
    .slice(0, 100);                 // 限制长度
}

function makeArticleFilename(bizName, pubDate, title) {
  const safeName = sanitizeFilename(bizName);
  const safeTitle = sanitizeFilename(title);
  return `${safeName}-${pubDate}-${safeTitle}.md`;
}

// ── 读取配置 ──────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = join(ROOT, 'config.json');
  if (!existsSync(configPath)) {
    console.error('❌ config.json not found. Copy config.example.json to config.json and fill in secrets.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

const config = loadConfig();
const TARGET_DATE = process.argv.find(a => a.startsWith('--date='))?.split('=')[1] || null;

// ═══════════════════════════════════════════════════════════════════
// 飞书 Sheet 操作
// ═══════════════════════════════════════════════════════════════════

function getFeishuToken() {
  const { token_file } = config.feishu;
  const resolved = token_file.replace(/^~/, process.env.HOME || '');
  if (!existsSync(resolved)) throw new Error(`Feishu token file not found: ${resolved}`);
  const tokens = JSON.parse(readFileSync(resolved, 'utf-8'));
  return tokens.user_access_token || tokens.access_token;
}

async function readSubscriptions() {
  const token = getFeishuToken();
  const { sheet_token, sheet_id } = config.feishu;
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${sheet_token}/values/${sheet_id}!A:G`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Feishu read error: ${JSON.stringify(data)}`);

  const rows = data.data?.valueRange?.values || [];
  if (rows.length < 2) return [];

  return rows.slice(1).filter(row => {
    const status = (row[3] || '').trim();
    return status === '启用';
  }).map(row => ({
    name: row[0] || '',
    wechat_id: row[1] || '',
    fakeid: row[2] || '',
    status: row[3] || '',
  }));
}

async function updateSheetRow(rowIndex, data) {
  const token = getFeishuToken();
  const { sheet_token, sheet_id } = config.feishu;
  const range = `${sheet_id}!E${rowIndex}:G${rowIndex}`;

  const res = await fetch(
    `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${sheet_token}/values`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueRange: { range, values: [data] }
      })
    }
  );
  const result = await res.json();
  if (result.code !== 0) {
    console.warn(`⚠️  Sheet update failed at row ${rowIndex}: ${JSON.stringify(result)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Session 有效性检查（执行任何操作前先验证）
// ═══════════════════════════════════════════════════════════════════

async function validateSession() {
  const { checkSession } = await import(join(ROOT, 'src/proxy.js'));
  const result = await checkSession();
  if (!result.valid) {
    console.error(`❌ ${result.message}`);
    console.error('   请先通过 http://localhost:3000 扫码登录');
    process.exit(1);
  }
  console.log(`   ${result.message}`);
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// 微信文章下载 — 直接调用 mp-proxy，文件名按命名规范
// ═══════════════════════════════════════════════════════════════════

async function getArticleList(fakeid) {
  const { getArticleList } = await import(join(ROOT, 'src/proxy.js'));
  const result = await getArticleList(fakeid, { size: '50' });
  if (result.ret !== 0) {
    throw new Error(`WeChat API error (ret=${result.ret}): ${result.err_msg || 'unknown'}`);
  }
  return result.articles || [];
}

/**
 * 下载文章 → 转 Markdown → 按命名规范保存 → 返回 { title, filePath }
 */
async function downloadAndSaveArticle(url, bizName, pubDate) {
  const { downloadArticle } = await import(join(ROOT, 'src/proxy.js'));
  const { default: TurndownService } = await import('turndown');

  const html = await downloadArticle(url);
  if (!html) throw new Error('Empty response');

  // 从 HTML 提取标题
  let title = '';
  const titleMatch = html.match(/var\s+msg_title\s*=\s*['"]([^'"]+?)['"]/);
  if (titleMatch) title = titleMatch[1];
  else {
    const hMatch = html.match(/<h[12][^>]*>([^<]+)<\/h/);
    if (hMatch) title = hMatch[1];
  }
  if (!title) title = 'untitled';

  // HTML → Markdown
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  let markdown = turndown.turndown(html);

  // 加 YAML frontmatter
  const frontmatter = `---\ntitle: "${title.replace(/"/g, '\\"')}"\nurl: ${url}\n---\n`;
  markdown = frontmatter + markdown;

  // 按命名规范生成文件名
  const filename = makeArticleFilename(bizName, pubDate, title);
  if (!existsSync(ARTICLE_DIR)) mkdirSync(ARTICLE_DIR, { recursive: true });
  const filePath = join(ARTICLE_DIR, filename);

  writeFileSync(filePath, markdown, 'utf-8');
  return { title, filePath };
}

// ═══════════════════════════════════════════════════════════════════
// IMA 知识库上传
// ═══════════════════════════════════════════════════════════════════

async function getImaCredentials() {
  const { credential_dir } = config.ima;
  const cidFile = join(credential_dir, 'client_id');
  const keyFile = join(credential_dir, 'api_key');
  if (!existsSync(cidFile) || !existsSync(keyFile)) {
    throw new Error('IMA credentials not configured. Check ~/.config/ima/');
  }
  return {
    client_id: readFileSync(cidFile, 'utf-8').trim(),
    api_key: readFileSync(keyFile, 'utf-8').trim()
  };
}

async function imaApi(path, body) {
  const creds = await getImaCredentials();
  const res = await fetch(`https://ima.qq.com/${path}`, {
    method: 'POST',
    headers: {
      'ima-openapi-clientid': creds.client_id,
      'ima-openapi-apikey': creds.api_key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`IMA API error (${path}): code=${json.code} msg=${json.msg || json.errmsg || 'unknown'}`);
  }
  return json;
}

async function uploadMdToIma(filePath) {
  const { knowledge_base_id } = config.ima;
  const fileName = basename(filePath);
  const fileSize = existsSync(filePath) ? readFileSync(filePath).length : 0;
  if (fileSize === 0) throw new Error(`File empty: ${filePath}`);

  // Step 1: check_repeated_names
  await imaApi('openapi/wiki/v1/check_repeated_names', {
    params: [{ name: fileName, media_type: 7 }],
    knowledge_base_id,
  });

  // Step 2: create_media
  const mediaRes = await imaApi('openapi/wiki/v1/create_media', {
    file_name: fileName,
    file_size: fileSize,
    content_type: 'text/markdown',
    knowledge_base_id,
    file_ext: 'md',
  });

  const { media_id, cos_credential } = mediaRes.data;
  if (!cos_credential) throw new Error('No COS credential returned');

  // Step 3: COS Upload
  const cosCmd = `node "${join(__dirname, '..', '..', '..', 'skills/ima/knowledge-base/scripts/cos-upload.cjs')}" \
    --file "${filePath}" \
    --secret-id "${cos_credential.secret_id}" \
    --secret-key "${cos_credential.secret_key}" \
    --token "${cos_credential.token}" \
    --bucket "${cos_credential.bucket_name}" \
    --region "${cos_credential.region}" \
    --cos-key "${cos_credential.cos_key}" \
    --content-type "text/markdown" \
    --start-time "${cos_credential.start_time}" \
    --expired-time "${cos_credential.expired_time}"`;

  try { execSync(cosCmd, { encoding: 'utf-8', timeout: 60000 }); }
  catch (e) { throw new Error(`COS upload failed: ${e.message}`); }

  // Step 4: add_knowledge
  await imaApi('openapi/wiki/v1/add_knowledge', {
    media_type: 7, media_id,
    title: fileName,
    knowledge_base_id,
    file_info: {
      cos_key: cos_credential.cos_key,
      file_size: fileSize,
      file_name: fileName,
    }
  });

  return media_id;
}

// ═══════════════════════════════════════════════════════════════════
// 日期工具
// ═══════════════════════════════════════════════════════════════════

function getYesterdayStr() {
  if (TARGET_DATE) return TARGET_DATE;
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isYesterdayArticle(article) {
  const pubDate = new Date(article.create_time * 1000);
  const yest = getYesterdayStr();
  const articleDate = pubDate.toISOString().slice(0, 10);
  return articleDate === yest;
}

// ═══════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const dateStr = getYesterdayStr();
  console.log(`📅  目标日期: ${dateStr}`);
  console.log(`📁  存储目录: ${ARTICLE_DIR}`);
  console.log(`📛  命名规范: {公众号名}_{YYYY-MM-DD}_{原标题}.md`);
  console.log('');

  // 0. 验证 WeChat session 有效性
  console.log('🔑  验证 WeChat session...');
  await validateSession();
  console.log('');

  // 1. 读取订阅列表
  console.log('📖  读取飞书表格订阅列表...');
  const subs = await readSubscriptions();
  console.log(`    发现 ${subs.length} 个启用的公众号`);

  if (subs.length === 0) {
    console.log('ℹ️   没有需要处理的公众号。');
    return;
  }

  let totalDownloads = 0;
  let totalUploads = 0;
  let errors = [];

  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    const rowIndex = i + 2;
    console.log(`\n─── [${sub.name}] ───`);

    try {
      // 2. 获取文章列表
      console.log(`   拉取文章列表...`);
      const articles = await getArticleList(sub.fakeid);
      console.log(`   总计 ${articles.length} 篇`);

      // 3. 过滤前一天的文章
      const yesterdayArticles = articles.filter(isYesterdayArticle);
      console.log(`   ${dateStr} 发布: ${yesterdayArticles.length} 篇`);

      if (yesterdayArticles.length === 0) {
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        await updateSheetRow(rowIndex, [now, '', '']);
        console.log(`   ✅ 无新增`);
        continue;
      }

      // 4. 下载+转换+保存
      let lastTitle = '';
      let lastLink = '';

      for (const article of yesterdayArticles) {
        const title = article.title.trim();
        const link = article.link;
        console.log(`   ↓ ${title}`);

        try {
          const result = await downloadAndSaveArticle(link, sub.name, dateStr);
          totalDownloads++;
          lastTitle = title;
          lastLink = link;
          console.log(`   ✅ 本地: ${basename(result.filePath)}`);

          // 5. 上传 IMA
          console.log(`   ↑ IMA 上传中...`);
          const mediaId = await uploadMdToIma(result.filePath);
          totalUploads++;
          console.log(`   ✅ IMA: ${mediaId.slice(0, 20)}...`);

        } catch (err) {
          console.error(`   ❌ 失败: ${err.message}`);
          errors.push({ name: sub.name, title, error: err.message });
        }
      }

      // 6. 更新飞书表格
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      await updateSheetRow(rowIndex, [now, lastTitle, lastLink]);
      console.log(`   ✅ 飞书表格已更新`);

    } catch (err) {
      console.error(`   ❌ ${sub.name} 处理失败: ${err.message}`);
      errors.push({ name: sub.name, error: err.message });
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  console.log('📊  汇总');
  console.log(`   目标日期: ${dateStr}`);
  console.log(`   下载文章: ${totalDownloads} 篇`);
  console.log(`   IMA 上传: ${totalUploads} 篇`);
  console.log(`   错误: ${errors.length}`);
  if (errors.length > 0) {
    for (const e of errors) {
      console.log(`   ❌ [${e.name}] ${e.title || ''} - ${e.error.slice(0, 150)}`);
    }
  }
  console.log('✅  完成');
}

main().catch(err => {
  console.error(`\n❌ 致命错误: ${err.message}`);
  process.exit(1);
});
