/**
 * 微信登录服务器（轻量版）
 * 
 * 核心机制：完整转发 cookies 在浏览器和微信之间双向流动
 * - startlogin: 创建 session → 微信设置 uuid 等 cookies → 全部传回浏览器
 * - 浏览器自动管理 cookies → 后续请求自动携带全部 cookies
 * - 登录确认: 浏览器发来的 cookies + sessionid → 微信返回 auth-key
 * 
 * 修复记录（2026-06-10）：
 * - status:1 检测到后 2 秒直接调 doLogin，不等 status:2（微信可能不返回 2）
 * - startQrLogin 前先调 /api/logout 清空服务端状态和浏览器 cookies
 * - 新增 /api/clear-cookies 删除磁盘上的 cookie 文件
 * - 每次 startlogin 重置 loginState，避免旧 session 干扰
 */

import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyMpRequest } from './proxy.js';
import { saveCookies, parseSetCookies } from './cookie-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] || '3000');

const loginState = {
  step: 'init',         // init → session_created → scanned → logged → done
  sessionid: null,
  nickname: '',
  avatar: '',
  /** 服务端保留的 session cookies（不依赖浏览器转发） */
  sessionCookie: null,
};

// ========== 服务端独立轮询（不依赖浏览器） ==========
// 当 startlogin 成功后，启动服务端轮询，即使浏览器 cookie 有问题也能捕获状态变化
let serverPollTimer = null;

function startServerPolling() {
  stopServerPolling();
  console.log('[server-poll] 启动服务端独立轮询...');
  serverPollTimer = setInterval(async () => {
    if (loginState.step === 'done') {
      stopServerPolling();
      return;
    }
    if (!loginState.sessionCookie) {
      // console.log('[server-poll] 无 session cookie，跳过');
      return;
    }
    try {
      const queryParams = { action: 'ask', token: '', lang: 'zh_CN', f: 'json', ajax: '1' };
      if (loginState.sessionid) queryParams.sessionid = loginState.sessionid;

      const resp = await proxyMpRequest({
        method: 'GET',
        endpoint: 'https://mp.weixin.qq.com/cgi-bin/scanloginqrcode',
        query: queryParams,
        cookie: loginState.sessionCookie,
        parseJson: true,
      });

      if (resp?.status === 1) {
        // ✅ status:1 = 手机上已确认，自动完成登录（参考 wechat-article-exporter）
        console.log('[server-poll] ✅ 检测到手机已确认（status:1），自动执行 login...');
        loginState.step = 'logged';
        const loginResp = await doServerLogin();
        if (loginResp.ok) {
          console.log('[server-poll] ✅ 自动登录成功');
          stopServerPolling();
        } else {
          console.log('[server-poll] ❌ 自动登录失败:', loginResp.err);
        }
      } else if (resp?.status === 4 || resp?.status === 6) {
        // 已扫码等待确认，不做操作
      } else if (resp?.status === 2 || resp?.status === 3) {
        // 二维码过期，停止轮询
        console.log('[server-poll] ℹ️ 二维码已过期');
        stopServerPolling();
      }
    } catch (e) { /* 静默处理 */ }
  }, 2000);
}

function stopServerPolling() {
  if (serverPollTimer) {
    clearInterval(serverPollTimer);
    serverPollTimer = null;
  }
}

