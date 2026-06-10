import { readFileSync, writeFileSync } from "fs";

const data = JSON.parse(readFileSync(".data/wechat-cookies.json", "utf-8"));
const cookieStr = (data.cookies || [])
  .filter(c => c.value !== "EXPIRED")
  .map(c => `${c.name}=${c.value}`)
  .join("; ");

console.log("Current token:", data.token);
console.log("Cookie count:", (data.cookies || []).filter(c => c.value !== "EXPIRED").length);

// Try home page first
const resp = await fetch("https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=" + data.token, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Cookie": cookieStr,
    "Referer": "https://mp.weixin.qq.com/",
  }
});
const html = await resp.text();
console.log("Status:", resp.status);
console.log("URL:", resp.url);
console.log("HTML length:", html.length);

if (html.includes("login") || html.includes("login")) {
  console.log("⚠️ 需要重新登录");
}
if (html.includes("accesstoken")) {
  const m = html.match(/accesstoken\s*[:=]\s*["']?\s*(\d+)/);
  console.log("Access token found:", m ? m[1] : "none");
}
// Try to find any token in the page
const tokens = [...html.matchAll(/token["'=\s]+(\d+)/g)];
console.log("Tokens found:", tokens.slice(0, 5).map(t => t[1]));
