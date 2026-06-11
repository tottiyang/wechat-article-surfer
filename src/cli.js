#!/usr/bin/env node
/**
 * 公众号文章抓取 CLI（单用户版，cookies 持久化）
 * 
 * 用法:
 *   node src/cli.js login              # 启动登录服务器
 *   node src/cli.js status             # 查看登录状态
 *   node src/cli.js search <关键词>      # 搜索公众号
 *   node src/cli.js articles <fakeid>   # 获取文章列表
 *   node src/cli.js download <文章URL>   # 下载单篇文章为Markdown
 *   node src/cli.js dump <fakeid> [n]   # 批量导出最新n篇文章
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '.data', 'articles');
mkdirSync(DATA_DIR, { recursive: true });

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
});

// ========== Login Server ==========
async function cmdLogin() {
  const { spawn } = await import('node:child_process');
  const child = spawn('node', [join(__dirname, 'login-server.js')], {
    stdio: 'inherit', cwd: __dirname,
  });
  child.on('exit', () => process.exit());
}

// ========== Login Status ==========
async function cmdStatus() {
  const { loadCookies } = await import('./cookie-store.js');
  const data = loadCookies();
  if (!data) {
    console.log('❌ 未登录');
    return;
  }
  const remain = Math.round((data.expiresAt - Date.now()) / 3600000);
  console.log(`✅ 已登录（剩余 ${remain} 小时）`);
  console.log(`   token: ${data.token}`);
  console.log(`   cookies: ${data.cookies.length} 条`);
}

// ========== Search Accounts ==========
async function cmdSearch(keyword) {
  const { searchBiz, getAuth } = await import('./proxy.js');
  const result = await searchBiz(keyword);
  if (result.base_resp?.ret !== 0) {
    console.error('❌ 搜索失败:', result.base_resp?.err_msg || '未知错误');
    return;
  }
  const list = result.list || [];
  console.log(`找到 ${list.length} 个公众号:`);
  for (const item of list) {
    console.log(`\n  📌 ${item.nickname}`);
    console.log(`     FakeId: ${item.fakeid}`);
    console.log(`     微信号: ${item.alias || '-'}`);
  }
}

// ========== List Articles ==========
async function cmdArticles(fakeid) {
  const { getArticleList } = await import('./proxy.js');
  const result = await getArticleList(fakeid, { size: 10 });
  if (result.ret !== 0) {
    console.error('❌ 获取文章列表失败:', result.msg || JSON.stringify(result));
    return;
  }
  const articles = result.articles || [];
  console.log(`找到 ${articles.length} 篇文章:\n`);
  for (const a of articles) {
    const date = new Date((a.update_time || a.create_time) * 1000).toLocaleDateString('zh-CN');
    console.log(`  📄 [${date}] ${a.title}`);
    console.log(`     ${a.link}`);
    if (a.digest) console.log(`     ${a.digest.slice(0, 80)}`);
    console.log();
  }
}

// ========== Download Single Article ==========
async function cmdDownload(url) {
  const { downloadArticle } = await import('./proxy.js');
  console.log(`下载中: ${url}`);
  const html = await downloadArticle(url);
  if (!html) {
    console.error('❌ 下载失败');
    return;
  }
  const result = htmlToMarkdown(html, url);
  if (!result) {
    console.error('❌ 解析失败');
    return;
  }
  const filename = sanitizeFilename(result.title) + '.md';
  const filepath = join(DATA_DIR, filename);
  writeFileSync(filepath, result.markdown, 'utf-8');
  console.log(`✅ 已保存: ${filepath}`);
  console.log(`📝 标题: ${result.title}`);
  console.log(`📊 ${result.markdown.length} 字符`);
}

// ========== Batch Export ==========
async function cmdDump(fakeid, count) {
  const { getArticleList, downloadArticle } = await import('./proxy.js');

  const result = await getArticleList(fakeid, { size: parseInt(count) || 10 });
  if (result.ret !== 0) {
    console.error('❌ 获取文章列表失败');
    return;
  }
  const articles = result.articles || [];
  console.log(`批量下载 ${articles.length} 篇文章...`);

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    process.stdout.write(`[${i+1}/${articles.length}] ${a.title.slice(0, 40)}... `);
    try {
      const html = await downloadArticle(a.link);
      if (html) {
        const md = htmlToMarkdown(html, a.link);
        if (md) {
          const dateStr = new Date((a.update_time || a.create_time) * 1000).toISOString().slice(0, 10);
          const filename = `${dateStr}_${sanitizeFilename(a.title)}.md`;
          writeFileSync(join(DATA_DIR, filename), md.markdown, 'utf-8');
          console.log('✅');
        } else {
          console.log('❌ 解析失败');
        }
      } else {
        console.log('❌ 下载失败');
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`\n✅ 完成! 文件保存在 ${DATA_DIR}`);
}

// ========== HTML to Markdown ==========
function htmlToMarkdown(html, articleUrl) {
  try {
    const $ = cheerio.load(html);
    let title = $('title').text().trim() || 'untitled';
    const ogTitle = $('meta[property="og:title"]').attr('content');
    if (ogTitle) title = ogTitle;

    let author = '';
    const ogAuthor = $('meta[property="og:article:author"]').attr('content');
    if (ogAuthor) author = ogAuthor;

    let publishTime = '';
    const timeTag = $('em#publish_time').text().trim();
    if (timeTag) publishTime = timeTag;

    const contentEl = $('#js_content');
    if (!contentEl.length) {
      const alt = $('.rich_media_content, #js_article').first();
      if (alt.length) return convertElement(alt, title, author, publishTime, articleUrl);
      return { title, author, publishTime, markdown: `# ${title}\n\n(无法提取正文内容)` };
    }
    return convertElement(contentEl, title, author, publishTime, articleUrl);
  } catch (e) {
    console.error('HTML解析失败:', e.message);
    return null;
  }
}

function convertElement($el, title, author, publishTime, articleUrl) {
  $el.find('script, style, iframe, .js_underline_content').remove();
  $el.find('img').each((_, img) => {
    const $img = cheerio.load(img);
    const src = $img('img').attr('data-src') || $img('img').attr('src');
    if (src) {
      $img('img').attr('src', src);
      const alt = $img('img').attr('alt') || '';
      $img('img').replaceWith(`\n\n![${alt}](${src})\n\n`);
    }
  });
  const htmlContent = $el.html() || '';
  let markdown = turndownService.turndown(htmlContent);
  const frontMatter = [
    '---',
    `title: "${escapeYAML(title)}"`,
    author ? `author: "${escapeYAML(author)}"` : '',
    publishTime ? `published: "${publishTime}"` : '',
    articleUrl ? `url: ${articleUrl}` : '',
    '---', '',
  ].filter(Boolean).join('\n');
  return { title, author, publishTime, markdown: frontMatter + `# ${title}\n\n` + markdown.trim() };
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

function escapeYAML(s) { return s.replace(/"/g, '\\"'); }

// ========== Main ==========
const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'login': return cmdLogin();
    case 'status': return cmdStatus();
    case 'search': return cmdSearch(args[0]);
    case 'articles': return cmdArticles(args[0]);
    case 'download': return cmdDownload(args[0]);
    case 'dump': return cmdDump(args[0], args[1]);
    default:
      console.log(`
使用方法:
  node src/cli.js login           # 启动登录服务器
  node src/cli.js status          # 查看登录状态
  node src/cli.js search <关键词>   # 搜索公众号
  node src/cli.js articles <id>   # 查看文章列表
  node src/cli.js download <URL>  # 下载单篇文章
  node src/cli.js dump <id> [n]   # 批量导出

先登录：node src/cli.js login → 浏览器扫码
`);
  }
}

main().catch(console.error);