async function doServerLogin() {
  const payload = {
    userlang: 'zh_CN', redirect_url: '', cookie_forbidden: 0,
    cookie_cleaned: 0, plugin_used: 0, login_type: 3,
    token: '', lang: 'zh_CN', f: 'json', ajax: 1,
  };
  try {
    const resp = await proxyMpRequest({
      method: 'POST',
      endpoint: 'https://mp.weixin.qq.com/cgi-bin/bizlogin',
      query: { action: 'login' },
      body: payload,
      cookie: loginState.sessionCookie,
    });

    const bodyStr = Buffer.isBuffer(resp.body) ? resp.body.toString() : resp.body;
    let bodyJson;
    try { bodyJson = JSON.parse(bodyStr); } catch(e) { bodyJson = {}; }

    const redirectUrl = bodyJson?.redirect_url;
    if (redirectUrl && typeof redirectUrl === 'string') {
      const token = new URL(`http://localhost${redirectUrl}`).searchParams.get('token');
      if (token) {
        saveCookies(token, parseSetCookies(resp.setCookies || []));
        loginState.step = 'done';
        console.log('[server-poll] ✅ 登录完成，cookies 已保存');
        return { ok: true };
      }
    }
    return { ok: false, err: `ret=${bodyJson.base_resp?.ret}` };
  } catch(e) {
    return { ok: false, err: e.message };
  }
}

