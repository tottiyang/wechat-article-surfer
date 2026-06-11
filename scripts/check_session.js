/**
 * check_session.js — 检查微信登录 session 状态
 * 使用 src/proxy.js 的 checkSession() 进行可靠验证
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { checkSession } = await import(join(ROOT, 'src/proxy.js'));

const result = await checkSession();
console.log(`valid: ${result.valid}`);
console.log(`account: ${result.account || '(none)'}`);
console.log(`message: ${result.message}`);

process.exit(result.valid ? 0 : 1);
