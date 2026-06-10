import { loadCookies, cookiesToString, parseSetCookies } from './cookie-store.js';
import { Buffer } from 'node:buffer';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 MicroMessenger/6.8.0(0x16080000) NetType/WIFI MiniProgramEnv/Mac MacWechat/WECHAT';

/**
 * 获取已存储的 WeChat cookie 和 token
 */
function getAuth() {
  const data = loadCookies();
  if (!data) return null;
  return { cookie: cookiesToString(data.cookies), token: data.token };
}

/**
 * 检查当前 session 是否有效（轻量级）
 * 用于决定是否需要重新登录，而非直接假设 cookies 不可用
 * 返回 { valid, account, expiresAt, message }
 */
export async function checkSession() {
  try {
    const auth = getAuth();
    if (!auth) {
      return { valid: false, account: '', expiresAt: null, message: '未登录（无 cookies 文件）' };
    }

    // 轻量级验证：获取账号信息
    const info = await getAccountInfo();
    if (info.nick_name) {
      const data = loadCookies();
      return {
        valid: true,
        account: info.nick_name,
        expiresAt: data?.expiresAt || null,
        message: `✅ 已登录为「${info.nick_name}」，有效期至 ${data?.expiresAt ? new Date(data.expiresAt).toLocaleString('zh-CN') : '未知'}`
      };
    }
    return { valid: false, account: '', expiresAt: null, message: 'session 已过期（无法获取账号信息）' };
  } catch (e) {
    return { valid: false, account: '', expiresAt: null, message: `session 检查失败: ${e.message}` };
  }
}

/**
 * 代理请求到 mp.weixin.qq.com
 */
export async function proxyMpRequest({ method, endpoint, query, body, cookie, parseJson }) {
  // 自动加载已存储的 cookies（如果没有显式传入）
  if (!cookie) {
    const auth = getAuth();
    if (auth) cookie = auth.cookie;
  }

  const url = new URL(query ? endpoint + '?' + new URLSearchParams(query).toString() : endpoint);
  const headers = {
    'Referer': 'https://mp.weixin.qq.com/',
    'Origin': 'https://mp.weixin.qq.com',
    'User-Agent': USER_AGENT,
  };
  if (cookie) headers['Cookie'] = cookie;

  const fetchOpts = { method, headers, redirect: 'follow' };
  if (method === 'POST' && body) {
    fetchOpts.body = new URLSearchParams(body).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const mpResponse = await fetch(url.toString(), fetchOpts);
  const setCookies = mpResponse.headers.getSetCookie();

  if (parseJson) {
    return mpResponse.json();
  }

  const rawBuf = Buffer.from(await mpResponse.arrayBuffer());
  return {
    ok: mpResponse.ok,
    status: mpResponse.status,
    headers: Object.fromEntries(mpResponse.headers),
    body: rawBuf,
    isBinary: mpResponse.headers.get('content-type')?.startsWith('image/') || false,
    setCookies,
  };
}

/**
 * 搜索公众号
 */
export async function searchBiz(keyword, { begin = '0', count = '10' } = {}) {
  const auth = getAuth();
  if (!auth) return { ret: -1, msg: '未登录' };

  const params = {
    action: 'search_biz', begin, count, query: keyword,
    token: auth.token, lang: 'zh_CN', f: 'json', ajax: '1',
  };

  return proxyMpRequest({
    method: 'GET',
    endpoint: 'https://mp.weixin.qq.com/cgi-bin/searchbiz',
    query: params,
    cookie: auth.cookie,
    parseJson: true,
  });
}

/**
 * 获取公众号文章列表
 */
export async function getArticleList(fakeid, { keyword, begin = '0', size = '5' } = {}) {
  const auth = getAuth();
  if (!auth) return { ret: -1, msg: '未登录' };

  const isSearching = !!keyword;
  const params = {
    sub: isSearching ? 'search' : 'list',
    search_field: isSearching ? '7' : 'null',
    begin, count: size,
    query: keyword || '',
    fakeid,
    type: '101_1',
    free_publish_type: '1',
    sub_action: 'list_ex',
    token: auth.token, lang: 'zh_CN', f: 'json', ajax: '1',
  };

  const resp = await proxyMpRequest({
    method: 'GET',
    endpoint: 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish',
    query: params,
    cookie: auth.cookie,
    parseJson: true,
  });

  if (resp.base_resp?.ret === 0 && resp.publish_page) {
    const publish_page = JSON.parse(resp.publish_page);
    const articles = (publish_page.publish_list || [])
      .filter(item => item.publish_info)
      .flatMap(item => JSON.parse(item.publish_info).appmsgex || [])
      .map(a => ({
        ...a,
        create_time: typeof a.create_time === 'number' ? a.create_time : parseInt(a.create_time),
        update_time: typeof a.update_time === 'number' ? a.update_time : parseInt(a.update_time),
      }));
    return { ret: 0, articles };
  }
  return resp;
}

/**
 * 获取公众号常规文章列表（正确接口）
 * 使用 appmsg API 替代 appmsgpublish（后者只返回免费发布文章）
 */
export async function getRegularArticles(fakeid, { begin = '0', size = '10' } = {}) {
  const auth = getAuth();
  if (!auth) return { ret: -1, msg: '未登录' };

  const query = `action=list_ex&begin=${begin}&count=${size}&fakeid=${encodeURIComponent(fakeid)}&type=9&token=${auth.token}&lang=zh_CN&f=json&ajax=1`;

  const resp = await proxyMpRequest({
    method: 'POST',
    endpoint: 'https://mp.weixin.qq.com/cgi-bin/appmsg',
    query: {
      action: 'list_ex', begin, count: size,
      fakeid, type: '9',
      token: auth.token, lang: 'zh_CN', f: 'json', ajax: '1',
    },
    cookie: auth.cookie,
    body: query,
    parseJson: true,
  });

  if (resp.app_msg_list && Array.isArray(resp.app_msg_list)) {
    return {
      ret: 0,
      articles: resp.app_msg_list.map(a => ({
        ...a,
        create_time: typeof a.create_time === 'number' ? a.create_time : parseInt(a.create_time || '0'),
      })),
      total: parseInt(resp.app_msg_cnt || '0'),
    };
  }
  return resp;
}

/**
 * 下载文章 HTML
 */
export async function downloadArticle(url) {
  const auth = getAuth();
  if (!auth) return null;

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': 'https://mp.weixin.qq.com/',
      'Cookie': auth.cookie,
    },
  });
  return response.text();
}

/**
 * 获取登录用户信息
 */
export async function getAccountInfo() {
  const auth = getAuth();
  if (!auth) return { error: '未登录' };

  const html = await proxyMpRequest({
    method: 'GET',
    endpoint: 'https://mp.weixin.qq.com/cgi-bin/home',
    query: { t: 'home/index', token: auth.token, lang: 'zh_CN' },
    cookie: auth.cookie,
  }).then(r => r.body.toString());

  const nickMatch = html.match(/wx\.cgiData\.nick_name\s*=\s*"([^"]+)"/);
  const headMatch = html.match(/wx\.cgiData\.head_img\s*=\s*"([^"]+)"/);
  return {
    nick_name: nickMatch ? nickMatch[1] : '',
    head_img: headMatch ? headMatch[1] : '',
  };
}