// ========== Routes ==========
const routes = {
  'GET /': async () => ({
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: getIndexHtml(),
  }),

  // Step 0: 清除当前登录状态（用于重新扫码前清理）
  'GET /api/logout': async () => {
    stopServerPolling();
    loginState.step = 'init';
    loginState.sessionid = null;
    loginState.sessionCookie = null;
    loginState.nickname = '';
    // 同时删除磁盘上的 cookie 文件
    const cookieFile = join(__dirname, '.data', 'wechat-cookies.json');
    if (existsSync(cookieFile)) {
      unlinkSync(cookieFile);
      console.log('[logout] deleted cookie file');
    }
    const respHeaders = {
      'Set-Cookie': [
        'uuid=; Max-Age=0; Path=/',
        'sessionid=; Max-Age=0; Path=/',
        'slave_sid=; Max-Age=0; Path=/',
        'slave_user=; Max-Age=0; Path=/',
        'bizuin=; Max-Age=0; Path=/',
      ].join(', '),
    };
    console.log('[logout] session cleared');
    return { status: 200, headers: respHeaders, body: JSON.stringify({ ok: true }) };
  },

  // Step 1: Create login session
  'POST /api/login/start': async (req) => {
    // 每次创建新 session 前完全重置，避免旧 uuid/cookies 干扰
    stopServerPolling();
    loginState.step = 'init';
    loginState.sessionid = null;
    loginState.sessionCookie = null;
    loginState.nickname = '';

    const sid = Date.now().toString() + Math.floor(Math.random() * 100);
    loginState.sessionid = sid;

    const resp = await proxyMpRequest({
      method: 'POST',
      endpoint: 'https://mp.weixin.qq.com/cgi-bin/bizlogin',
      query: { action: 'startlogin' },
      body: {
        userlang: 'zh_CN', redirect_url: '', login_type: 3,
        sessionid: sid, token: '', lang: 'zh_CN',
        f: 'json', ajax: 1,
      },
      cookie: req.headers.cookie || undefined,
    });

    // Forward ALL set-cookies from WeChat back to browser
    const setCookieHeaders = resp.setCookies || [];
    const respHeaders = { 'Content-Type': 'application/json' };
    if (setCookieHeaders.length > 0) {
      respHeaders['Set-Cookie'] = setCookieHeaders;
    }

    loginState.step = 'session_created';
    console.log('[start] sessionid:', sid, '| setCookies:', setCookieHeaders.length,
      setCookieHeaders.map(c => c.split('=')[0]).join(', '));

    // Store session cookies server-side for independent polling
    const cookie = req.headers.cookie || undefined;
    if (cookie) {
      loginState.sessionCookie = cookie;
    } else if (resp.setCookies?.length > 0) {
      const parsed = parseSetCookies(resp.setCookies);
      const cookieStr = parsed.filter(c => c.value && c.value !== 'EXPIRED').map(c => `${c.name}=${c.value}`).join('; ');
      if (cookieStr) loginState.sessionCookie = cookieStr;
    }

    // Try JSON body
    try {
      const bodyStr = Buffer.isBuffer(resp.body) ? resp.body.toString() : resp.body;
      const bodyJson = JSON.parse(bodyStr);
      if (bodyJson.base_resp?.ret !== 0) {
        console.log('[start] error:', bodyJson.base_resp?.err_msg);
      }
    } catch(e) { /* binary response */ }

    // 启动服务端独立轮询
    startServerPolling();

    return { status: 200, headers: respHeaders, body: JSON.stringify({ ok: true, msg: 'session created', sessionid: sid }) };
  },

  // Step 2: Get QR code image
  'GET /api/qrcode': async (req) => {
    // 优先使用浏览器 cookie，fallback 到服务端保留的 session cookie
    const cookie = req.headers.cookie || loginState.sessionCookie || undefined;
    console.log('[qrcode] req cookie:', (cookie||'').slice(0,60));
    const resp = await proxyMpRequest({
      method: 'GET',
      endpoint: 'https://mp.weixin.qq.com/cgi-bin/scanloginqrcode',
      query: { action: 'getqrcode', random: String(Date.now()) },
      cookie,
    });

    console.log('[qrcode] proxy status:', resp.status, '| body size:', Buffer.isBuffer(resp.body) ? resp.body.length : (resp.body||'').length);

    const respHeaders = { 'Content-Type': 'image/jpeg' };
    if (resp.setCookies?.length > 0) {
      respHeaders['Set-Cookie'] = resp.setCookies;
      console.log('[qrcode] forwarding setCookies:', resp.setCookies.length);
    }
    return { status: 200, headers: respHeaders, body: resp.body };
  },

  // Step 3: Poll scan status
  // 同时使用浏览器 cookies 和服务端保留的 session cookies，确保不遗漏状态变化
  'GET /api/scan': async (req) => {
    // 优先使用浏览器 cookies，其次使用服务端保留的 session cookies
    const scanCookie = req.headers.cookie || loginState.sessionCookie || undefined;
    const queryParams = { action: 'ask', token: '', lang: 'zh_CN', f: 'json', ajax: '1' };
    if (loginState.sessionid) queryParams.sessionid = loginState.sessionid;

    let resp;
    try {
      resp = await proxyMpRequest({
        method: 'GET',
        endpoint: 'https://mp.weixin.qq.com/cgi-bin/scanloginqrcode',
        query: queryParams,
        cookie: scanCookie,
        parseJson: true,
      });
    } catch(e) {
      console.error('[scan] error:', e.message);
      return json(200, { status: 'waiting' });
    }

    console.log('[scan] response:', JSON.stringify(resp).slice(0, 400));

    if (!resp || resp.base_resp?.ret !== 0) {
      return json(200, { status: 'waiting', ret: resp?.base_resp?.ret });
    }

    switch (resp.status) {
      case 0:
        // 未扫码，继续轮询
        return json(200, { status: 'waiting' });

      case 1:
        // ✅ 已在手机上确认 → 立即调 login（参考 wechat-article-exporter/composables/useLoginAccount.ts）
        console.log('[scan] ✅ CONFIRMED on phone');
        loginState.step = 'logged';
        return json(200, { status: 'logged' });

      case 2:
      case 3:
        // 二维码过期，通知前端刷新
        console.log('[scan] ℹ️  status:' + resp.status + ' (二维码已过期)');
        return json(200, { status: 'expired' });

      case 4:
      case 6:
        // 已扫码但未确认（acct_size=可选账号数）
        console.log('[scan] 📱 SCANNED, acct_size:', resp.acct_size);
        loginState.step = 'scanned';
        return json(200, { status: 'scanned', acct_size: resp.acct_size });

      case 5:
        // 未绑定邮箱
        console.log('[scan] ❌ 账号未绑定邮箱');
        return json(200, { status: 'error', msg: '该账号尚未绑定邮箱' });

      default:
        return json(200, { status: 'waiting', unknown_status: resp.status });
    }
  },

  // Step 4: Confirm login
  'POST /api/login': async (req) => {
    console.log('[login] called, cookie:', (req.headers.cookie || '').slice(0, 80));

    // 使用浏览器 cookies 或服务端保留的 session cookies
    const loginCookie = req.headers.cookie || loginState.sessionCookie || undefined;
    const payload = {
      userlang: 'zh_CN', redirect_url: '', cookie_forbidden: 0,
      cookie_cleaned: 0, plugin_used: 0, login_type: 3,
      token: '', lang: 'zh_CN', f: 'json', ajax: 1,
    };

    let resp;
    try {
      resp = await proxyMpRequest({
        method: 'POST',
        endpoint: 'https://mp.weixin.qq.com/cgi-bin/bizlogin',
        query: { action: 'login' },
        body: payload,
        cookie: loginCookie,
      });
    } catch(e) {
      console.error('[login] proxy error:', e.message);
      return json(200, { err: 'proxy error: ' + e.message });
    }

    const bodyStr = Buffer.isBuffer(resp.body) ? resp.body.toString() : resp.body;
    console.log('[login] body:', bodyStr.slice(0, 300));

    // Parse JSON body to check response
    let bodyJson;
    try { bodyJson = JSON.parse(bodyStr); } catch(e) { bodyJson = {}; }

    // 策略1：从 redirect_url 提取 token（微信标准登录成功响应）
    const redirectUrl = bodyJson?.redirect_url;
    if (redirectUrl && typeof redirectUrl === 'string') {
      try {
        const token = new URL(`http://localhost${redirectUrl}`).searchParams.get('token');
        if (token) {
          console.log('[login] ✅ token found in redirect_url:', token.slice(0, 20));
          saveCookies(token, parseSetCookies(resp.setCookies || []));
          loginState.step = 'done';
          console.log('[login] ✅ login successful, cookies saved');
          return json(200, { status: 'done' });
        }
      } catch(e) {
        console.error('[login] token extract error:', e.message);
      }
    }

    // 策略2：从 Set-Cookie 中提取 token（某些情况下 token 藏在 cookie 里）
    const setCookies = resp.setCookies || [];
    if (!redirectUrl && bodyJson.base_resp?.ret === 0) {
      const hasSlaveSid = setCookies.some(c => c.startsWith('slave_sid='));
      if (hasSlaveSid) {
        const fakeToken = String(Date.now());
        console.log('[login] ✅ ret=0 with slave_sid, using generated token:', fakeToken);
        saveCookies(fakeToken, parseSetCookies(setCookies));
        loginState.step = 'done';
        return json(200, { status: 'done' });
      }
    }

    // 策略3：ret=1000 但 setCookies 包含 slave_sid（提前调 login 也可能拿到 cookies）
    if (bodyJson.base_resp?.ret === 1000 && setCookies.length >= 10) {
      const hasKeyCookies = setCookies.some(c => c.startsWith('slave_sid=') || c.startsWith('slave_user=') || c.startsWith('bizuin='));
      if (hasKeyCookies) {
        const fakeToken = String(Date.now());
        console.log('[login] ⚠️  ret=1000 but key cookies received, saving anyway. token:', fakeToken);
        saveCookies(fakeToken, parseSetCookies(setCookies));
        loginState.step = 'done';
        return json(200, { status: 'done', warning: 'ret=1000 but cookies saved' });
      }
    }

    // ========== 阻塞等待：服务端轮询(doServerLogin)可能稍后保存 cookies ==========
    // doServerLogin() 在检测到 status:1 后约 1-3 秒完成，会保存 cookies 到磁盘
    // 这里等待最多 12 秒，每 800ms 检查一次磁盘 cookies
    // 在此期间前端显示「正在登录...」，不会闪红色错误
    console.log('[login] ⚠️ bizlogin failed, waiting for server-poll to save cookies...');
    const cookieFile = join(__dirname, '.data', 'wechat-cookies.json');
    for (let i = 0; i < 15; i++) { // 15 × 800ms = 12秒
      await new Promise(r => setTimeout(r, 800));
      if (existsSync(cookieFile)) {
        try {
          const cookieData = JSON.parse(readFileSync(cookieFile, 'utf8'));
          const hasValidCookies = (cookieData.cookies?.length || 0) >= 8 && cookieData.expiresAt > Date.now();
          if (hasValidCookies) {
            loginState.step = 'done';
            console.log('[login] ✅ cookies saved by server-poll after ' + ((i+1)*800) + 'ms, reporting success');
            return json(200, { status: 'done', warning: 'cookies saved by server polling' });
          }
        } catch(e) {}
      }
      // 也检查 loginState.step（服务端轮询可能已设置）
      if (loginState.step === 'done') {
        console.log('[login] ✅ loginState.step=done detected during wait, reporting success');
        return json(200, { status: 'done' });
      }
    }

    console.log('[login] ❌ failed after waiting 12s. ret:', bodyJson.base_resp?.ret, 'msg:', bodyJson.base_resp?.err_msg);
    return json(200, { err: '登录失败: ' + (bodyJson.base_resp?.err_msg || '未知错误, ret=' + bodyJson.base_resp?.ret) });
  },

  // API: 删除磁盘上的 cookie 文件
  'GET /api/clear-cookies': async () => {
    const cookieFile = join(__dirname, '.data', 'wechat-cookies.json');
    if (existsSync(cookieFile)) {
      unlinkSync(cookieFile);
      console.log('[clear-cookies] deleted:', cookieFile);
      return json(200, { ok: true, msg: '已删除 cookie 文件' });
    }
    return json(200, { ok: true, msg: '无 cookie 文件' });
  },

  // API: Check stored session（页面加载时调用）
  'GET /api/check-session': async () => {
    const { checkSession } = await import('./proxy.js');
    const result = await checkSession();
    return json(200, result);
  },

  // API: Check status
  'GET /api/status': () => json(200, {
    step: loginState.step,
    sessionCookie: !!loginState.sessionCookie,
    sessionid: loginState.sessionid?.slice(0, 20),
    nickname: loginState.nickname,
    avatar: loginState.avatar,
    loggedIn: loginState.step === 'done',
  }),
};

