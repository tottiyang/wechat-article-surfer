import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '.data');
const COOKIE_FILE = join(DATA_DIR, 'wechat-cookies.json');

// ========== 固定 Cookie 存储（单用户） ==========

export function saveCookies(token, cookies) {
  mkdirSync(DATA_DIR, { recursive: true });
  const data = {
    token,
    cookies,
    createdAt: Date.now(),
    expiresAt: Date.now() + 4 * 24 * 60 * 60 * 1000,
  };
  writeFileSync(COOKIE_FILE, JSON.stringify(data, null, 2));
  return data;
}

export function loadCookies() {
  if (!existsSync(COOKIE_FILE)) return null;
  try {
    const raw = readFileSync(COOKIE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data.expiresAt && Date.now() > data.expiresAt) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// ========== Cookie 字符串工具 ==========

export function cookiesToString(parsedCookies) {
  return parsedCookies
    .filter(c => c.value && c.value !== 'EXPIRED')
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

export function parseSetCookies(setCookieArr) {
  const cookieMap = new Map();
  for (const cookieStr of setCookieArr) {
    const parts = cookieStr.split(';').map(s => s.trim());
    const [nameValue] = parts;
    if (!nameValue) continue;
    const eqIdx = nameValue.indexOf('=');
    const name = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();
    if (!name) continue;
    const entry = { name, value };
    for (const part of parts.slice(1)) {
      const eqIdx2 = part.indexOf('=');
      if (eqIdx2 === -1) {
        entry[part.toLowerCase()] = true;
      } else {
        entry[part.slice(0, eqIdx2).toLowerCase()] = part.slice(eqIdx2 + 1).trim();
      }
    }
    cookieMap.set(name, entry);
  }
  return Array.from(cookieMap.values());
}