// ========== Server ==========
function parseReq(req) {
  const urlPath = req.url.split('?')[0] || '/';
  return `${req.method} ${urlPath}`;
}

function json(status, data) {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

const server = createServer(async (req, res) => {
  const routeKey = parseReq(req);
  const handler = routes[routeKey];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  try {
    const result = await handler(req, res);
    if (!result) return; // for custom handlers
    const { status, headers, body } = result;
    res.writeHead(status, headers || {});
    if (Buffer.isBuffer(body)) {
      res.end(body);
    } else if (typeof body === 'string') {
      res.end(body);
    } else {
      res.end(JSON.stringify(body));
    }
  } catch(e) {
    console.error('[server] handler error:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Error');
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${PORT} 已被占用`);
  }
});

server.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║  微信公众号文章抓取 - 登录服务器          ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  打开浏览器访问：                        ║`);
  console.log(`║  → http://localhost:${PORT}              ║`);
  console.log(`║                                          ║`);
  console.log(`║  扫码登录后 cookies 将保存到 .data/      ║`);
  console.log(`║  有效期 4 天                             ║`);
  console.log(`╚══════════════════════════════════════════╝`);
});

// ========== HTML ==========
function getIndexHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信扫码登录</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
.card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 100%; }
h1 { font-size: 22px; margin-bottom: 8px; color: #333; }
p { color: #666; margin-bottom: 24px; font-size: 14px; }
.qrcode { background: #f9f9f9; border-radius: 8px; padding: 20px; margin-bottom: 16px; display: flex; justify-content: center; align-items: center; min-height: 280px; }
.qrcode img { max-width: 260px; }
.placeholder { color: #999; }
.status { font-size: 14px; margin: 12px 0; min-height: 24px; }
.status.loading { color: #07c; }
.status.success { color: #0a0; }
.status.error { color: #c00; }
.step { font-size: 13px; color: #999; margin-top: 16px; }
@media (prefers-color-scheme: dark) {
  body { background: #1a1a1a; }
  .card { background: #222; }
  h1 { color: #eee; }
  p { color: #aaa; }
  .qrcode { background: #2a2a2a; }
  .step { color: #888; }
}
</style>
</head>
<body>
<div class="card">
  <h1>微信扫码登录</h1>
  <p id="desc">请使用微信扫描二维码登录您的公众号</p>
  <div class="qrcode" id="qrcode"><div class="placeholder">检查已保存的 session...</div></div>
  <div class="status" id="status"></div>
  <div class="session-info" id="sessionInfo"></div>
  <div class="step" id="step">检查已有 session...</div>
  <button id="btnRefresh" style="display:none;margin-top:12px;padding:8px 20px;background:#07c;color:white;border:none;border-radius:6px;font-size:14px;cursor:pointer" onclick="startQrLogin()">🔄 清除并重新扫码</button>
</div>
<script>
// ========== Step 0: 检查已有 session ==========
let pollingTimer = null;

async function init() {
  try {
    const r = await (await fetch('/api/check-session')).json();
    if (r.valid) {
      document.getElementById('status').className = 'status success';
      document.getElementById('status').textContent = '✅ ' + r.message;
      document.querySelector('.step').textContent = '✅ 已有有效 session，可直接使用';
      document.querySelector('.qrcode').innerHTML = '<div style="padding:40px;color:#0a0;font-size:18px">✅ 已登录</div>';
      document.getElementById('desc').textContent = '已有有效登录，无需重复扫码';
      document.getElementById('btnRefresh').style.display = 'inline-block';
      document.getElementById('btnRefresh').textContent = '🔄 清除并重新扫码';
      return;
    }
  } catch(e) {}
  // 无有效 session，开始扫码流程
  startQrLogin();
}

async function startQrLogin() {
  // 先调 /api/logout 清除服务端状态和浏览器 cookies
  document.getElementById('status').className = 'status';
  document.getElementById('status').textContent = '清除旧登录状态...';
  try { await fetch('/api/logout'); } catch(e) {}
  document.getElementById('qrcode').innerHTML = '<div class="placeholder">加载二维码中...</div>';
  document.getElementById('btnRefresh').style.display = 'none';
  document.getElementById('desc').textContent = '请使用微信扫描二维码登录您的公众号';
  document.querySelector('.step').textContent = '第1步：创建会话...';
  await createSession();
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(checkScan, 2000);
  // 启动后台健康检查，防止 bizlogin 失败后页面卡在错误状态
  startHealthCheck();
}

async function createSession() {
  try {
    const r = await (await fetch('/api/login/start', { method: 'POST' })).json();
    if (r.ok) {
      document.querySelector('.step').textContent = '第2步：加载二维码中...';
      loadQrcode();
    } else {
      document.querySelector('.qrcode').innerHTML = '<div class="placeholder">创建会话失败: ' + (r.msg || '') + '</div>';
      document.querySelector('.step').textContent = '创建会话失败';
    }
  } catch(e) {
    document.querySelector('.qrcode').innerHTML = '<div class="placeholder">创建会话失败</div>';
    document.querySelector('.step').textContent = '创建会话失败';
  }
}

async function loadQrcode() {
  const qr = document.getElementById('qrcode');
  const img = document.createElement('img');
  img.onload = () => { qr.innerHTML = ''; qr.appendChild(img); document.querySelector('.step').textContent = '第3步：请使用微信扫码'; };
  img.onerror = () => { qr.innerHTML = '<div class="placeholder">加载失败，正在重试...</div>'; setTimeout(loadQrcode, 3000); };
  img.src = '/api/qrcode?' + Date.now();
}

// ========== 后台健康检查（补偿机制）==========
// 扫描轮询失败后，后台持续检查 session 是否变为有效
// 来源：服务端轮询(doServerLogin)可能在 bizlogin ret:1000 时仍保存了 cookies
let healthTimer = null;

async function checkSessionHealth() {
  try {
    const r = await (await fetch('/api/check-session')).json();
    if (r.valid && document.getElementById('status').className !== 'status success') {
      // session 突然变有效了！停止所有轮询，显示成功
      const status = document.getElementById('status');
      status.className = 'status success';
      status.textContent = '✅ ' + r.message;
      document.querySelector('.step').textContent = '✅ 登录完成，可以关闭此页面';
      document.querySelector('.qrcode').innerHTML = '<div style="padding:40px;color:#0a0;font-size:18px">✅ 已登录</div>';
      if (pollingTimer) clearInterval(pollingTimer);
      if (healthTimer) clearInterval(healthTimer);
    }
  } catch(e) {}
}

function startHealthCheck() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(checkSessionHealth, 3000);
}

async function checkScan() {
  try {
    const r = await (await fetch('/api/scan')).json();
    const status = document.getElementById('status');
    const step = document.querySelector('.step');
    
    if (r.status === 'scanned') {
      status.className = 'status loading';
      const acctSize = r.acct_size || '';
      status.textContent = '📱 已扫码' + (acctSize ? '(' + acctSize + '个账号)' : '') + '，请在手机上确认';
      step.textContent = '第3步：请在手机上确认登录';
      // 继续轮询等 status:1（手机上确认）
    } else if (r.status === 'logged') {
      status.className = 'status loading';
      status.textContent = '手机上已确认，正在登录...';
      step.textContent = '第4步：登录中...';
      // ✅ status:1 = 手机上已确认 → 立即调 doLogin
      // 参考 wechat-article-exporter：status:1 是最关键的信号，不等任何其他状态
      clearTimeout(window.loginRetryTimer);
      setTimeout(doLogin, 300);
    } else if (r.status === 'expired') {
      status.className = 'status error';
      status.textContent = '二维码已过期，正在刷新...';
      setTimeout(startQrLogin, 2000);
    } else if (r.status === 'error') {
      status.className = 'status error';
      status.textContent = '❌ ' + (r.msg || '登录错误');
    } else {
      // waiting: 继续轮询
    }
  } catch(e) {}
}

async function doLogin() {
  // 避免重复调用
  if (window._logging) return;
  window._logging = true;
  const status = document.getElementById('status');
  const step = document.querySelector('.step');
  status.textContent = '正在登录...';

  try {
    const r = await (await fetch('/api/login', { method: 'POST' })).json();
    
    if (r.status === 'done') {
      status.className = 'status success';
      status.textContent = '✅ 登录成功！';
      step.textContent = '✅ 登录完成，可以关闭此页面';
      if (pollingTimer) clearInterval(pollingTimer);
      if (healthTimer) clearInterval(healthTimer);
    } else {
      // API 返回失败，但磁盘 cookies 可能已经保存有效
      //（如 bizlogin 返回 ret:1000 但 Set-Cookie 包含完整 session）
      const sessionCheck = await (await fetch('/api/check-session')).json();
      if (sessionCheck.valid) {
        status.className = 'status success';
        status.textContent = '✅ ' + sessionCheck.message;
        step.textContent = '✅ 登录完成，可以关闭此页面';
        if (pollingTimer) clearInterval(pollingTimer);
        if (healthTimer) clearInterval(healthTimer);
      } else {
        status.className = 'status error';
        status.textContent = '❌ 登录失败: ' + (r.err || '未知错误');
        document.getElementById('btnRefresh').style.display = 'inline-block';
      }
    }
  } catch(e) {
    status.className = 'status error';
    status.textContent = '❌ 登录请求失败';
  }
  window._logging = false;
}

init();
</script>
</body>
</html>`;
}
