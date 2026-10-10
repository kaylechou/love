// 团契智学系统 · Cloudflare Worker
// 功能：学员智能互动学习（自动识别章节与题型）、管理端、短链分享、视频、成绩、公告、批量导入
// 数据：D1（courses / progress / settings），绑定名 env.DB

/* ============ 纯函数：答案判定（服务端判分用，与旧客户端逻辑一致） ============ */
function normStr(s) {
return String(s == null? "": s).replace(/[\s　，,。、；;：:！!？?""''「」『』（）()\[\]·…—\-]/g, "").toUpperCase();
}
function isFillLike(q) {
return /_{2,}|＿{2,}|（\s*）|\(\s*\)/.test(q.q || "");
}
var MBSEP = String.fromCharCode(1); /* 课件多空格题：各空答案在提交时用此分隔符连接 */
function checkAnswer(q, u) {
var uu = normStr(u);
if (q.type === 'single' || q.type === 'judge') {
var aa = normStr(q.a);
return uu!== "" && (uu === aa || aa.indexOf(uu) === 0);
}
if (q.type === 'multiple') {
/* 多选：顺序无关；少选、多选、错选都算错；每个已选项不可重复对应同一答案 */
var aa = String(q.a || "").split(/[、；;，,\\/|｜]/).map(normStr).filter(function (x) { return x!== "";});
if (aa.length === 0) return false;
var ua = String(u == null? "": u).split(/[、；;，,\\/|｜]/).map(normStr).filter(function (x) { return x!== "";});
var seen = {}, uniq = [];
ua.forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; uniq.push(x);}});
if (uniq.length !== aa.length) return false;
var used = [];
for (var ui = 0; ui < uniq.length; ui++) {
var hit = -1;
for (var ai = 0; ai < aa.length; ai++) {
if (used.indexOf(ai) >= 0) continue;
if (uniq[ui] === aa[ai] || (aa[ai].length >= 2 && aa[ai].indexOf(uniq[ui]) === 0)) { hit = ai; break; }
}
if (hit < 0) return false;
used.push(hit);
}
return true;
}
if (q.type === 'fill' || q.type === 'verse' || (q.type === 'essay' && isFillLike(q))) {
var rawU = String(u == null ? "" : u);
/* 填空答案两级分隔：先用 | ｜ ； 分各空（按题干空格顺序对应）；每空内部用 / ／ 或 、 ， ; \\ 分多个可接受答案，答中任意一个即正确 */
var groups = String(q.a || "").split(/[|｜；]/).map(function (g) {
return String(g).split(/[\/／、，,;\\或]/).map(normStr).filter(function (x) { return x!== "";});
}).filter(function (g) { return g.length > 0;});
if (q.type === 'verse' && groups.length === 0) return null; /* 经文框未设答案：开放性 */
if (groups.length === 0) return false;
function hitAlt(uu, alts) {
if (uu === "") return false;
for (var k = 0; k < alts.length; k++) {
if (uu === alts[k]) return true;
if (alts[k].length >= 2 && uu.indexOf(alts[k]) >= 0) return true;
}
return false;
}
/* 多空格题：各空答案用 MBSEP 连接提交；第 i 空命中第 i 组的任意一个备选即正确 */
if (rawU.indexOf(MBSEP) >= 0) {
var parts = rawU.split(MBSEP);
var glist = groups;
/* 兼容旧数据：答案中没写分空符、但备选个数恰好等于空格数时，按旧逻辑逐空顺序对应（如 上帝/创造主） */
if (glist.length === 1 && parts.length > 1 && glist[0].length === parts.length) {
glist = glist[0].map(function (x) { return [x];});
}
if (parts.length !== glist.length) return false;
for (var pi = 0; pi < parts.length; pi++) {
if (!hitAlt(normStr(parts[pi]), glist[pi])) return false;
}
return true;
}
/* 单空格题：命中任意一组的任意一个备选即正确 */
var uu = normStr(rawU);
if (uu === "") return false;
for (var gi = 0; gi < groups.length; gi++) {
if (hitAlt(uu, groups[gi])) return true;
}
return false;
}
return null; /* 纯问答题：开放性，不自动判定对错 */
}

async function sha256hex(s) {
const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function json(data, status, headers) {
return new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) });
}
/* 去掉题目答案（发给非管理员） */
function stripAnswers(courses) {
return (courses || []).map(c => {
let qs = [];
try { qs = JSON.parse(c.quizzes_json || "[]");} catch (e) {}
qs = qs.map(q => ({ type: q.type, q: q.q, o: q.o, s: q.s, h: q.h }));
const nc = Object.assign({}, c);
nc.quizzes_json = JSON.stringify(qs);
return nc;
});
}
/* 首页列表精简字段：去掉题库/导读/说明（体积约为完整数据的 1/10），卡片与搜索只用 content */
function briefCourse(c) {
return { id: c.id, category: c.category, subcategory: c.subcategory, title: c.title, content: c.content, video_url: c.video_url, mode: c.mode, sort_order: c.sort_order, created_at: c.created_at, i18n_json: c.i18n_json || '' };
}
async function getSetting(env, key) {
try {
const r = await env.DB.prepare("SELECT value FROM settings WHERE key =?").bind(key).all();
const rows = (r && r.results) || [];
return rows.length? rows[0].value: null;
} catch (e) { return null;}
}
async function setSetting(env, key, val) {
await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)").bind(key, val).run();
}
async function getPwHash(env) {
let h = await getSetting(env, "admin_pw_hash");
if (!h) { h = await sha256hex("777777"); await setSetting(env, "admin_pw_hash", h);}
return h;
}
async function adminToken(env) {
return await sha256hex("tq-admin:" + await getPwHash(env));
}
async function isAdminReq(request, env) {
const cookie = request.headers.get("Cookie") || "";
const m = cookie.match(/(?:^|;\s*)tq_admin=([a-f0-9]{64})/);
if (!m) return false;
return m[1] === await adminToken(env);
}
function adminCookie(token) {
return "tq_admin=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure";
}
function clearAdminCookie() {
return "tq_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure";
}
async function nextSortOrder(env) {
const r = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM courses").all();
const rows = (r && r.results) || [];
return (rows[0]? rows[0].m: 0) + 1;
}
async function orderedCourses(env) {
const r = await env.DB.prepare("SELECT * FROM courses ORDER BY sort_order ASC, category ASC, subcategory ASC, created_at DESC").all();
return (r && r.results) || [];
}

async function migrate(env) {
const db = env.DB;
try { await db.prepare("ALTER TABLE courses ADD COLUMN video_url TEXT").run();} catch (e) {}
try { await db.prepare("ALTER TABLE courses ADD COLUMN guide_json TEXT").run();} catch (e) {}
try { await db.prepare("ALTER TABLE courses ADD COLUMN instructions TEXT").run();} catch (e) {}
try { await db.prepare("ALTER TABLE courses ADD COLUMN mode TEXT DEFAULT 'quiz'").run();} catch (e) {}
try { await db.prepare("ALTER TABLE courses ADD COLUMN sort_order INTEGER DEFAULT 0").run();} catch (e) {}
await db.prepare("CREATE TABLE IF NOT EXISTS progress (username TEXT, course_id TEXT, score TEXT)").run();
try { await db.prepare("ALTER TABLE progress ADD COLUMN submitted_at TEXT").run();} catch (e) {}
try { await db.prepare("ALTER TABLE progress ADD COLUMN course_title TEXT").run();} catch (e) {}
await db.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)").run();
await db.prepare("CREATE TABLE IF NOT EXISTS students (username TEXT PRIMARY KEY, pw_hash TEXT, created_at TEXT)").run();
try { await db.prepare("ALTER TABLE students ADD COLUMN is_admin INTEGER DEFAULT 0").run(); } catch (e) {}
await db.prepare("CREATE TABLE IF NOT EXISTS wrongs (username TEXT, course_id TEXT, course_title TEXT, series TEXT, sub TEXT, qtype TEXT, qnum TEXT, question TEXT, user_answer TEXT, correct_answer TEXT, submitted_at TEXT)").run();
await db.prepare("CREATE INDEX IF NOT EXISTS idx_wrongs_user ON wrongs(username, course_id)").run();
await db.prepare("CREATE INDEX IF NOT EXISTS idx_progress_user ON progress(username, course_id)").run();
/* 系列/子栏目：parent 为空=系列，非空=该系列下的子栏目；(parent, name) 联合主键 */
await db.prepare("CREATE TABLE IF NOT EXISTS categories (parent TEXT DEFAULT '', name TEXT, description TEXT DEFAULT '', created_at TEXT DEFAULT '', PRIMARY KEY (parent, name))").run();
try { await db.prepare("ALTER TABLE categories ADD COLUMN parent TEXT DEFAULT ''").run();} catch (e) {}
/* 兼容此前单级 categories 表（name 单主键）：检测到旧结构则重建为两级 */
try {
const ci = await db.prepare("SELECT sql FROM sqlite_master WHERE name='categories'").all();
const csql = ((((ci || {}).results) || [])[0] || {}).sql || "";
if (csql && !/PRIMARY KEY\s*\(\s*parent/i.test(csql)) {
await db.prepare("ALTER TABLE categories RENAME TO categories_old").run();
await db.prepare("CREATE TABLE categories (parent TEXT DEFAULT '', name TEXT, description TEXT DEFAULT '', created_at TEXT DEFAULT '', PRIMARY KEY (parent, name))").run();
await db.prepare("INSERT OR IGNORE INTO categories (parent, name, description, created_at) SELECT '', name, description, created_at FROM categories_old").run();
await db.prepare("DROP TABLE categories_old").run();
}
} catch (e) {}
try { await db.prepare("ALTER TABLE courses ADD COLUMN subcategory TEXT DEFAULT ''").run();} catch (e) {}
const v = await getSetting(env, "schema_v2");
if (!v) {
try { await db.prepare("UPDATE courses SET sort_order = rowid WHERE sort_order IS NULL OR sort_order = 0").run();} catch (e) {}
await setSetting(env, "schema_v2", "1");
}
await getPwHash(env); // 首次运行时写入默认密码哈希（请尽快在管理端修改）
}


/* ============ PWA：Web App Manifest / Service Worker / 图标（Android WebAPK + iOS 添加到主屏幕） ============ */
const PWA_ICON_192 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAACeklEQVR42u3dy00DMRSG0fiKOkIfoZhQGlMM0wdTCTs2IDH29TwSn7PmITKffhuBoFz2db3dL2xsmafdPldRjJ7OGJBuBimpSEdGpwhIN2OWVKQjo8y7h3oGl3yCRTpkpijUQ+aZhnrIPNkiHTLHWaiHzLMO9ZB54qEeMs891EPm6Yd6yDQQXiAywvyQGaFQD5mGQj1kGnIHovcdyPywfoRCPWQacoTR7wgzP9SOkAWi9yUaWgJyftFwilkgeiyQ+aFthCwQLtEcpzi/sEAICAEhIKgMyA0aC4SAEBACgjovI3yRX58fh3ze17d3CwQCQkAICAGBgBAQAkJAICBSykP8PtBRP4s41kP8JMQCISAEhIAQEAgIASEgBAQCQkAICAGBgBAQAkJAICAEhIAQEAICASEgBISAQEAICAEhIBAQAkJACAgEhIAQEAJCQNCsjPB/4/3LSwuEgBAQCAgBISAEBAJCQAgIASEgEBACQkAICASEgBAQAgIBISAEhIBAQAgIASEgBAQCQkAICAGBgBAQAkJAICAEhIAQEAgIASEgBISAQEAICAEhIBAQAkJACAgEhIA4q3K93b0KWCAEhIAQEAiI3QJa5smrgAVCQAgIAUFlQO7RtFnmyQLhCOPwgJxiNJxfFoh+R5gRonZ+LBAu0ZwnIKcYVeeXBaL3EWaEWD8/fy+QhlhZjyOMbb4LM0KsrCKq3hr1VBxhGuLfEtyB2OAOZIRY2UAk35+R61l7hGlIPdk7kIbUk71Ea0g9v5WGj+5vUkkn9W28KVJPKiANqSd1hDnOpJNdIFOknj4LZIqGTadzQEoaqpsNA5LRIOlsG5CSnrubH98wGZ7fHfIHsQAAAABJRU5ErkJggg==";
const PWA_ICON_512 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAInklEQVR42u3c7U0bQRSG0Z1R6jB9mGJMaVAM9AGV5AcSQoQgMPtxZ95zCgj2RLrP3N2EtnCt0/niEKCCl6cHh3CF5ggMehAGAcDEBz0QABMf0AMBMPcBJRAAQx8QAwEw9wElEACjH5ABATD3ASUQAKMfkAEBMPcBJRAAox+QAQEw+gEZEACjH5CB/XXTHyBzLjVHDJC5CgwTAKMfkIF1jfEIyPQHxjLE1GoOESBzFagbAKMfkIFNFX0EZPoDM6k507qTAsicbM0BAeypzuOgQhuA6Q9YBRIDYPoDGrCz5iAAjnLs46CDNwDTH7AKJAbA9Ac4cBL2wO8MoAGHBcD0Bzh8KraELwkwij1fC++6AZj+AHXmZJ/yWwFoQJUAmP4A1WZmn+abAGhArQCY/gA152cf+tMDaEDFAJj+AJVnaXe4AJm2CoDrP0DxidoH+qwAGlA6AKY/wBAN6MU/HwAbzdhe9pMBsOmk9a+AAEKtFgDXf4CxloBe6tMAsNvU7UU+BwA7z17vAABC/TYArv8Agy4B/cCfDcCBDeiH/FQADm+AdwAAoa4MgOs/wOhLgA0AwAbg+g+QtAT0HX4GAAUb4BEQQKifBcD1H2CaJcAGAGADcP0HSFoC+up/IgBDNMAjIIBQ3wqA6z/AfEuADQDABuD6D5C0BNgAAGwArv8ASUuADQDABgCAAHxndwCgvi8muQ0AwAbg+g+QtATYAABsAAAIgOc/ADP5dKrbAABsAK7/AElLgA0AwAYAQHIAPP8BmNWHCW8DALABACAAAGQFwAsAgLm9n/M2AAAbAACZAfD8ByDB27S3AQDEbwAACAAAAgDA3AHwBhggx+vMtwEAZG8AAAgAAAIAwLza4g0wgA0AAAEAQAAAEAAABAAAAQBAAAAYJgD+EwCADQAAAQBAAAAQAAAEAAABAGBEfxwBW3t+vHcIV7i5vXMI2AAAEAAABAAAAQBAAAAQAAAEAAABAEAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAIBPtdP54hQG9fx47xA43M3tnUOwAQAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAAbKqdzhenwKaeH+8dwhVubu8cAjYAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAABcAQAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACACAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACACAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgAgAAAIAAACAMCs2ul8cQoANgAABAAAAQBAAAAQAAAEAAABAGCQALw8PTgFABsAAAIAgAAAIAAACAAAAgCAAAAwTgD8VwCANC9PDzYAgOANAAABAEAAAEgIgPfAADleZ74NACB7AwBAAAAQAAASAuA9MECCt2lvAwCI3wAAyA2Ap0AAc3s/520AADYAAAQAgLgAeA0AMKsPE94GAGADACA8AJ4CAczn39luAwCwAVgCAGKu/zYAABsAAALwxb4AwHD+N89tAAA2AEsAQMz13wYAYAMAQAC+uTsAUNzXM9wGAGADsAQAxFz/bQAANgBLAEDS9d8GAGADsAQAJF3/f7YBaADANNN/8QgIINbPAmAJAJjj+m8DALABWAIAkq7/V24AGgAw+vRfPAICiHVlACwBAENf/20AADYASwBA0vX/txuABgAMOv2X3z8C0gCAEaf/4h0AQKwVAmAJABju+r/aBqABAGNN/2XFR0AaADDQ9F+8AwCItWYALAEAo1z/198ANABgiOm/bPEISAMA6k//ZaN3ABoAUH+u9oE+K4DpP0AAAChuwwBYAgAqz9I+6OcGMP1LB0ADAMrOzz7BdwAw/YsGQAMACs7MPtn3ATD9ywVAAwBKzcl2yDc8nS/+mgGOvSL3kO8JYPqXCIAGABw+D3vgdwYw/ZfDfxeQBgCm/1FakVPwWhgw+rM2AKsAYPqnB0ADANN/Z63g6XgcBBj9WRuAVQAw/dMDoAGA6b+DVvzUPA4CjP7QAMgAYPRvpDtHgMyp1cY6U6sAYPSHBkAGAKN/Ld0pA2TOpTb0iVsFAKM/NAAyABj90QGQAcDojw6AEgDmfnoAZAAw+qMDoASAuZ8eABkAjP7oACgBYO6nB0AMgOShLwBKAPidAgKgB2DiCwB6ACZ+lL8R6Z1UxsvpvgAAAABJRU5ErkJggg==";
const PWA_ICON_180 = "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAACV0lEQVR42u3d7U3DMBSG0dhiDtgDhoHRyDBkDzJJ/6GSUhrnw2l9zzMACDh6b4pATV2Vnl/fO23aOPR7f4oEBCj1cDDRjJLEBCU74sCiVSIJC0SulclovsU/qYSFCdlsOciIMyGZDD7WnhUsAp6YTIYJWY6DjLA+Mhl8bPZqRXHKZsN4FOMgg49Mhq79xD1zqOSZw2wYj79xkMGHs6LCs2I2dG7AcmjGcpgNTSRYDpW8lJV+4XBTdHlZLIecFZWX3BRZDsEhOFQDhwcOWQ7BITgEh47sqdUv7Pvrs+ane3n7sBxyViQ4BIfgEByCQ3AIDsGhdkr3/PcclX8Ffkj3/Ht3yyE4BIfgEByCQ3AIDsEhOASHBIfgEByCQ3AIDsEhOASH4JDgEByCQ3AIDsEhOASH4BAcEhyCQ3AIDsGhY0utvgGg91uxHIJDcAgOwSE4BIfgkOAQHIJDcAgOwSE4BIfgEBwSHIJDcAgOwSE4BIfgEByCQ3BIcAgOwSE4BIfgEByCQ3AIDgkOwSE4BIfgEByCQ3AIDsEhwSE4BIfgUJWafXdIWQ7BITgEh+DQo+MYh953QZZDcAgO1cDhsUOXjUNvOeSsaDEOl0WTm2I55KxoJQ6XRRMJlkPzzorx0LkBy6HZD6TGw2z8txx8kOGsqPCsGA+zcXs5+Agu48ZZ4SOyDM8cKn/mMB5mY9Zy8BFTxtyzwkdAGV3XpaKP6F/yg7BY8kBqQuLIWPJqhY8gMorPihMThMXC5TAhQWSsWg4T0jCLzXAg0h6LjXFQ0oyJHXFQ8ugmfjoBBzSSx5xwCJsAAAAASUVORK5CYII=";
const PWA_SW_JS = "self.addEventListener('install',function(e){self.skipWaiting()});self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});self.addEventListener('fetch',function(e){/* 直通网络，不缓存页面，保证内容永远最新 */});";
function pwaIconResponse(b64) {
const bin = atob(b64);
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" } });
}
function pwaManifest() {
return {
name: "团契智学", short_name: "团契智学", description: "团契互动课件与答题系统",
start_url: "/", scope: "/", display: "standalone", orientation: "portrait",
background_color: "#ffffff", theme_color: "#1e3a5f",
icons: [
{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
]
};
}

export default {
async fetch(request, env) {
const { pathname, searchParams} = new URL(request.url);
const shareId = searchParams.get('id');

try {
if (!env.DB) return new Response("数据库未绑定", { status: 500});
await migrate(env);
await migratePaths(env);
await migrateSocial(env);
const authed = await isAdminReq(request, env);

// P1/P2 新模块路由：学习路径+证书 / 班级+徽章+统计
const pr = await handlePathsApi(pathname, searchParams, request, env, authed, json);
if (pr) return pr;
const sr = await handleSocialApi(pathname, searchParams, request, env, authed, json);
if (sr) return sr;

// API: 获取全部课程（非管理员拿不到答案；?brief=1 只返回列表精简字段）
if (pathname === "/api/data") {
const list = await orderedCourses(env);
const isBrief = searchParams.get("brief") === "1";
let out = authed? list: stripAnswers(list);
if (isBrief && !authed) out = out.map(briefCourse);
const cc = authed? "no-store, no-cache, must-revalidate": "public, max-age=60";
return json(out, 200, { "Cache-Control": cc });
}

// API: 取单门课程完整内容（学员点开课件时按需加载；非管理员拿不到答案）
if (pathname === "/api/course") {
const cid = searchParams.get("id") || "";
const crs = await env.DB.prepare("SELECT * FROM courses WHERE id =?").bind(cid).all();
const crows = (crs && crs.results) || [];
if (!crows.length) return new Response("NOT_FOUND", { status: 404 });
const one = authed? crows[0]: stripAnswers(crows)[0];
const cc = authed? "no-store, no-cache, must-revalidate": "public, max-age=60";
return json(one, 200, { "Cache-Control": cc });
}

// API: 圣经经文（公开）：/api/bible?ref=《罗马书》1章20节 -> {ref, niv, kjv}
if (pathname === "/api/bible") {
const ref = (searchParams.get("ref") || "").trim();
if (!ref) return json({ error: "missing ref" }, 400);
const br = await env.DB.prepare("SELECT ref, niv, kjv FROM bible_verses WHERE ref=?").bind(ref).all();
const brows = (br && br.results) || [];
if (!brows.length) return json({ ref: ref, niv: "", kjv: "" }, 200, { "Cache-Control": "public, max-age=3600" });
return json(brows[0], 200, { "Cache-Control": "public, max-age=3600" });
}

// API: 保存课程（管理员）
if (pathname === "/api/save" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json();
const qJson = JSON.stringify(b.quizzes || []);
const gJson = JSON.stringify(Array.isArray(b.guide) ? b.guide : []);
const mode = b.mode === "study"? "study": "quiz";
const cat = b.category || "默认", sub = ((b.subcategory || "") + "").trim().replace(/\+/g, "\u2022");
if (b.id && b.id.length > 5) {
await env.DB.prepare("UPDATE courses SET category=?, subcategory=?, title=?, content=?, quizzes_json=?, video_url=?, mode=?, guide_json=?, instructions=?, updated_at=? WHERE id=?")
.bind(cat, sub, b.title, b.content, qJson, b.video_url || "", mode, gJson, b.instructions || "", new Date().toISOString(), b.id).run();
} else {
const so = await nextSortOrder(env);
await env.DB.prepare("INSERT INTO courses (id, category, subcategory, title, content, quizzes_json, video_url, mode, guide_json, instructions, sort_order, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
.bind("ID-" + Date.now(), cat, sub, b.title, b.content, qJson, b.video_url || "", mode, gJson, b.instructions || "", so, new Date().toISOString()).run();
}
// 课程的系列/子栏目自动登记（简介为空，管理端后续补填即可）
await env.DB.prepare("INSERT OR IGNORE INTO categories (parent, name) VALUES (?,?)").bind("", cat).run();
if (sub) await env.DB.prepare("INSERT OR IGNORE INTO categories (parent, name) VALUES (?,?)").bind(cat, sub).run();
return json({ success: true});
}

// API: 删除课程（管理员）
if (pathname === "/api/delete" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json();
await env.DB.batch([
env.DB.prepare("DELETE FROM courses WHERE id =?").bind(b.id),
env.DB.prepare("DELETE FROM progress WHERE course_id=?").bind(b.id),
env.DB.prepare("DELETE FROM wrongs WHERE course_id=?").bind(b.id),
]);
return json({ success: true});
}

// API: 批量导入课程（管理员）
if (pathname === "/api/import" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json();
const arr = Array.isArray(b.courses)? b.courses: (b.category? [b]: []);
let n = 0, so = await nextSortOrder(env);
for (const c of arr) {
if (!c ||!c.title) continue;
const qs = Array.isArray(c.quizzes)? c.quizzes: [];
await env.DB.prepare("INSERT INTO courses (id, category, subcategory, title, content, quizzes_json, video_url, mode, guide_json, instructions, sort_order, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
.bind("ID-" + Date.now() + "-" + n, c.category || "默认", ((c.subcategory || "") + "").trim(), c.title, c.content || "", JSON.stringify(qs), c.video_url || "", c.mode === "study"? "study": "quiz", JSON.stringify(Array.isArray(c.guide) ? c.guide : []), c.instructions || "", so + n, new Date().toISOString()).run();
await env.DB.prepare("INSERT OR IGNORE INTO categories (parent, name) VALUES (?,?)").bind("", c.category || "默认").run();
const csub = ((c.subcategory || "") + "").trim();
if (csub) await env.DB.prepare("INSERT OR IGNORE INTO categories (parent, name) VALUES (?,?)").bind(c.category || "默认", csub).run();
n++;
}
return json({ success: true, imported: n});
}

// API: 课程排序（管理员）
if (pathname === "/api/reorder" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json();
const list = await orderedCourses(env);
const idx = list.findIndex(r => r.id === b.id);
const j = b.dir === "up"? idx - 1: idx + 1;
if (idx >= 0 && j >= 0 && j < list.length) {
const a = list[idx], c = list[j], sa = a.sort_order, sc = c.sort_order;
await env.DB.prepare("UPDATE courses SET sort_order=? WHERE id=?").bind(sc, a.id).run();
await env.DB.prepare("UPDATE courses SET sort_order=? WHERE id=?").bind(sa, c.id).run();
}
return json({ success: true});
}

// API: 系列/子栏目树（公开）：[{name, description, count, totalCount, subs:[{name, description, count}]}]
// count = 直接归属该系列（无子栏目）的课程数；totalCount = 含子栏目在内的总数
if (pathname === "/api/categories") {
const cr = await env.DB.prepare("SELECT parent, name, description, i18n_json FROM categories ORDER BY parent ASC, name ASC").all();
const rows = (cr && cr.results) || [];
const cc = await env.DB.prepare("SELECT category, subcategory, COUNT(*) AS n FROM courses GROUP BY category, subcategory").all();
const seriesMap = {};
function getSeries(nm) {
if (!seriesMap[nm]) seriesMap[nm] = { name: nm, description: "", count: 0, subs: [], _subIdx: {}, i18n: null };
return seriesMap[nm];
}
rows.forEach(r => {
const parent = r.parent || "";
if (!parent) {
const s = getSeries(r.name);
if (r.description) s.description = r.description;
try { if (r.i18n_json) s.i18n = JSON.parse(r.i18n_json); } catch (e) {}
} else {
const s = getSeries(parent);
if (!s._subIdx[r.name]) { s._subIdx[r.name] = { name: r.name, description: r.description || "", count: 0, i18n: null }; s.subs.push(s._subIdx[r.name]); }
else if (r.description) s._subIdx[r.name].description = r.description;
try { if (r.i18n_json) s._subIdx[r.name].i18n = JSON.parse(r.i18n_json); } catch (e) {}
}
});
((cc && cc.results) || []).forEach(r => {
const cat = r.category || "默认", sub = r.subcategory || "";
const s = getSeries(cat);
if (!sub) { s.count += r.n; return; }
if (!s._subIdx[sub]) { s._subIdx[sub] = { name: sub, description: "", count: 0 }; s.subs.push(s._subIdx[sub]); }
s._subIdx[sub].count += r.n;
});
const out = Object.keys(seriesMap).sort().map(k => {
const s = seriesMap[k];
s.subs.sort((a, b) => String(a.name).localeCompare(String(b.name)));
const total = s.count + s.subs.reduce((t, x) => t + x.count, 0);
return { name: s.name, description: s.description, count: s.count, totalCount: total, subs: s.subs, i18n: s.i18n || null };
});
return json(out, 200, { "Cache-Control": "public, max-age=60" });
}

// API: 保存系列/子栏目（管理员）
// parent 为空=系列；非空=该系列下的子栏目。改名时同步更新课程与子栏目的归属
if (pathname === "/api/category/save" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json();
var name = ((b.name || "") + "").trim().replace(/\+/g, "\u2022");
if (!name) return json({ error: "名称不能为空"}, 400);
const desc = ((b.description || "") + "").trim();
const oldName = ((b.oldName || "") + "").trim();
const parent = ((b.parent || "") + "").trim();
const now = new Date().toISOString();
async function upsert(p, n, d) {
await env.DB.prepare("INSERT INTO categories (parent, name, description, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(parent, name) DO UPDATE SET description=excluded.description, updated_at=excluded.updated_at").bind(p, n, d, now, now).run();
}
if (!parent) {
if (oldName && oldName !== name) {
await env.DB.prepare("UPDATE courses SET category=? WHERE category=?").bind(name, oldName).run();
await env.DB.prepare("UPDATE categories SET parent=? WHERE parent=?").bind(name, oldName).run();
await upsert("", name, desc);
await env.DB.prepare("DELETE FROM categories WHERE parent='' AND name=?").bind(oldName).run();
} else {
await upsert("", name, desc);
}
} else {
if (oldName && oldName !== name) {
await env.DB.prepare("UPDATE courses SET subcategory=? WHERE category=? AND subcategory=?").bind(name, parent, oldName).run();
await upsert(parent, name, desc);
await env.DB.prepare("DELETE FROM categories WHERE parent=? AND name=?").bind(parent, oldName).run();
} else {
await upsert(parent, name, desc);
}
}
return json({ success: true});
}

// API: 删除系列/子栏目（管理员）
// 系列：旗下有课程或有子栏目时拒绝；子栏目：旗下有课程时拒绝（请先移走课程）
if (pathname === "/api/category/delete" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json();
const name = ((b.name || "") + "").trim();
const parent = ((b.parent || "") + "").trim();
async function cnt(sql, args) {
const cc = await env.DB.prepare(sql).bind(...args).all();
return (((cc && cc.results) || [])[0] || {}).n || 0;
}
if (!parent) {
const n = await cnt("SELECT COUNT(*) AS n FROM courses WHERE category=?", [name]);
if (n > 0) return json({ error: "该系列下还有 " + n + " 门课程，请先移走课程后再删除系列"}, 400);
const sn = await cnt("SELECT COUNT(*) AS n FROM categories WHERE parent=?", [name]);
if (sn > 0) return json({ error: "该系列下还有 " + sn + " 个子栏目，请先删除子栏目"}, 400);
await env.DB.prepare("DELETE FROM categories WHERE parent='' AND name=?").bind(name).run();
} else {
const n = await cnt("SELECT COUNT(*) AS n FROM courses WHERE category=? AND subcategory=?", [parent, name]);
if (n > 0) return json({ error: "该子栏目下还有 " + n + " 门课程，请先移走课程后再删除"}, 400);
await env.DB.prepare("DELETE FROM categories WHERE parent=? AND name=?").bind(parent, name).run();
}
return json({ success: true});
}

// API: 提交答卷（服务端判分）
if (pathname === "/api/submit" && request.method === "POST") {
const b = await request.json();
const username = ((b.username || "匿名学员") + "").trim() || "匿名学员";
/* 已注册学员提交成绩需校验登录 token，防止冒名 */
try {
const srow = await env.DB.prepare("SELECT pw_hash FROM students WHERE username = ?").bind(username).first();
if (srow && srow.pw_hash) {
const expected = await sha256hex("tq-student-token:" + username + ":" + srow.pw_hash);
if ((b.token || "") !== expected) return json({ error: "登录已过期，请重新登录" }, 401);
}
} catch (e) {}
const courseId = b.course_id || "";
const now = new Date().toISOString();
if (Array.isArray(b.answers) && courseId) {
const cr = await env.DB.prepare("SELECT * FROM courses WHERE id =?").bind(courseId).all();
const course = ((cr && cr.results) || [])[0];
if (!course) return json({ error: "课程不存在"}, 404);
let qs = [];
try { qs = JSON.parse(course.quizzes_json || "[]");} catch (e) {}
/* 多语言判分：如客户端传来 lang=en/ja/ko 且有翻译答案，用翻译答案判分 */
const uLang = b.lang || "";
if ((uLang === "en" || uLang === "ja" || uLang === "ko") && course.i18n_json) {
try {
const i18n = JSON.parse(course.i18n_json);
const tq = i18n[uLang] && i18n[uLang].quizzes;
if (Array.isArray(tq) && tq.length === qs.length) {
for (let i = 0; i < qs.length; i++) { if (tq[i].a) qs[i] = Object.assign({}, qs[i], { a: tq[i].a }); }
}
} catch (e) {}
}
const ansMap = {};
b.answers.forEach(a => { ansMap[a.i] = a.u;});
let score = 0, gradable = 0;
const details = qs.map((q, i) => {
const v = checkAnswer(q, ansMap[i] == null? "": ansMap[i]);
if (v === null) return { i: i, verdict: null, expected: q.a || "", q: q.q || ""};
gradable++;
if (v) score++;
return { i: i, verdict:!!v, expected: q.a || "", q: q.q || ""};
});
const scoreText = score + "/" + gradable;
const title = b.courseTitle || course.title || "";
// 去重：同一学员同一课程只保留最新一条（batch 原子执行防并发重复）
await env.DB.batch([
    env.DB.prepare("DELETE FROM progress WHERE username=? AND course_id=?").bind(username, courseId),
    env.DB.prepare("INSERT INTO progress (username, course_id, course_title, score, submitted_at) VALUES (?,?,?,?,?)").bind(username, courseId, title, scoreText, now),
]);
return json({ success: true, score: score, gradable: gradable, details: details, scoreText: scoreText});
}
// 兼容旧客户端
const title = b.courseTitle || "";
await env.DB.prepare("INSERT INTO progress (username, course_id, course_title, score, submitted_at) VALUES (?,?,?,?,?)")
.bind(username, courseId, title, b.score || "", now).run();
return json({ success: true});
}

// API: 学员注册 / 登录（密码校验，通过后下发 token）
if (pathname === "/api/student/auth" && request.method === "POST") {
const b = await request.json();
const username = ((b.username || "") + "").trim();
const password = ((b.password || "") + "").trim();
const mode = b.mode === "register" ? "register" : "login";
if (!username) return json({ error: "请输入姓名" }, 400);
if (password.length < 4) return json({ error: "密码至少4位" }, 400);
const hash = await sha256hex("tq-student:" + username + ":" + password);
const row = await env.DB.prepare("SELECT pw_hash, is_admin FROM students WHERE username = ?").bind(username).first();
const tokenFor = async (h) => await sha256hex("tq-student-token:" + username + ":" + h);
if (mode === "register") {
if (row) return json({ error: "该姓名已注册，请直接登录" }, 409);
const now = new Date().toISOString();
await env.DB.prepare("INSERT INTO students (username, pw_hash, created_at) VALUES (?, ?, ?)").bind(username, hash, now).run();
return json({ success: true, isNew: true, token: await tokenFor(hash), is_admin: false });
} else {
if (!row) return json({ error: "该姓名尚未注册，请先注册" }, 404);
if (row.pw_hash !== hash) return json({ error: "密码错误，请重试" }, 401);
return json({ success: true, token: await tokenFor(row.pw_hash), is_admin: !!row.is_admin });
}
}

// API: 学员上传错题（按课程整体替换，供教师管理端查看）
if (pathname === "/api/wrongs/save" && request.method === "POST") {
const b = await request.json();
const username = ((b.username || "") + "").trim();
if (!username || username === "匿名学员") return json({ error: "缺少姓名" }, 400);
try {
const srow = await env.DB.prepare("SELECT pw_hash FROM students WHERE username = ?").bind(username).first();
if (srow && srow.pw_hash) {
const expected = await sha256hex("tq-student-token:" + username + ":" + srow.pw_hash);
if ((b.token || "") !== expected) return json({ error: "登录已过期，请重新登录" }, 401);
}
} catch (e) {}
const courseId = b.course_id || "";
const title = b.courseTitle || "";
const items = Array.isArray(b.wrongs) ? b.wrongs.slice(0, 100) : [];
const now = new Date().toISOString();
if (courseId || title) {
await env.DB.prepare("DELETE FROM wrongs WHERE username=? AND (course_id=? OR course_title=?)").bind(username, courseId, title).run();
}
await env.DB.batch(items.map(function(it) {
return env.DB.prepare("INSERT INTO wrongs (username, course_id, course_title, series, sub, qtype, qnum, question, user_answer, correct_answer, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
.bind(username, courseId, title, it.series || "", it.sub || "", it.type || "", String(it.n || ""), it.q || "", it.u || "", it.expected || "", now);
}));
return json({ success: true, count: items.length });
}

// API: 按姓名查错题（管理员）
if (pathname === "/api/wrongs" && request.method === "GET") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403 });
const username = (searchParams.get("username") || "").trim();
const courseId = (searchParams.get("course_id") || "").trim();
if (!username) return json({ wrongs: [] });
let wsql = "SELECT course_id, course_title, series, sub, qtype, qnum, question, user_answer, correct_answer, submitted_at FROM wrongs WHERE username = ?";
const wargs = [username];
if (courseId) { wsql += " AND course_id = ?"; wargs.push(courseId); }
wsql += " ORDER BY submitted_at DESC LIMIT 200";
const wr = await env.DB.prepare(wsql).bind(...wargs).all();
return json({ wrongs: (wr && wr.results) || [] });
}

// API: 按姓名查成绩
if (pathname === "/api/scores" && request.method === "GET") {
const username = (searchParams.get("username") || "").trim();
let scores = [];
if (username) {
const r = await env.DB.prepare(
"SELECT rowid, course_id, course_title, score, submitted_at FROM progress WHERE username =? ORDER BY submitted_at DESC LIMIT 100"
).bind(username).all();
scores = (r && r.results) || [];
}
return json({ scores: scores});
}

// API: 全部成绩（管理员，导出用）
if (pathname === "/api/scores-all" && request.method === "GET") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const r = await env.DB.prepare(
"SELECT username, course_id, course_title, score, submitted_at FROM progress ORDER BY submitted_at DESC LIMIT 2000"
).all();
return json({ scores: (r && r.results) || []});
}

// API: 学员名单（管理员）：全部学员姓名、成绩条数、最近提交时间
if (pathname === "/api/students" && request.method === "GET") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const r = await env.DB.prepare(
"SELECT username, COUNT(*) AS n, MAX(submitted_at) AS last FROM progress GROUP BY username ORDER BY last DESC LIMIT 500"
).all();
return json({ students: (r && r.results) || []});
}

// API: 注册学员名单（含管理员标记，管理员）
if (pathname === "/api/students/registered" && request.method === "GET") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403 });
const r = await env.DB.prepare("SELECT username, is_admin, created_at FROM students ORDER BY created_at DESC LIMIT 500").all();
return json({ students: (r && r.results) || [] });
}

// API: 学员自查管理员身份（token 鉴权）
if (pathname === "/api/student/me" && request.method === "GET") {
const su = (searchParams.get("username") || "").trim();
const stok = searchParams.get("token") || "";
if (!su || !stok) return json({ is_admin: false });
try {
const srow = await env.DB.prepare("SELECT pw_hash, is_admin FROM students WHERE username = ?").bind(su).first();
if (!srow) return json({ is_admin: false });
const expTok = await sha256hex("tq-student-token:" + su + ":" + srow.pw_hash);
return json({ is_admin: stok === expTok && !!srow.is_admin });
} catch (e) { return json({ is_admin: false }); }
}

// API: 设置/取消学员管理员（管理员）
if (pathname === "/api/student/set-admin" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403 });
const b = await request.json().catch(() => ({}));
const username = ((b.username || "") + "").trim();
if (!username) return json({ error: "缺少姓名" }, 400);
await env.DB.prepare("UPDATE students SET is_admin = ? WHERE username = ?").bind(b.is_admin ? 1 : 0, username).run();
const ch = await env.DB.prepare("SELECT changes() AS c").first();
if (!ch || !ch.c) return json({ error: "学员不存在" }, 404);
return json({ success: true });
}

// API: 删除成绩（管理员）：传 rowid 只删单条，不传 rowid 删除该学员全部成绩
if (pathname === "/api/score/delete" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json().catch(() => ({}));
const username = String(b.username || "").trim();
if (!username) return json({ error: "缺少学员姓名"}, 400);
let res;
if (b.rowid != null && b.rowid !== "") {
res = await env.DB.prepare("DELETE FROM progress WHERE rowid =? AND username =?").bind(b.rowid, username).run();
} else {
res = await env.DB.prepare("DELETE FROM progress WHERE username =?").bind(username).run();
}
const del = (res && res.meta && res.meta.changes) || 0;
return json({ success: true, deleted: del});
}

// API: 取某课完整题目（含答案，管理员，教师版用）
if (pathname === "/api/answers" && request.method === "GET") {
let allowed = authed;
if (!allowed) {
const su = (searchParams.get("username") || "").trim();
const stok = searchParams.get("token") || "";
if (su && stok) {
try {
const srow = await env.DB.prepare("SELECT pw_hash, is_admin FROM students WHERE username = ?").bind(su).first();
if (srow && srow.is_admin) {
const expTok = await sha256hex("tq-student-token:" + su + ":" + srow.pw_hash);
if (stok === expTok) allowed = true;
}
} catch (e) {}
}
}
if (!allowed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const cid = searchParams.get("course_id") || "";
const lang = searchParams.get("lang") || "";
const r = await env.DB.prepare("SELECT quizzes_json, i18n_json FROM courses WHERE id =?").bind(cid).all();
const rows = (r && r.results) || [];
let qs = [];
try { qs = JSON.parse((rows[0] && rows[0].quizzes_json) || "[]");} catch (e) {}
/* 多语言：如传来 lang=en/ja/ko，用翻译答案替换 */
if ((lang === "en" || lang === "ja" || lang === "ko") && rows[0] && rows[0].i18n_json) {
try {
const i18n = JSON.parse(rows[0].i18n_json);
const tq = i18n[lang] && i18n[lang].quizzes;
if (Array.isArray(tq) && tq.length === qs.length) {
for (let i = 0; i < qs.length; i++) { if (tq[i].a) qs[i] = Object.assign({}, qs[i], { a: tq[i].a }); }
}
} catch (e) {}
}
return json({ quizzes: qs});
}

// API: 管理登录（校验密码，写入 HttpOnly 会话 Cookie）
if (pathname === "/api/verify" && request.method === "POST") {
if (authed) return json({ ok: true});
const b = await request.json().catch(() => ({}));
const ok = (await sha256hex(String(b.password || "").trim())) === await getPwHash(env);
if (!ok) return json({ ok: false});
const resp = json({ ok: true});
resp.headers.set("Set-Cookie", adminCookie(await adminToken(env)));
return resp;
}

// API: 管理员退出登录
if (pathname === "/api/admin/logout" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403 });
return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": clearAdminCookie() }});
}

// API: 修改管理密码（管理员）
if (pathname === "/api/change-password" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json().catch(() => ({}));
const oldOk = (await sha256hex(String(b.oldPassword || "").trim())) === await getPwHash(env);
if (!oldOk) return json({ ok: false, error: "原密码错误"}, 400);
const np = String(b.newPassword || "").trim();
if (np.length < 6) return json({ ok: false, error: "新密码至少 6 位"}, 400);
await setSetting(env, "admin_pw_hash", await sha256hex(np));
const resp = json({ ok: true});
resp.headers.set("Set-Cookie", adminCookie(await adminToken(env)));
return resp;
}

// API: 设置管理密码恢复码（管理员）
if (pathname === "/api/admin/set-recovery" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json().catch(() => ({}));
const code = String(b.recoveryCode || "").trim();
if (code.length < 6) return json({ ok: false, error: "恢复码至少 6 位"}, 400);
await setSetting(env, "admin_recovery_hash", await sha256hex("tq-recovery:" + code));
return json({ ok: true});
}

// API: 凭恢复码重设管理密码（公开，需恢复码）
if (pathname === "/api/admin/recover-password" && request.method === "POST") {
const b = await request.json().catch(() => ({}));
const code = String(b.recoveryCode || "").trim();
const np = String(b.newPassword || "").trim();
const saved = await getSetting(env, "admin_recovery_hash");
if (!saved || !code || (await sha256hex("tq-recovery:" + code)) !== saved) return json({ ok: false, error: "恢复码错误"}, 401);
if (np.length < 6) return json({ ok: false, error: "新密码至少 6 位"}, 400);
await setSetting(env, "admin_pw_hash", await sha256hex(np));
const resp = json({ ok: true});
resp.headers.set("Set-Cookie", adminCookie(await adminToken(env)));
return resp;
}

// API: 管理员重置学员密码（管理员）
if (pathname === "/api/student/reset-password" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json().catch(() => ({}));
const username = ((b.username || "") + "").trim();
const np = String(b.newPassword || "").trim();
if (!username) return json({ ok: false, error: "缺少学员姓名"}, 400);
if (np.length < 4) return json({ ok: false, error: "新密码至少 4 位"}, 400);
const row = await env.DB.prepare("SELECT username FROM students WHERE username = ?").bind(username).first();
if (!row) return json({ ok: false, error: "该学员尚未注册"}, 404);
const hash = await sha256hex("tq-student:" + username + ":" + np);
await env.DB.prepare("UPDATE students SET pw_hash = ? WHERE username = ?").bind(hash, username).run();
return json({ ok: true});
}

// API: 首页公告（含英日韩翻译）
if (pathname === "/api/notice" && request.method === "GET") {
return json({
  notice: (await getSetting(env, "notice")) || "",
  notice_en: (await getSetting(env, "notice_en")) || "",
  notice_ja: (await getSetting(env, "notice_ja")) || "",
  notice_ko: (await getSetting(env, "notice_ko")) || ""
});
}
if (pathname === "/api/notice" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json().catch(() => ({}));
await setSetting(env, "notice", String(b.notice || "").slice(0, 500));
return json({ success: true});
}

// PWA：Web App Manifest / Service Worker / 图标（Android WebAPK + iOS 添加到主屏幕）
if (pathname === "/manifest.json") {
return new Response(JSON.stringify(pwaManifest()), { headers: { "Content-Type": "application/manifest+json;charset=UTF-8", "Cache-Control": "public, max-age=86400" } });
}
if (pathname === "/sw.js") {
return new Response(PWA_SW_JS, { headers: { "Content-Type": "application/javascript;charset=UTF-8", "Service-Worker-Allowed": "/", "Cache-Control": "no-cache" } });
}
if (pathname === "/icon-192.png") return pwaIconResponse(PWA_ICON_192);
if (pathname === "/icon-512.png") return pwaIconResponse(PWA_ICON_512);
if (pathname === "/icon-180.png") return pwaIconResponse(PWA_ICON_180);

const notice = (await getSetting(env, "notice")) || "";
const notice_en = (await getSetting(env, "notice_en")) || "";
const notice_ja = (await getSetting(env, "notice_ja")) || "";
const notice_ko = (await getSetting(env, "notice_ko")) || "";

// 教师管理端页面
if (pathname === "/admin" || pathname.indexOf("/admin/") === 0) {
const list = await orderedCourses(env);
const acats = [...new Set(list.map(item => item.category))];
const data = authed? list: stripAnswers(list);
return new Response(renderHTML(data, acats, { shareMode: false, isAdmin: true, adminAuthed: authed, notice: "", notice_en: "", notice_ja: "", notice_ko: ""}), { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store, no-cache, must-revalidate" }});
}

// 课程分享短链：/ID-xxxx
const shortId = /^\/ID-[A-Za-z0-9_-]+$/.test(pathname)? pathname.slice(1): null;
if (shortId) {
const sr = await env.DB.prepare("SELECT * FROM courses WHERE id =?").bind(shortId).all();
const srows = (sr && sr.results) || [];
if (!srows.length) return new Response("课程不存在或已删除", { status: 404});
const scats = [...new Set(srows.map(item => item.category))];
return new Response(renderHTML(stripAnswers(srows), scats, { shareMode: true, isAdmin: false, adminAuthed: false, notice: notice, notice_en: notice_en, notice_ja: notice_ja, notice_ko: notice_ko}), { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store, no-cache, must-revalidate" }});
}

// 页面渲染（学员端）
const results = await orderedCourses(env);
const categories = [...new Set(results.map(item => item.category))];
let displayData = results;
let isShareMode = false;
if (shareId) {
displayData = results.filter(item => item.id === shareId);
isShareMode = true;
}
return new Response(renderHTML(stripAnswers(displayData), categories, { shareMode: isShareMode, isAdmin: false, adminAuthed: false, notice: notice, notice_en: notice_en, notice_ja: notice_ja, notice_ko: notice_ko}), { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store, no-cache, must-revalidate" }});

} catch (e) {
return new Response("服务器错误: " + e.message, { status: 500});
}
}
};
/* ============================================================================
 * 学习路径 + 证书系统（服务端）
 * ----------------------------------------------------------------------------
 * 外部依赖（由构建/Worker 组装时提供，本文件不定义）：
 *   json(data, status, headers) — src/server/utils.js，返回 JSON Response
 *   authed                      — 调用方（api.js）用 isAdminReq(request, env)
 *                                 算好后传入；isAdminReq 定义见 src/server/auth.js
 * 接入方式（在 api.js 的 fetch() 内、migrate(env) 之后加）：
 *   await migratePaths(env);
 *   const pr = await handlePathsApi(pathname, searchParams, request, env, authed, json);
 *   if (pr) return pr;
 * 表（paths / path_progress / certificates）不参与双库 D1 同步（证书涉学员隐私）。
 * ========================================================================== */

/* 建表 + 默认预置 4 条路径（空课程，管理员后续在管理端配置课程顺序） */
async function migratePaths(env) {
const db = env.DB;
await db.prepare("CREATE TABLE IF NOT EXISTS paths (id TEXT PRIMARY KEY, title TEXT, title_en TEXT DEFAULT '', title_ja TEXT DEFAULT '', title_ko TEXT DEFAULT '', descr TEXT DEFAULT '', descr_en TEXT DEFAULT '', descr_ja TEXT DEFAULT '', descr_ko TEXT DEFAULT '', course_ids TEXT DEFAULT '[]', sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT '')").run();
await db.prepare("CREATE TABLE IF NOT EXISTS path_progress (username TEXT, path_id TEXT, done_ids TEXT DEFAULT '[]', updated_at TEXT DEFAULT '', PRIMARY KEY (username, path_id))").run();
await db.prepare("CREATE TABLE IF NOT EXISTS certificates (cert_no TEXT PRIMARY KEY, username TEXT, path_id TEXT, path_title TEXT DEFAULT '', issued_at TEXT DEFAULT '')").run();
await db.prepare("CREATE INDEX IF NOT EXISTS idx_cert_user ON certificates(username)").run();
try {
const c = await db.prepare("SELECT COUNT(*) AS n FROM paths").first();
if (c && c.n === 0) {
const now = new Date().toISOString();
/* [id, title, en, ja, ko, descr, descr_en, descr_ja, descr_ko] */
const seeds = [
["PATH-NEW", "初信者", "New Believers", "新信徒", "새신자",
"认识救恩、建立祷告与读经生活，扎根真理的第一步。",
"Know salvation and build a life of prayer and Bible reading — the first step of rooted faith.",
"救いを知り、祈りと御言葉の生活を築く、信仰の第一歩。",
"구원을 알고 기도와 말씀의 생활을 세우는 신앙의 첫걸음。"],
["PATH-GROW", "门徒成长", "Discipleship Growth", "弟子の成長", "제자 성장",
"在真理、品格与团契生活中持续成长，活出门徒样式。",
"Grow continually in truth, character and fellowship life, living as a disciple.",
"真理と品格、交わりの生活において成長し続け、弟子として生きる。",
"진리와 인격, 교제의 삶에서 계속 성장하며 제자로 살아갑니다."],
["PATH-SERVE", "服事装备", "Ministry Equipping", "奉仕の備え", "사역 준비",
"发现恩赐、装备技能，以爱心参与教会服事。",
"Discover your gifts, get equipped, and serve the church in love.",
"賜物を発見し、備えを整え、愛をもって教会に仕える。",
"은사를 발견하고 준비를 갖추어 사랑으로 교회를 섬깁니다."],
["PATH-LEAD", "领袖训练", "Leadership Training", "リーダーの訓練", "리더 훈련",
"学习仆人式领导，带领小组、牧养群羊。",
"Learn servant leadership — lead small groups and shepherd the flock.",
"仕えるリーダーシップを学び、小グループを導き、群れを養う。",
"섬기는 리더십을 배워 소그룹을 인도하고 양 떼를 돌봅니다."]
];
for (let i = 0; i < seeds.length; i++) {
const s = seeds[i];
await db.prepare("INSERT INTO paths (id, title, title_en, title_ja, title_ko, descr, descr_en, descr_ja, descr_ko, course_ids, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
.bind(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], "[]", i + 1, now).run();
}
}
} catch (e) {}
}

/* 证书编号：TQ-YYYYMMDD-XXXX（XXXX 为随机大写十六进制） */
function genCertNo() {
const d = new Date();
const ymd = d.getFullYear()
+ String(d.getMonth() + 1).padStart(2, "0")
+ String(d.getDate()).padStart(2, "0");
const hex = "0123456789ABCDEF";
let s = "";
try {
const buf = new Uint8Array(2);
crypto.getRandomValues(buf);
for (let i = 0; i < 2; i++) s += hex[buf[i] >> 4] + hex[buf[i] & 15];
} catch (e) {
for (let i = 0; i < 4; i++) s += hex[Math.floor(Math.random() * 16)];
}
return "TQ-" + ymd + "-" + s;
}

function parseIdList(s) {
try {
const a = JSON.parse(s || "[]");
return Array.isArray(a) ? a.map(function (x) { return String(x); }) : [];
} catch (e) { return []; }
}

/* 路径/证书 API。命中返回 Response，未命中返回 null（调用方继续走原有路由）。 */
async function handlePathsApi(pathname, searchParams, request, env, authed, json) {
const db = env.DB;

/* GET /api/paths：公开。路径列表（含课程数）；带 username 时附带该学员每条路径的完成数 */
if (pathname === "/api/paths" && request.method === "GET") {
const r = await db.prepare("SELECT * FROM paths ORDER BY sort_order ASC, created_at ASC").all();
const paths = (r && r.results) || [];
const username = (searchParams.get("username") || "").trim();
const progMap = {};
if (username) {
const pr = await db.prepare("SELECT path_id, done_ids FROM path_progress WHERE username=?").bind(username).all();
((pr && pr.results) || []).forEach(function (row) {
progMap[row.path_id] = parseIdList(row.done_ids);
});
}
const out = paths.map(function (p) {
const ids = parseIdList(p.course_ids);
const done = progMap[p.id] || [];
let doneCount = 0;
done.forEach(function (id) { if (ids.indexOf(id) >= 0) doneCount++; });
return {
id: p.id,
title: p.title || "", title_en: p.title_en || "", title_ja: p.title_ja || "", title_ko: p.title_ko || "",
descr: p.descr || "", descr_en: p.descr_en || "", descr_ja: p.descr_ja || "", descr_ko: p.descr_ko || "",
course_count: ids.length, done_count: doneCount, sort_order: p.sort_order || 0
};
});
return json({ paths: out }, 200, { "Cache-Control": "public, max-age=60" });
}

/* GET /api/path?id=：公开。单路径详情，含按 course_ids 排序的课程精简信息；带 username 时附带 done_ids */
if (pathname === "/api/path" && request.method === "GET") {
const id = (searchParams.get("id") || "").trim();
if (!id) return json({ error: "missing id" }, 400);
const p = await db.prepare("SELECT * FROM paths WHERE id=?").bind(id).first();
if (!p) return json({ error: "not found" }, 404);
const ids = parseIdList(p.course_ids);
let courses = [];
if (ids.length) {
const ph = ids.map(function () { return "?"; }).join(",");
const cr = await db.prepare("SELECT id, title, category, subcategory, mode FROM courses WHERE id IN (" + ph + ")").bind(...ids).all();
const cmap = {};
((cr && cr.results) || []).forEach(function (c) { cmap[c.id] = c; });
courses = ids.map(function (cid) {
return cmap[cid] || { id: cid, title: "", category: "", subcategory: "", mode: "", missing: true };
});
}
const username = (searchParams.get("username") || "").trim();
let doneIds = [];
if (username) {
const pg = await db.prepare("SELECT done_ids FROM path_progress WHERE username=? AND path_id=?").bind(username, id).first();
if (pg) doneIds = parseIdList(pg.done_ids);
}
return json({ path: p, courses: courses, done_ids: doneIds }, 200, { "Cache-Control": "public, max-age=60" });
}

/* POST /api/path/save：管理员。新增/更新路径。body: {id?, title, title_en/ja/ko, descr, descr_en/ja/ko, course_ids[], sort_order} */
if (pathname === "/api/path/save" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403 });
const b = await request.json().catch(function () { return {}; });
const title = ((b.title || "") + "").trim();
if (!title) return json({ error: "标题不能为空" }, 400);
let courseIds = [];
if (Array.isArray(b.course_ids)) courseIds = b.course_ids.map(function (x) { return String(x); });
else courseIds = parseIdList(b.course_ids);
const now = new Date().toISOString();
const args = [title, String(b.title_en || ""), String(b.title_ja || ""), String(b.title_ko || ""),
String(b.descr || ""), String(b.descr_en || ""), String(b.descr_ja || ""), String(b.descr_ko || ""),
JSON.stringify(courseIds), parseInt(b.sort_order, 10) || 0];
const pid = String(b.id || "").trim();
if (pid) {
await db.prepare("UPDATE paths SET title=?, title_en=?, title_ja=?, title_ko=?, descr=?, descr_en=?, descr_ja=?, descr_ko=?, course_ids=?, sort_order=? WHERE id=?")
.bind(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8], args[9], pid).run();
return json({ success: true, id: pid });
}
const nid = "PATH-" + Date.now();
await db.prepare("INSERT INTO paths (id, title, title_en, title_ja, title_ko, descr, descr_en, descr_ja, descr_ko, course_ids, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
.bind(nid, args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8], args[9], now).run();
return json({ success: true, id: nid });
}

/* POST /api/path/delete：管理员。删除路径及其学员进度（证书为历史记录，保留）。body: {id} */
if (pathname === "/api/path/delete" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403 });
const b = await request.json().catch(function () { return {}; });
const id = String(b.id || "").trim();
if (!id) return json({ error: "missing id" }, 400);
await db.batch([
db.prepare("DELETE FROM paths WHERE id=?").bind(id),
db.prepare("DELETE FROM path_progress WHERE path_id=?").bind(id)
]);
return json({ success: true });
}

/* POST /api/path/progress：学员上报某课程完成。body: {path_id, course_id, username}
 * 整条路径完成时自动颁发证书（每人每路径只发一次），返回 cert_no。
 * 注：如需防冒名，可按 /api/submit 的 token 校验模式加签（本接口按任务规格只收 username）。 */
if (pathname === "/api/path/progress" && request.method === "POST") {
const b = await request.json().catch(function () { return {}; });
const username = ((b.username || "") + "").trim();
const pathId = String(b.path_id || "").trim();
const courseId = String(b.course_id || "").trim();
if (!username || !pathId || !courseId) return json({ error: "缺少参数" }, 400);
const p = await db.prepare("SELECT * FROM paths WHERE id=?").bind(pathId).first();
if (!p) return json({ error: "路径不存在" }, 404);
const ids = parseIdList(p.course_ids);
if (ids.indexOf(courseId) < 0) return json({ error: "该课程不在此路径中" }, 400);
const now = new Date().toISOString();
let done = [];
const pg = await db.prepare("SELECT done_ids FROM path_progress WHERE username=? AND path_id=?").bind(username, pathId).first();
if (pg) done = parseIdList(pg.done_ids);
if (done.indexOf(courseId) < 0) done.push(courseId);
await db.prepare("INSERT INTO path_progress (username, path_id, done_ids, updated_at) VALUES (?,?,?,?) ON CONFLICT(username, path_id) DO UPDATE SET done_ids=excluded.done_ids, updated_at=excluded.updated_at")
.bind(username, pathId, JSON.stringify(done), now).run();
let certNo = null;
const allDone = ids.length > 0 && ids.every(function (id) { return done.indexOf(id) >= 0; });
if (allDone) {
const ex = await db.prepare("SELECT cert_no FROM certificates WHERE username=? AND path_id=?").bind(username, pathId).first();
if (ex && ex.cert_no) {
certNo = ex.cert_no;
} else {
certNo = genCertNo();
await db.prepare("INSERT INTO certificates (cert_no, username, path_id, path_title, issued_at) VALUES (?,?,?,?,?)")
.bind(certNo, username, pathId, p.title || "", now).run();
}
}
return json({ success: true, done_count: done.length, course_count: ids.length, completed: allDone, cert_no: certNo });
}

/* GET /api/certificates?username=：学员查自己的证书；管理员 ?all=1 查全部 */
if (pathname === "/api/certificates" && request.method === "GET") {
if (searchParams.get("all") === "1") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403 });
const r = await db.prepare("SELECT * FROM certificates ORDER BY issued_at DESC LIMIT 500").all();
return json({ certificates: (r && r.results) || [] });
}
const username = (searchParams.get("username") || "").trim();
if (!username) return json({ certificates: [] });
const r = await db.prepare("SELECT * FROM certificates WHERE username=? ORDER BY issued_at DESC").bind(username).all();
return json({ certificates: (r && r.results) || [] });
}

/* GET /api/certificate?no=：公开，返回单证书信息（证书展示页用） */
if (pathname === "/api/certificate" && request.method === "GET") {
const no = (searchParams.get("no") || "").trim();
if (!no) return json({ error: "missing no" }, 400);
const c = await db.prepare("SELECT * FROM certificates WHERE cert_no=?").bind(no).first();
if (!c) return json({ error: "not found" }, 404);
return json({ certificate: c }, 200, { "Cache-Control": "public, max-age=3600" });
}

return null;
}
/* 团契智学 · 社交模块：班级/小组 + 积分徽章 + 使用统计
 *
 * 依赖（由调用方提供，本文件不定义）：
 *   - env.DB                                D1 数据库绑定
 *   - json(data, status, headers)           来自 src/server/utils.js
 *   - authed                                布尔值，调用方已判定的管理员身份
 *
 * 调用方集成（两处，不改本文件）：
 *   1. src/server/db.js 的 migrate(env) 末尾加：await migrateSocial(env);
 *   2. src/server/api.js 的 fetch() 路由中加：
 *        const sr = await handleSocialApi(pathname, searchParams, request, env, authed, json);
 *        if (sr) return sr;
 *
 * 不含任何真实密码、密钥。
 */

async function migrateSocial(env) {
const db = env.DB;
await db.prepare("CREATE TABLE IF NOT EXISTS classes (id TEXT PRIMARY KEY, name TEXT, descr TEXT, leader TEXT, created_at TEXT)").run();
await db.prepare("CREATE TABLE IF NOT EXISTS class_members (class_id TEXT, username TEXT, joined_at TEXT, PRIMARY KEY (class_id, username))").run();
await db.prepare("CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(username)").run();
}

/* 解析 progress.score（格式 "得分/总分"，如 "15/18"） */
function parseScoreText(t) {
const m = String(t || "").match(/^\s*([0-9]+)\s*\/\s*([0-9]+)\s*$/);
if (!m) return null;
const s = parseInt(m[1], 10), g = parseInt(m[2], 10);
if (!(g > 0) || s < 0 || s > g) return null;
return { s: s, g: g, pct: s / g };
}

/* 徽章定义：id/icon 固定；name/desc 为中文兜底，客户端优先用 tr("bdg_"+id) 做四语言 */
function badgeDefs() {
return [
{ id: "first_step", icon: "🌱", name: "初涉真理", desc: "完成 1 门课程" },
{ id: "diligent", icon: "📚", name: "勤奋好学", desc: "完成 10 门课程" },
{ id: "scholar", icon: "🎓", name: "荣誉学员", desc: "平均分达到 90 分" },
{ id: "persistent", icon: "🔥", name: "持之以恒", desc: "连续 7 天学习" },
{ id: "perfect", icon: "💯", name: "完美答卷", desc: "单门课程获得满分" },
{ id: "explorer", icon: "🌍", name: "真理探索者", desc: "完成 3 个不同系列的课程" },
];
}

/* 计算某学员徽章 earned 状态 */
async function computeBadges(env, username) {
const r = await env.DB.prepare(
"SELECT p.score, p.submitted_at, c.category FROM progress p LEFT JOIN courses c ON c.id = p.course_id WHERE p.username = ?"
).bind(username).all();
const rows = (r && r.results) || [];
const defs = badgeDefs();
const earned = { first_step: false, diligent: false, scholar: false, persistent: false, perfect: false, explorer: false };
if (!rows.length) return defs.map(d => ({ id: d.id, name: d.name, icon: d.icon, earned: false, desc: d.desc, key: "bdg_" + d.id }));

const pcts = [];
const dates = {};
const series = {};
for (const row of rows) {
const ps = parseScoreText(row.score);
if (ps) {
pcts.push(ps.pct);
if (ps.s === ps.g) earned.perfect = true;
}
const day = String(row.submitted_at || "").slice(0, 10);
if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) dates[day] = 1;
const cat = String(row.category || "").trim();
if (cat) series[cat] = 1;
}
const n = rows.length;
earned.first_step = n >= 1;
earned.diligent = n >= 10;
if (pcts.length) {
const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
earned.scholar = avg >= 0.9;
}
/* 连续 7 天：按日期排序找任意连续 7 天区间 */
const ds = Object.keys(dates).sort();
let streak = 1, best = ds.length ? 1 : 0;
for (let i = 1; i < ds.length; i++) {
const prev = new Date(ds[i - 1] + "T00:00:00Z").getTime();
const cur = new Date(ds[i] + "T00:00:00Z").getTime();
if (cur - prev === 86400000) { streak++; if (streak > best) best = streak; }
else streak = 1;
}
earned.persistent = best >= 7;
earned.explorer = Object.keys(series).length >= 3;
return defs.map(d => ({ id: d.id, name: d.name, icon: d.icon, earned: !!earned[d.id], desc: d.desc, key: "bdg_" + d.id }));
}

async function handleSocialApi(pathname, searchParams, request, env, authed, json) {
const db = env.DB;
const needAdmin = () => { if (!authed) return json({ error: "forbidden" }, 403); return null; };

/* 班级列表（公开，含成员数） */
if (pathname === "/api/classes") {
const r = await db.prepare(
"SELECT c.id, c.name, c.descr, c.leader, c.created_at, (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id) AS member_count FROM classes c ORDER BY c.created_at DESC"
).all();
return json((r && r.results) || []);
}

/* 新建/更新班级（管理员） */
if (pathname === "/api/class/save" && request.method === "POST") {
const adm = needAdmin(); if (adm) return adm;
const b = await request.json();
const name = String(b.name || "").trim();
if (!name) return json({ error: "missing name" }, 400);
const now = new Date().toISOString();
let id = String(b.id || "").trim();
if (id) {
const ex = await db.prepare("SELECT id FROM classes WHERE id = ?").bind(id).all();
if ((((ex || {}).results) || []).length) {
await db.prepare("UPDATE classes SET name = ?, descr = ?, leader = ? WHERE id = ?")
.bind(name, String(b.descr || ""), String(b.leader || "").trim(), id).run();
return json({ success: true, id: id, updated: true });
}
}
if (!id) id = "CLS-" + Date.now();
await db.prepare("INSERT INTO classes (id, name, descr, leader, created_at) VALUES (?,?,?,?,?)")
.bind(id, name, String(b.descr || ""), String(b.leader || "").trim(), now).run();
return json({ success: true, id: id, updated: false });
}

/* 删除班级（管理员，连带删除成员关系） */
if (pathname === "/api/class/delete" && request.method === "POST") {
const adm = needAdmin(); if (adm) return adm;
const b = await request.json();
const classId = String(b.class_id || b.id || "").trim();
if (!classId) return json({ error: "missing class_id" }, 400);
await db.batch([
db.prepare("DELETE FROM class_members WHERE class_id = ?").bind(classId),
db.prepare("DELETE FROM classes WHERE id = ?").bind(classId),
]);
return json({ success: true });
}

/* 学员加入班级 */
if (pathname === "/api/class/join" && request.method === "POST") {
const b = await request.json();
const classId = String(b.class_id || "").trim();
const username = String(b.username || "").trim();
if (!classId || !username) return json({ error: "missing class_id/username" }, 400);
const ex = await db.prepare("SELECT id FROM classes WHERE id = ?").bind(classId).all();
if (!(((ex || {}).results) || []).length) return json({ error: "class not found" }, 404);
const now = new Date().toISOString();
const r = await db.prepare("INSERT OR IGNORE INTO class_members (class_id, username, joined_at) VALUES (?,?,?)")
.bind(classId, username, now).run();
return json({ success: true, joined: (r && r.meta && r.meta.changes) > 0 });
}

/* 学员退出班级 */
if (pathname === "/api/class/leave" && request.method === "POST") {
const b = await request.json();
const classId = String(b.class_id || "").trim();
const username = String(b.username || "").trim();
if (!classId || !username) return json({ error: "missing class_id/username" }, 400);
await db.prepare("DELETE FROM class_members WHERE class_id = ? AND username = ?").bind(classId, username).run();
return json({ success: true });
}

/* 成员列表：管理员或该班小组长可见（非管理员需传 username= 以核验 leader 身份） */
if (pathname === "/api/class/members") {
const classId = String(searchParams.get("class_id") || "").trim();
if (!classId) return json({ error: "missing class_id" }, 400);
if (!authed) {
const username = String(searchParams.get("username") || "").trim();
const cr = await db.prepare("SELECT leader FROM classes WHERE id = ?").bind(classId).all();
const leader = (((((cr || {}).results) || [])[0]) || {}).leader || "";
if (!username || username !== leader) return json({ error: "forbidden" }, 403);
}
const r = await db.prepare(
"SELECT username, joined_at FROM class_members WHERE class_id = ? ORDER BY joined_at ASC"
).bind(classId).all();
return json((r && r.results) || []);
}

/* 徽章墙：按 username 计算 earned */
if (pathname === "/api/badges") {
const username = String(searchParams.get("username") || "").trim();
if (!username) return json({ error: "missing username" }, 400);
const list = await computeBadges(env, username);
return json(list);
}

/* 使用统计（仅管理员） */
if (pathname === "/api/stats") {
const adm = needAdmin(); if (adm) return adm;
const q = async (sql, ...args) => {
const r = await db.prepare(sql).bind(...args).all();
return (r && r.results) || [];
};
const students = (await q("SELECT COUNT(*) AS n FROM students"))[0].n || 0;
const courses = (await q("SELECT COUNT(*) AS n FROM courses"))[0].n || 0;
const completions = (await q("SELECT COUNT(*) AS n FROM progress"))[0].n || 0;
let avgScore = 0;
const scores = await q("SELECT score FROM progress");
const pcts = [];
for (const row of scores) { const ps = parseScoreText(row.score); if (ps) pcts.push(ps.pct); }
if (pcts.length) avgScore = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length * 1000) / 10;
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
const active7 = (await q("SELECT COUNT(DISTINCT username) AS n FROM progress WHERE submitted_at >= ?", weekAgo))[0].n || 0;
const topRows = await q("SELECT course_title AS title, COUNT(*) AS count FROM progress GROUP BY course_id, course_title ORDER BY count DESC LIMIT 5");
const wrongRows = await q("SELECT qtype, COUNT(*) AS n FROM wrongs GROUP BY qtype");
const wrongsByType = {};
for (const w of wrongRows) wrongsByType[String(w.qtype || "unknown")] = w.n;
return json({
students: students, courses: courses, completions: completions,
avgScore: avgScore, active7: active7,
topCourses: topRows.map(t => ({ title: t.title || "", count: t.count })),
wrongsByType: wrongsByType,
});
}

return null;
}

function renderHTML(results, categories, opts) {
    var isShareMode = opts.shareMode, isAdmin = opts.isAdmin, adminAuthed = !!opts.adminAuthed, notice = opts.notice || "";
    var notice_en = opts.notice_en || "", notice_ja = opts.notice_ja || "", notice_ko = opts.notice_ko || "";
  // 把服务端已过滤好的展示数据直接灌给前端（分享模式只含被分享的那一课），顺带防 </script> 注入
  // 学员端主页只注入精简字段（提速约一半），点开课件时再按需拉完整内容；管理端/分享页保持完整
  const bootList = (!isShareMode && !isAdmin) ? (results || []).map(briefCourse) : (results || []);
  const bootJson = JSON.stringify(bootList).replace(/</g, function(){ return String.fromCharCode(92) + 'u003c'; });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" content="#1e3a5f">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="团契智学">
    <link rel="manifest" href="/manifest.json">
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
    <link rel="apple-touch-icon" href="/icon-180.png">
    <title>团契智学${isAdmin ? ' · 教师管理' : '系统'}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
    <style>
        body.preview-mode .admin-only { display: none !important; }
        .quiz-card { border: 2px solid #f1f5f9; border-radius: 1.5rem; padding: 1.5rem; background: white; margin-bottom: 1.5rem; transition: all 0.3s ease; }
        .correct-ans { border-color: #10b981 !important; background-color: #f0fdf4; }
        .wrong-ans { border-color: #ef4444 !important; background-color: #fef2f2; }
        .course-card { animation: fadeUp .4s ease both; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
        .ask-flash { animation: askFlash 1.1s ease 2; border-color: #f59e0b !important; }
        .open-ans { border-color: #f59e0b !important; background-color: #fffbeb; }
        @keyframes askFlash { 0%,100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); } 50% { box-shadow: 0 0 0 5px rgba(245,158,11,.55); } }
        .section-head { display:flex; align-items:center; gap:.6rem; margin:2rem 0 1rem; }
        .section-head .bar { width:.35rem; height:1.4rem; border-radius:9999px; background:linear-gradient(to bottom,#8b5cf6,#6366f1); }
        /* 课件模式（jyzl1 式） */
        .blank-input { border-bottom: 2px solid #3b82f6; text-align: center; color: #2563eb; font-weight: bold; background: transparent; outline: none; padding: 0 5px; transition: all 0.3s; font-size: inherit; }
        .blank-input:focus { border-bottom-color: #1d4ed8; background: #eff6ff; }
        .answer-text { display: none; color: #059669; font-weight: bold; border-bottom: 2px solid #059669; padding: 0 5px; }
        .show-answers .answer-text { display: inline; }
        .show-answers .blank-input { display: none; }
        #studySubmit:disabled { background-color: #cbd5e1 !important; cursor: not-allowed; transform: none !important; }
        .sopt { display: inline-flex; align-items: center; border: 2px solid #e2e8f0; border-radius: 12px; padding: 8px 18px; cursor: pointer; font-size: .95rem; color: #334155; transition: all .2s; background: #fff; }
        /* 字号调节浮钮（全站可见，含分享页） */
        #fontFab { position: fixed; right: 0.5rem; bottom: 5rem; z-index: 100; display: flex; flex-direction: column; align-items: center; gap: .5rem; }
        #fontFabBtn { height: 3rem; padding: 0 1.1rem; border-radius: 9999px; background: linear-gradient(135deg,#8b5cf6,#6366f1); color: #fff; font-weight: 900; font-size: 1rem; box-shadow: 0 6px 20px rgba(124,93,250,.45); border: 2px solid #fff; cursor: pointer; line-height: 1; }
        #fontFabBtn:active { transform: scale(.94); }
        #videoToggleBtn { width: 2.6rem; height: 2.6rem; border-radius: 9999px; background: linear-gradient(135deg,#f59e0b,#ef4444); color: #fff; font-size: 1.1rem; box-shadow: 0 6px 20px rgba(245,158,11,.45); border: 2px solid #fff; cursor: pointer; line-height: 1; opacity: .55; transition: opacity .25s; display: flex; align-items: center; justify-content: center; }
        #videoToggleBtn:hover { opacity: 1; }
        #videoToggleBtn:active { transform: scale(.94); }
        #netEnvModal .netenv-opt { border-color: #e2e8f0; background: #f8fafc; }
        #netEnvModal .netenv-opt:hover { border-color: #a5b4fc; background: #eef2ff; }
        #netEnvModal .netenv-opt.netenv-cur { border-color: #6366f1; background: #eef2ff; box-shadow: 0 0 0 2px rgba(99,102,241,.25); }
        #fontFabBtn { opacity: .55; transition: opacity .25s; }
        #fontFab.open #fontFabBtn, #fontFabBtn:hover { opacity: 1; }
        #viewModeFab { position: fixed; left: 0.5rem; bottom: 5rem; z-index: 100; }
        #viewModeBtn { height: 3rem; min-width: 3rem; padding: 0 .9rem; border-radius: 9999px; background: linear-gradient(135deg,#0ea5e9,#6366f1); color: #fff; font-weight: 900; font-size: 1rem; box-shadow: 0 6px 20px rgba(14,165,233,.45); border: 2px solid #fff; cursor: pointer; line-height: 1; opacity: .55; transition: opacity .25s; }
        #viewModeBtn:hover { opacity: 1; }
        html.view-desktop .course-cards { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        #viewModeBtn:active { transform: scale(.94); }
        #fontPanel .font-reset-btn { height: 1.7rem; font-size: .7rem; font-weight: 700; background: #fff; color: #94a3b8; }
        #fontPanel { background: #fff; border-radius: 1rem; box-shadow: 0 10px 30px rgba(0,0,0,.18); border: 1px solid #ede9fe; padding: .55rem; display: flex; flex-direction: column; gap: .35rem; align-items: center; }
        #fontPanel button { width: 2.6rem; height: 2.2rem; border-radius: .6rem; background: #f5f3ff; color: #6d28d9; font-weight: 900; cursor: pointer; border: 1px solid #ede9fe; }
        #fontPanel button:active { transform: scale(.94); }
        #fontPanel.hidden { display: none; } /* ID 选择器优先级高于 .hidden，必须显式覆盖才能真正隐藏 */
        .sopt:has(input:checked) { border-color: #3b82f6; background: #eff6ff; color: #1d4ed8; font-weight: bold; }
        .sopt.sopt-ok { border-color: #10b981 !important; background: #ecfdf5 !important; color: #047857 !important; font-weight: bold; }
        .sopt-wrong { border-color: #f43f5e !important; background: #ffe4e6 !important; color: #9f1239 !important; font-weight: bold; }
        /* 分 Tab 互动课件导航（参考互动课件 UI） */
        .qtab-btn { white-space: nowrap; font-size: .8rem; padding: .55rem .85rem; border-radius: .7rem .7rem 0 0; color: #cbd5e1; border-bottom: 2px solid transparent; transition: all .2s; }
        .qtab-btn:hover { color: #fff; background: rgba(255,255,255,.06); }
        .qtab-btn.qtab-active { color: #fff; border-bottom-color: #60a5fa; background: rgba(255,255,255,.08); font-weight: 700; }
        .qtab-count { font-size: .65rem; background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.18); color: #e0e7ff; padding: .05rem .45rem; border-radius: 9999px; margin-left: .3rem; }
        .qtab-report { color: #fcd34d; font-weight: 700; }
        .qtab-report.qtab-active { color: #fde68a; border-bottom-color: #fbbf24; }
        /* 经文高亮：引用徽章（紫）与经文正文（琥珀）作区分 */
        .verse-ref { display: inline-block; background: linear-gradient(135deg,#4f46e5,#7c3aed); color: #fff; font-weight: 700; font-size: .72rem; padding: .12rem .6rem; border-radius: 9999px; white-space: nowrap; vertical-align: .05em; box-shadow: 0 1px 4px rgba(124,58,237,.35); }
        .verse-ref-book { display: inline-block; background: linear-gradient(135deg,#4f46e5,#7c3aed); color: #fff; font-weight: 700; font-size: .72rem; padding: .12rem .6rem; border-radius: 9999px; white-space: nowrap; vertical-align: .05em; box-shadow: 0 1px 4px rgba(124,58,237,.35); }
        .verse-ref-icon { display: inline-block; background: linear-gradient(135deg,#f59e0b,#d97706); color: #fff; font-weight: 700; font-size: .72rem; padding: .12rem .5rem; border-radius: 9999px; white-space: nowrap; vertical-align: .05em; box-shadow: 0 1px 4px rgba(217,119,6,.35); margin-right: .3rem; }
        .verse-ref-num { display: inline-block; background: #eff6ff; color: #1d4ed8; font-weight: 700; font-size: .72rem; padding: .12rem .6rem; border-radius: 9999px; white-space: nowrap; vertical-align: .05em; border: 1.5px solid #60a5fa; margin-left: .3rem; }
        .verse-text { background: #fef3c7; color: #92400e; font-weight: 700; border-radius: .2rem; padding: 0 .25rem; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    </style>
</head>
<body class="bg-[#f6f7fb] min-h-screen text-slate-900 pb-20">
    <script>window.__BOOT__ = { shareMode: ${isShareMode}, isAdmin: ${isAdmin}, adminAuthed: ${adminAuthed}, list: ${bootJson} };</script>

    <!-- 顶栏 -->
    <header class="bg-white/90 backdrop-blur sticky top-0 z-50 border-b border-slate-100">
        <div class="max-w-7xl mx-auto px-5 py-3 flex justify-between items-center">
            <div class="flex items-center gap-2.5 cursor-pointer" onclick="location.href=location.origin">
                <div class="w-9 h-9 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white text-lg shadow-md shadow-violet-200">📖</div>
                <span class="font-black text-lg tracking-tight" data-i18n="appName">团契智学</span>
                ${isAdmin ? '<span class="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold">教师管理</span>' : ''}
            </div>
            <div class="flex gap-2">
                ${isAdmin
                    ? '<a href="/" target="_blank" class="text-xs bg-slate-100 px-3.5 py-2 rounded-xl font-medium text-slate-600 hover:bg-slate-200 transition">👁️ 学员预览</a>'
                      + '<a href="/" class="text-xs bg-violet-100 px-3.5 py-2 rounded-xl font-medium text-violet-700 hover:bg-violet-200 transition">🎓 学员端</a>'
                      + '<button onclick="exportSelected()" class="admin-only text-xs bg-emerald-600 text-white px-3.5 py-2 rounded-xl font-bold shadow-md shadow-emerald-200 hover:opacity-95 transition">📥 批量导出</button>'
                      + '<button onclick="openEditModal()" class="admin-only text-xs bg-gradient-to-r from-violet-600 to-indigo-600 text-white px-3.5 py-2 rounded-xl font-bold shadow-md shadow-violet-200 hover:opacity-95 transition">+ 创建新课件</button>'
                    : '<button onclick="toggleHomeView()" data-i18n="allCourses" class="text-xs bg-slate-100 px-3.5 py-2 rounded-xl font-medium text-slate-600 hover:bg-slate-200 transition">📚 全部课程</button>'
                      + '<button onclick="renderClassesPage({})" data-i18n="cls_title" class="text-xs bg-slate-100 px-3.5 py-2 rounded-xl font-medium text-slate-600 hover:bg-slate-200 transition">👥 班级小组</button>'
                      + '<button onclick="openWrongBook()" data-i18n="wrongBook" class="text-xs bg-slate-100 px-3.5 py-2 rounded-xl font-medium text-slate-600 hover:bg-slate-200 transition">📝 错题本</button>'
                      + '<button onclick="renderBadgesPage(typeof progName===\'function\'?progName():\'\')" data-i18n="bdg_title" class="text-xs bg-slate-100 px-3.5 py-2 rounded-xl font-medium text-slate-600 hover:bg-slate-200 transition">🏅 我的徽章</button>'
                      + '<button onclick="openLangPanel()" id="langBtn" class="text-xs bg-slate-100 px-3.5 py-2 rounded-xl font-medium text-slate-600 hover:bg-slate-200 transition">🌐 简体</button>'
                      + '<button onclick="nameBtnClick()" id="nameBtn" class="text-xs bg-slate-100 px-3.5 py-2 rounded-xl font-medium text-slate-600 hover:bg-slate-200 transition">设置姓名</button>'}
            </div>
        </div>
    </header>

    <main class="max-w-7xl mx-auto px-5 pt-8">
        <!-- 标题区 -->
        <h1 class="text-[2rem] leading-tight font-black tracking-tight" data-i18n="myCourses">我的课程</h1>
        <p class="text-slate-400 mt-1 mb-6" data-i18n="heroSub">系统学习，稳步成长</p>

        ${(!isAdmin && notice) ? '<div class="mb-6 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl px-5 py-4 text-sm text-amber-800 flex gap-3"><span class="text-lg">📢</span><span id="noticeBarText" data-notice-en="' + notice_en.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') + '" data-notice-ja="' + notice_ja.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') + '" data-notice-ko="' + notice_ko.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') + '">' + notice.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>' : ''}

        ${!isAdmin ? `
        <!-- 统计卡片 -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div class="bg-violet-50 rounded-3xl p-5 flex items-center gap-4">
                <div class="w-14 h-14 shrink-0 rounded-2xl bg-violet-500 flex items-center justify-center text-white text-2xl shadow-sm">📖</div>
                <div>
                    <div id="statTotal" class="text-3xl font-black text-violet-600 leading-none">–</div>
                    <div class="text-xs text-slate-500 mt-1.5" data-i18n="statAll">全部课程</div>
                </div>
            </div>
            <div class="bg-emerald-50 rounded-3xl p-5 flex items-center gap-4">
                <div class="w-14 h-14 shrink-0 rounded-2xl bg-emerald-500 flex items-center justify-center text-white text-2xl shadow-sm">✓</div>
                <div>
                    <div id="statDone" class="text-3xl font-black text-emerald-600 leading-none">0</div>
                    <div class="text-xs text-slate-500 mt-1.5" data-i18n="statDone">已完成</div>
                </div>
            </div>
            <div class="bg-amber-50 rounded-3xl p-5 flex items-center gap-4">
                <div class="w-14 h-14 shrink-0 rounded-2xl bg-amber-500 flex items-center justify-center text-white text-2xl shadow-sm">◷</div>
                <div>
                    <div id="statDoing" class="text-3xl font-black text-amber-600 leading-none">0</div>
                    <div class="text-xs text-slate-500 mt-1.5" data-i18n="statDoing">进行中</div>
                </div>
            </div>
            <div class="bg-rose-50 rounded-3xl p-5 flex items-center gap-4">
                <div class="w-14 h-14 shrink-0 rounded-2xl bg-rose-500 flex items-center justify-center text-white text-2xl shadow-sm">★</div>
                <div>
                    <div id="statAvg" class="text-3xl font-black text-rose-500 leading-none">--</div>
                    <div class="text-xs text-slate-500 mt-1.5" data-i18n="statAvg">平均分</div>
                </div>
            </div>
        </div>

        <!-- 我的成绩 -->
        <div id="myScoresCard" class="hidden bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-3" data-i18n="myScores">📊 我的成绩</h3>
            <div id="myScoresAvg" class="text-xs text-slate-400 mb-2"></div>
            <ul id="myScoresList" class="space-y-2 max-h-64 overflow-y-auto"></ul>
        </div>
        ` : ''}

        ${isAdmin ? `
        <!-- ══════ 系统设置 ══════ -->
        <div class="text-xs font-black text-slate-400 tracking-widest mb-3 mt-2">⚙️ 系统设置</div>
        <!-- 公告设置 -->
        <div class="admin-only bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-4">📢 首页公告</h3>
            <div class="flex gap-2">
                <input id="noticeText" placeholder="公告内容（学员端首页顶部显示，留空则不显示）" class="flex-1 border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400">
                <button onclick="saveNotice()" class="bg-indigo-900 text-white px-6 rounded-2xl text-sm font-bold">保存</button>
            </div>
        </div>

        <!-- 数据管理 -->
        <div class="admin-only bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-4">🗂️ 数据管理</h3>
            <div class="flex flex-wrap gap-2">
                <button onclick="openImportModal()" class="text-xs bg-violet-100 text-violet-700 px-4 py-2.5 rounded-xl font-bold hover:bg-violet-200 transition">📥 批量导入课程</button>
                <button onclick="exportCSV()" class="text-xs bg-emerald-100 text-emerald-700 px-4 py-2.5 rounded-xl font-bold hover:bg-emerald-200 transition">📤 导出成绩 CSV</button>
                <button onclick="openPwModal()" class="text-xs bg-amber-100 text-amber-700 px-4 py-2.5 rounded-xl font-bold hover:bg-amber-200 transition">🔑 修改管理密码</button>
                <button onclick="adminLogout()" class="text-xs bg-slate-200 text-slate-600 px-4 py-2.5 rounded-xl font-bold hover:bg-slate-300 transition">🚪 退出登录</button>
            </div>
        </div>


        <!-- ══════ 教学内容 ══════ -->
        <div class="text-xs font-black text-slate-400 tracking-widest mb-3 mt-2">📚 教学内容</div>
        <div class="relative mb-5">
            <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg">⌕</span>
            <input id="searchInput" oninput="debouncedFilter()" placeholder="搜索课程…（按标题/系列/子栏目）"
                class="w-full bg-white border border-slate-100 rounded-2xl py-3 pl-11 pr-4 text-sm shadow-sm outline-none focus:ring-2 focus:ring-violet-200 focus:border-violet-300 transition placeholder:text-slate-400">
        </div>
        <!-- 课程体系管理：学习路径 → 系列 → 子栏目 -->
        <div class="admin-only bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-1">🗂️ 课程体系管理</h3>
            <p class="text-xs text-slate-400 mb-5">学习路径是学员首页入口，由系列 / 子栏目中的课程组成；系列简介会显示在学员端对应标题下方。</p>
            <div class="flex items-center justify-between mb-2">
                <h4 class="font-bold text-slate-700 text-sm">🗺️ 学习路径</h4>
                <button onclick="openPathEditor('')" class="text-xs bg-violet-100 text-violet-700 px-4 py-2 rounded-xl font-bold hover:bg-violet-200 transition">＋ 新增路径</button>
            </div>
            <div id="pathAdminList" class="space-y-3 mb-6"><div class="text-sm text-slate-400">加载中…</div></div>
            <div class="border-t border-slate-100 pt-5">
                <div class="flex items-center justify-between mb-2">
                    <h4 class="font-bold text-slate-700 text-sm">📚 系列与子栏目</h4>
                    <button onclick="openCatModal('', '')" class="text-xs bg-violet-100 text-violet-700 px-4 py-2 rounded-xl font-bold hover:bg-violet-200 transition">＋ 新增系列</button>
                </div>
                <div id="catList" class="space-y-3"><div class="text-sm text-slate-400">加载中…</div></div>
            </div>
        </div>


        <!-- 课程列表（带编辑按钮） -->
        <div class="admin-only bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-1">📝 课程列表</h3>
            <p class="text-xs text-slate-400 mb-4">所有课程，卡片右上角可编辑、排序、导出、删除。</p>
            <div id="courseSections"></div>
            <div id="loadingState" class="text-center text-slate-400 py-16 text-sm">课程加载中…</div>
            <div id="emptyState" class="hidden text-center text-slate-400 py-16 text-sm">没有找到匹配的课程</div>
        </div>

        <!-- ══════ 学员与班级 ══════ -->
        <div class="text-xs font-black text-slate-400 tracking-widest mb-3 mt-8">👥 学员与班级</div>
        <!-- 班级管理 -->
        <div class="admin-only bg-white rounded-3xl p-6 shadow-sm mb-6">
            <div class="flex items-center justify-between mb-2">
                <h3 class="font-bold text-slate-800">👥 班级管理</h3>
                <button onclick="adminNewClass()" class="text-xs bg-violet-100 text-violet-700 px-4 py-2 rounded-xl font-bold hover:bg-violet-200 transition">＋ 新建班级</button>
            </div>
            <p class="text-xs text-slate-400 mb-4">创建班级、指定小组长，学员可加入班级一起学习。</p>
            <div id="adminClassForm"></div>
            <div id="adminClassesBox" class="space-y-3"><div class="text-sm text-slate-400">加载中…</div></div>
        </div>

        <!-- 学员管理员 -->
        <div class="admin-only bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-2">👑 学员管理员</h3>
            <p class="text-xs text-slate-400 mb-3">设为管理员的学员，在学员端打开课件可直接查看答案（无需答题），按钮在课件顶部右侧。</p>
            <ul id="adminStudentList" class="space-y-2"><li class="text-sm text-slate-400">加载中…</li></ul>
        </div>

        <!-- 按姓名查成绩 -->
        <div class="admin-only bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-4">🔍 按姓名查成绩</h3>
            <div class="flex gap-2">
                <input id="scoreQueryName" placeholder="输入学员姓名" class="flex-1 border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400">
                <button onclick="queryScores()" class="bg-indigo-900 text-white px-6 rounded-2xl text-sm font-bold">查询</button>
            </div>
            <div class="flex gap-2 mt-2">
                <select id="studentSelect" onchange="pickStudent(this.value)" class="flex-1 border border-slate-200 rounded-2xl px-4 py-2.5 text-sm outline-none focus:border-indigo-400 bg-white text-slate-600">
                    <option value="">📋 学员名单加载中…</option>
                </select>
                <button onclick="loadStudents()" class="border border-slate-200 px-4 rounded-2xl text-sm text-slate-500 shrink-0">刷新</button>
            </div>
            <div id="scoreSummary" class="hidden text-xs text-slate-400 mt-3"></div>
            <ul id="scoreList" class="space-y-3 mt-3"></ul>
            <div id="scoreEmpty" class="hidden text-slate-400 text-sm mt-3">暂无该学员的成绩记录</div>
            <button id="delAllScoresBtn" onclick="deleteAllScores()" class="hidden mt-3 text-xs font-bold text-red-500 border border-red-200 rounded-2xl px-4 py-2">🗑 删除该学员全部成绩</button>
            <button id="viewAllWrongsBtn" onclick="adminViewAllWrongs()" class="hidden mt-3 ml-2 text-xs font-bold text-violet-600 border border-violet-200 rounded-2xl px-4 py-2">📝 查看该学员错题</button>
        </div>


        <!-- ══════ 数据统计 ══════ -->
        <div class="text-xs font-black text-slate-400 tracking-widest mb-3 mt-8">📊 数据统计</div>
        <!-- 数据看板 -->
        <div class="admin-only bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-4">📊 数据看板</h3>
            <div id="adminStatsBox"><div class="text-sm text-slate-400">加载中…</div></div>
        </div>


        <!-- 系列/子栏目编辑弹窗 -->
        <div id="catModal" class="hidden fixed inset-0 bg-slate-900/95 z-[75] flex items-center justify-center p-4">
            <div class="bg-white rounded-3xl w-full max-w-md p-8 shadow-2xl relative">
                <button onclick="toggleModal('catModal')" class="absolute top-4 right-4 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full text-lg">✕</button>
                <h2 class="font-black text-lg mb-5 pr-8" id="catModalTitle">＋ 新增系列</h2>
                <input id="cat_parent" type="hidden">
                <input id="cat_old" type="hidden">
                <input id="cat_name" placeholder="名称" class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-3">
                <div id="cat_ab_wrap" class="hidden mb-3">
                    <label class="text-xs font-bold text-slate-500 mb-1 block">A（实心徽章）</label>
                    <input id="cat_name_a" placeholder="如：新约" class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-2">
                    <label class="text-xs font-bold text-slate-500 mb-1 block">B（描边徽章）</label>
                    <input id="cat_name_b" placeholder="如：保罗书信" class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400">
                </div>
                <textarea id="cat_desc" placeholder="简介（学员端可见，可空）" class="w-full h-32 border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-5"></textarea>
                <div class="flex gap-3">
                    <button onclick="saveCat()" class="flex-1 bg-indigo-900 text-white py-3 rounded-2xl font-bold">保存</button>
                    <button onclick="toggleModal('catModal')" class="bg-slate-200 text-slate-600 px-6 py-3 rounded-2xl font-bold">取消</button>
                </div>
            </div>
        </div>
        ` : ''}

        ${!isAdmin ? `
        <!-- 全站搜索框（学习路径上方常驻） -->
        <div class="relative mb-8">
            <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg">⌕</span>
            <input id="searchInput" oninput="debouncedFilter()" data-i18n-ph="searchPh" placeholder="搜索课程..."
                class="w-full bg-white border border-slate-100 rounded-2xl py-3.5 pl-11 pr-4 text-sm shadow-sm outline-none focus:ring-2 focus:ring-violet-200 focus:border-violet-300 transition placeholder:text-slate-400">
        </div>

        <!-- 学习路径（首页主入口） -->
        <div id="pathsRoot" class="max-w-4xl mx-auto"></div>

        <!-- 全部课程目录（默认隐藏，经导航按钮切换显示） -->
        <div id="catalogWrap" style="display:none">
        <div class="mb-4"><button onclick="showHomeView('paths')" data-i18n="backToPaths" class="text-sm font-bold text-indigo-600 hover:text-indigo-800">← 学习路径</button></div>

        <!-- 课程分区（JS 按栏目渲染） -->
        <div id="courseSections"></div>
        <div id="loadingState" class="text-center text-slate-400 py-16 text-sm">课程加载中…</div>
        <div id="emptyState" class="hidden text-center text-slate-400 py-16 text-sm" data-i18n="emptyResult">没有找到匹配的课程</div>
        </div><!-- /catalogWrap -->

        <!-- 班级/徽章/数据看板统一渲染出口（默认隐藏） -->
        <div id="socialRoot" class="max-w-4xl mx-auto" style="display:none"></div>
        ` : ''}
    </main>
    ${!isAdmin ? '<footer class="max-w-7xl mx-auto px-5 mt-6 text-center"><a href="/admin" data-i18n="adminEntry" class="text-xs text-slate-300 hover:text-violet-500 transition">教师管理入口 →</a></footer>' : ''}

    <!-- 答题 / 学习弹窗 -->
    <div id="lessonModal" class="hidden fixed inset-0 bg-white z-[80] overflow-y-auto">
        <div class="w-full max-w-7xl mx-auto px-3 md:px-6 py-6 pb-32">
            <div id="lessonHeader"></div>
            <div id="studyProg" class="hidden mt-4 text-sm font-bold text-violet-600"></div>
            <div id="lessonBody" class="mt-10 space-y-4"></div>
            <div id="lessonFooter" class="mt-12 pt-10 border-t">
                <div id="resultArea" class="hidden mt-8 space-y-4"></div>
                <button id="backListBtn" onclick="location.reload()" data-i18n="backList" class="mt-10 w-full text-slate-400 text-sm hover:underline">返回列表</button>
            </div>
        </div>
    </div>

    ${!isAdmin ? `
    <!-- 错题本弹窗 -->
    <div id="wrongBookModal" class="hidden fixed inset-0 bg-slate-900/60 z-[90] flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
            <div class="p-6 border-b flex items-center justify-between">
                <h2 id="wrongBookTitle" class="font-black text-lg" data-i18n="wbMyT">📝 我的错题本</h2>
                <div class="flex gap-2">
                    <button onclick="openWrongExportMenu()" data-i18n="exportBtn" class="text-xs bg-emerald-600 text-white px-4 py-2 rounded-xl font-bold">📥 导出</button>
                    <button onclick="clearWrongBook()" data-i18n="clearBtn" class="text-xs bg-red-50 text-red-500 px-4 py-2 rounded-xl font-bold">清空</button>
                    <button onclick="toggleModal('wrongBookModal')" class="text-xs bg-slate-100 text-slate-500 px-4 py-2 rounded-xl font-bold">关闭</button>
                </div>
            </div>
            <div id="wrongBookList" class="p-6 overflow-y-auto space-y-4"></div>
        </div>
    </div>
    ` : ''}

    ${isAdmin ? `
    <!-- 编辑弹窗 -->
    <div id="editModal" class="hidden fixed inset-0 bg-slate-900/95 z-[70] flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl w-full max-w-7xl h-[90vh] flex flex-col md:flex-row overflow-hidden shadow-2xl relative">
            <button onclick="toggleModal('editModal')" class="absolute top-3 right-3 z-10 w-9 h-9 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full text-xl bg-white/80">✕</button>
            <div class="md:hidden flex bg-slate-100 m-3 mb-0 rounded-xl p-1 text-sm font-bold shrink-0">
                <button type="button" id="emTabInfo" onclick="switchEmTab('info')" class="flex-1 py-2 rounded-lg bg-white shadow">📝 基本信息</button>
                <button type="button" id="emTabQuiz" onclick="switchEmTab('quiz')" class="flex-1 py-2 rounded-lg">🧩 题目编辑</button>
            </div>
            <div id="emPaneInfo" class="w-full md:w-1/3 p-6 border-r overflow-y-auto space-y-4 bg-slate-50">
                <h2 class="font-black text-indigo-900 text-xs">内容录入</h2>
                <textarea id="importText" class="w-full h-40 border p-3 rounded-xl text-xs" placeholder="粘贴题目...（## 开头表示章节名；填空题含 ____ 会自动识别为填空）"></textarea>
                <button onclick="smartParse()" class="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold text-sm">✨ 智能解析</button>
                <hr>
                <input id="f_id" type="hidden">
                <select id="f_series" onchange="onSeriesChange()" class="w-full border p-3 rounded-xl text-sm bg-white" title="所属系列"></select>
                <input id="f_series_new" placeholder="新系列名称" class="w-full border p-3 rounded-xl text-sm hidden">
                <select id="f_sub" class="w-full border p-3 rounded-xl text-sm bg-white" title="所属子栏目"></select>
                <input id="f_sub_new" placeholder="新子栏目名称" class="w-full border p-3 rounded-xl text-sm hidden">
                <input id="f_title" placeholder="课件标题" class="w-full border p-3 rounded-xl font-bold">
                <textarea id="f_content" placeholder="导读内容..." class="w-full h-32 border p-3 rounded-xl text-sm"></textarea>
                <div class="border border-indigo-100 rounded-xl p-3 bg-indigo-50/50">
                    <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
                        <h3 class="text-xs font-black text-indigo-900">🗺️ 课程导览（思维导图式）</h3>
                        <div class="flex items-center gap-2">
                            <div class="flex bg-white rounded-lg p-0.5 text-[11px] font-bold border border-indigo-100">
                                <button type="button" id="gModeVisual" class="px-2.5 py-1 rounded-md">🧩 可视化</button>
                                <button type="button" id="gModeJson" class="px-2.5 py-1 rounded-md">📝 JSON</button>
                            </div>
                            <button type="button" id="guideAddCh" class="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-bold">+ 添加章节</button>
                        </div>
                    </div>
                    <div id="guideEditor" class="space-y-3"></div>
                    <textarea id="guideJson" spellcheck="false" class="hidden w-full h-48 border p-3 rounded-xl text-xs font-mono bg-white" placeholder='[{"title":"1. 章节名","points":["要点一","要点二"]}]'></textarea>
                    <p class="text-[11px] text-slate-400 mt-2">分章节一条条加小结，学员端"课程导读"页会渲染成章节卡片。</p>
                </div>
                <textarea id="f_instructions" placeholder="答题说明（留空则自动生成）..." class="w-full h-20 border p-3 rounded-xl text-sm"></textarea>
                <textarea id="f_video" rows="3" placeholder="视频链接（可选，一行一个；格式：名称|链接，如：&#10;YouTube|https://youtu.be/xxx&#10;企业微盘|https://drive.weixin.qq.com/...&#10;只写链接也行，会自动识别网站名）" class="w-full border p-3 rounded-xl text-sm"></textarea>
            </div>
            <div id="emPaneQuiz" class="flex-1 p-6 hidden md:flex flex-col overflow-hidden">
                <div class="flex items-center gap-2 mb-3 flex-wrap">
                    <div class="flex bg-slate-100 rounded-lg p-0.5 text-xs font-bold">
                        <button type="button" id="qModeVisual" class="px-3 py-1.5 rounded-md">🧩 可视化</button>
                        <button type="button" id="qModeJson" class="px-3 py-1.5 rounded-md">📝 JSON 代码</button>
                    </div>
                    <button type="button" id="qJsonFormat" class="hidden text-xs text-indigo-600 font-bold">✨ 格式化</button>
                    <span class="text-[11px] text-slate-400">JSON 数组，每题含 type/s/q/o/a</span>
                </div>
                <div id="quizList" class="flex-1 overflow-y-auto space-y-4 pr-2"></div>
                <textarea id="quizJson" spellcheck="false" class="hidden flex-1 w-full border p-3 rounded-xl text-xs font-mono overflow-y-auto" placeholder='[{"type":"single","s":"第一章","q":"题干","o":"A.xxx, B.xxx","a":"A"}]'></textarea>
                <div class="mt-4 pt-4 border-t flex gap-3">
                    <button onclick="saveAll()" class="flex-1 bg-indigo-900 text-white px-10 py-3 rounded-xl font-bold">发布</button>
                    <button onclick="toggleModal('editModal')" class="bg-slate-200 text-slate-600 px-6 py-3 rounded-xl font-bold">取消</button>
                </div>
            </div>
        </div>
    </div>

    <!-- 批量导入弹窗 -->
    <div id="importModal" class="hidden fixed inset-0 bg-slate-900/95 z-[75] flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
            <div class="p-6 border-b">
                <h2 class="font-black text-lg">📥 批量导入课程</h2>
                <p class="text-xs text-slate-400 mt-1">粘贴 JSON（可一次导入多门课程）。type 可选 single / multiple / fill / judge / essay / verse（经文框，o 填框标题）；s 为章节名（有章节时自动分组显示）；填空用 ____ 占位（下划线越多空格越宽）；填空多空格答案用 | 或 ； 分空按顺序对应，每空内多个可接受答案用 / 或"或"分隔（如 失败/软弱；互动关系，答"失败"或"软弱"都对）；category 为系列名，subcategory 为子栏目名（可空）</p>
            </div>
            <div class="p-6 flex-1 overflow-y-auto">
                <textarea id="importJson" class="w-full h-64 border p-3 rounded-xl text-xs font-mono" placeholder='{"courses":[{"category":"基要真理","subcategory":"第一部分","title":"第一课","content":"导读…","video_url":"","guide":[{"title":"1. 章节名","points":["要点一","要点二"]}],"instructions":"自定义答题说明（可空）","quizzes":[{"type":"fill","s":"第一章 信仰的本质","q":"人是按____所造的","a":"神的形象"}]}]}'></textarea>
            </div>
            <div class="p-6 border-t flex gap-3">
                <button onclick="doImport()" class="flex-1 bg-violet-600 text-white py-3 rounded-xl font-bold">开始导入</button>
                <button onclick="toggleModal('importModal')" class="bg-slate-200 text-slate-600 px-6 py-3 rounded-xl font-bold">取消</button>
            </div>
        </div>
    </div>

    <!-- 修改密码弹窗 -->
    <div id="pwModal" class="hidden fixed inset-0 bg-slate-900/95 z-[75] flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl w-full max-w-sm p-8 shadow-2xl">
            <h2 class="font-black text-lg mb-5">🔑 修改管理密码</h2>
            <input id="pw_old" type="password" placeholder="原密码" class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-3">
            <input id="pw_new" type="password" placeholder="新密码（至少 6 位）" class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-5">
            <div class="flex gap-3">
                <button onclick="doChangePassword()" class="flex-1 bg-indigo-900 text-white py-3 rounded-2xl font-bold">确认修改</button>
                <button onclick="toggleModal('pwModal')" class="bg-slate-200 text-slate-600 px-6 py-3 rounded-2xl font-bold">取消</button>
            </div>
            <div class="mt-5 pt-5 border-t border-slate-100 text-left">
                <h3 class="font-bold text-sm text-slate-700 mb-1">🆘 密码恢复码</h3>
                <p class="text-xs text-slate-400 mb-3">忘记管理密码时，凭恢复码重设。请记在可靠的地方，不要告诉他人。</p>
                <div class="flex gap-2">
                    <input id="rc_set" type="password" placeholder="恢复码（至少 6 位）" class="flex-1 border border-slate-200 rounded-2xl px-4 py-2.5 text-sm outline-none focus:border-indigo-400">
                    <button onclick="setRecoveryCode()" class="bg-amber-500 text-white px-5 rounded-2xl font-bold text-sm">设置</button>
                </div>
            </div>
        </div>
    </div>
    ` : ''}

    ${isAdmin ? `
    <!-- 教师管理密码门 -->
    <div id="adminGate" ${adminAuthed ? 'style="display:none"' : ''} class="fixed inset-0 z-[100] bg-indigo-950 flex items-center justify-center p-6">
        <div class="bg-white rounded-3xl p-8 w-full max-w-sm text-center shadow-2xl">
            <div class="text-4xl mb-3">🔐</div>
            <h2 class="font-black text-lg text-slate-900">教师管理</h2>
            <p class="text-slate-400 text-sm mt-1 mb-5">请输入管理密码进入</p>
            <input id="adminPwd" type="password" placeholder="管理密码" onkeydown="if(event.key==='Enter')adminLogin()" oninput="hideAdminErr()"
                class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-2 text-center">
            <p id="adminErr" class="hidden text-red-500 text-xs mb-2"></p>
            <button onclick="adminLogin()" class="w-full bg-indigo-900 text-white py-3.5 rounded-2xl font-bold">进入管理端</button>
            <a href="javascript:void(0)" onclick="openRecoverModal()" class="block mt-3 text-indigo-400 text-xs hover:underline">忘记密码？</a>
            <a href="/" class="block mt-4 text-slate-400 text-sm hover:underline">返回学员端</a>
        </div>
    </div>

    <!-- 管理密码找回弹窗 -->
    <div id="recoverModal" class="hidden fixed inset-0 z-[100] bg-indigo-950/95 flex items-center justify-center p-6">
        <div class="bg-white rounded-3xl p-8 w-full max-w-sm text-center shadow-2xl">
            <div class="text-4xl mb-3">🆘</div>
            <h2 class="font-black text-lg text-slate-900">找回管理密码</h2>
            <p class="text-slate-400 text-xs mt-1 mb-5">输入密码恢复码（在管理端"修改管理密码"中设置）</p>
            <input id="rc_code" type="password" placeholder="密码恢复码" oninput="hideRcErr()"
                class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-3 text-center">
            <input id="rc_new" type="password" placeholder="新管理密码（至少 6 位）" oninput="hideRcErr()"
                class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-2 text-center">
            <p id="rcErr" class="hidden text-red-500 text-xs mb-3"></p>
            <button onclick="doAdminRecover()" class="w-full bg-indigo-900 text-white py-3.5 rounded-2xl font-bold">重设密码并进入</button>
            <button onclick="toggleModal('recoverModal')" class="mt-3 text-slate-400 text-sm hover:underline">取消</button>
        </div>
    </div>` : ''}
    <script>
        var allData = [];
        var catRows = [];  /* 系列树 */
        var catInfo = {};  /* 系列名 -> {description, subDesc, i18n, subI18n}（学员端展示用） */
        /* 系列/子栏目名称简介多语言：en/ja/ko 用 i18n，否则用原文（tw 走 toTW） */
        function catNameL(cat) {
            var L = curLang();
            if ((L === 'en' || L === 'ja' || L === 'ko') && catInfo[cat] && catInfo[cat].i18n && catInfo[cat].i18n[L]) {
                return catInfo[cat].i18n[L].name || cat;
            }
            return cat;
        }
        function catDescL(cat) {
            var L = curLang();
            if ((L === 'en' || L === 'ja' || L === 'ko') && catInfo[cat] && catInfo[cat].i18n && catInfo[cat].i18n[L]) {
                return catInfo[cat].i18n[L].description || catInfo[cat].description;
            }
            return catInfo[cat] ? catInfo[cat].description : "";
        }
        function subNameL(cat, sub) {
            var L = curLang();
            if ((L === 'en' || L === 'ja' || L === 'ko') && catInfo[cat] && catInfo[cat].subI18n && catInfo[cat].subI18n[sub] && catInfo[cat].subI18n[sub][L]) {
                return catInfo[cat].subI18n[sub][L].name || sub;
            }
            return sub;
        }
        function subDescL(cat, sub) {
            var L = curLang();
            if ((L === 'en' || L === 'ja' || L === 'ko') && catInfo[cat] && catInfo[cat].subI18n && catInfo[cat].subI18n[sub] && catInfo[cat].subI18n[sub][L]) {
                return catInfo[cat].subI18n[sub][L].description || "";
            }
            return (catInfo[cat] && catInfo[cat].subDesc) ? (catInfo[cat].subDesc[sub] || "") : "";
        }
        var activeQuizzes = [];
        var activeLessonId = null;
        var activeCourseTitle = "";
        var activeCategory = "";
        var activeSubcategory = "";
        var teacherMode = false;
        var USER_KEY = "FELLOW_V12";
        var PROG_KEY = "FELLOW_PROG_V1";
        var WRONG_KEY = "FELLOW_WRONG_V1";
        var BOOT = window.__BOOT__ || { shareMode: false, isAdmin: false, adminAuthed: false, list: [] };
/* ===== 多语言 i18n（学员端）：简/繁/英/日/韩，默认简体；管理端保持简体 ===== */
var LANG_KEY = 'TQ_LANG_V1';
var LANGS = [['zh', '简体中文', '简体'], ['tw', '繁體中文', '繁體'], ['en', 'English', 'EN'], ['ja', '日本語', '日本語'], ['ko', '한국어', '한국어']];
function curLang() { try { return localStorage.getItem(LANG_KEY) || 'zh'; } catch (e) { return 'zh'; } }
function setLang(l) { try { localStorage.setItem(LANG_KEY, l); } catch (e) {} location.reload(); }
function langShort(l) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === l) return LANGS[i][2]; return l; }
var I18N = {
zh: {
/* P0/P1/P2 学习路径+证书 */
path_title: '学习路径', path_myCerts: '我的证书', path_continue: '继续学习', path_start: '开始学习', path_doneOf: '已完成 {a}/{b} 门', path_completed: '已完成 ✓', path_empty: '暂无学习路径', path_back: '← 返回路径列表', social_back: '← 返回', path_loginFirst: '请先设置学员姓名，进度将记在该姓名下', path_loadFail: '加载失败，请重试', path_viewCert: '查看证书', path_courseMissing: '课程已下架', cert_title: '学习证书', cert_awarded: '兹证明', cert_completedPath: '已圆满完成学习路径', cert_no: '证书编号', cert_date: '颁发日期', cert_print: '🖨 打印证书', cert_empty: '还没有证书，完成一条学习路径后将自动颁发', cert_congrats: '🎉 恭喜完成整条路径！证书已颁发', allCourses: '📚 全部课程', backToPaths: '← 学习路径',
appName: '团契智学', wrongBook: '📝 错题本', setName: '设置姓名', langT: '选择语言', cancel: '取消',
searchPh: '搜索课程...', statAll: '全部课程', statDone: '已完成', statDoing: '进行中', statAvg: '平均分',
startLearning: '开始学习', loading: '加载中...', videoBadge: '🎬 视频', copyLinkT: '复制分享链接', nLessons: '{n} 课', emptyResult: '没有找到匹配的课程',
stDone: '已完成', stDoing: '进行中', stNot: '未开始',
backList: '← 返回课程列表', backHome: '← 返回智学课程系统', studentIs: '学员：', changeBtn: '更换', loginReg: '登录 / 注册',
tabGuide: '📚 课程导读', tabReport: '📊 成绩报告',
tyVerse: '经文诵读', tyFill: '填空题', tySingle: '单项选择题', tyMulti: '多项选择题', tyJudge: '判断题', tyEssay: '问答与思辨',
nQuestions: '{n}题', teacherBtn: '🔑 教师版查看答案', allAnswers: '📖 查看全套参考答案',
watchVideo: '观看课程视频', videoMulti: '{n}个视频源，点击选择',
modeChapters: '专题课件 · 分章互动版', modeQuiz: '互动答题 · 即时核对版',
checkBtn: '核对答案', checking: '核对中…', fillActive: '请填写完所有{n}个空格以激活核对功能',
needName: '请先在页面上方设置学员姓名，成绩将记在该姓名下。', notComplete: '还有未填写的内容，请填写完整后再核对。',
checkFail: '核对失败，请检查网络后重试', fillDoneToast: '🎉 填写完成！现在可以核对答案了', progFill: '进度：已填写 {a}/{b}',
vOk: '✓ 回答正确', vNg: '✗ 回答错误', vOpen: '○ 开放性答案，请对照参考自评',
yourAns: '你的答案：', rightAns: '正确答案：', multiTag: '（多选）', coreVerse: '核心经文', essayPh: '输入你的回答...',
repWait: '待核对', repHint: '全部填写完成后，点击「核对答案」即可在这里看到得分与掌握评级。',
rateTop: '融会贯通', rateGood: '掌握良好', rateRetry: '需再复习', rateGo: '继续加油',
repDone: '核对完成，成绩已上传；错题已自动加入错题本。如需重做，可点击「返回修改填写」或「重新作答」。',
backEdit: '返回修改填写', scoreDone: '核对完成：{s}（成绩已上传）', scoreUnit: ' · 得分',
loginT: '👤 学员登录', regT: '👤 学员注册',
loginD: '请输入姓名与密码，成绩与错题本将记在此名下。', loginNeedQuiz: '答题需先登录，成绩与错题本将记在此名下。', regD: '首次使用请设置登录密码，请牢记。',
namePh: '学员姓名', pwPh: '密码（至少4位）', pw2Ph: '确认密码', doLogin: '登 录', doReg: '注 册',
goReg: '首次使用？点此注册', goLogin: '已有账号？点此登录', forgotPw: '忘记密码？请联系老师重置',
errName: '请输入姓名', errPw: '密码至少4位', errPw2: '两次输入的密码不一致',
doing: '处理中…', opFail: '操作失败，请重试', netErr: '网络错误，请重试',
logoutAsk: '退出当前学员（{name}）？\\n该姓名下的错题本与本地学习记录会保留，下次登记同一姓名可继续查看。',
welcome: '欢迎 {name} 开启学习之旅！',
wbT: '📝 错题本', wbMyT: '📝 我的错题本',
wbEmptyC: '本课件暂无错题，答错的题目会自动收录在这里', wbEmpty: '错题本是空的，答错的题目会自动收录在这里',
wbU: '你的答案：', wbE: '正确参考：', wbNA: '（未填）',
wbClearC: '确定清空本课件的错题记录？', wbClearA: '确定清空错题本？', wbAnon: '匿名学员',
vidEntry: '视频入口：', vidSimple: '精简显示', vidAll: '全部显示', vidToggle: '（点击切换）',
vidWx: '需在微信中打开观看', vidWxT: '请在微信中打开',
vidWxD1: '这个视频需要在微信内观看<br>点击下方按钮复制链接', vidCopy: '复制视频链接',
vidWxD2: '复制后发送到微信任意聊天<br>点开链接即可观看',
vidChoose: '选择视频源', vidChooseD: '请选择一个视频链接打开观看',
fontT: '字体', fontS: '小', fontM: '标准', fontL: '较大', fontXL: '大', fontXXL: '特大',
toDesk: '切换到桌面版', toMob: '切换到移动版', linkCopied: '链接已复制！',
resetBtn: '重置', vidEntryT: '视频入口设置',
vidSetD: '选择视频内容的显示方式，选一次即可记住', vidSimpleD: '部分视频入口将不显示，页面更简洁', vidAllD: '显示全部视频入口',
vidLater: '稍后再说', fontZoomIn: '放大字体', fontZoomOut: '缩小字体', fontResetT: '恢复标准字号',
courseWord: '课程', onlineLesson: '在线互动课件', secDefault: '本课内容', quizGuideT: '答题说明：',
defaultGuide: '本课共{summary}。请按上方页签逐项作答，全部填写完成后点击底部「核对答案」查看判分与解析；错题会自动进入错题本，方便复习。',
multiTypes: '多种题型', startQuiz: '开始答题 →',
reportT: '答题成绩与复习报告', reportSub: '· 综合测评', repAnswered: '已答客观题', repObjScore: '客观题得分',
repRating: '理解掌握评级', redoBtn: '↺ 重新作答', srcFrom: '课程来源：',
prevType: '← 上一题型：', nextType: '下一题型：', viewReport: '查看成绩报告 →', qrefToggle: '📖 显示/隐藏参考答案',
myCourses: '我的课程', heroSub: '系统学习，稳步成长', myScores: '📊 我的成绩', exportBtn: '📥 导出', clearBtn: '清空',
scoreSummary: '共 {n} 条记录', scoreAvg: '，平均 {a} 分',
expWrongT: '📥 导出错题本', wbExpSub: '{name} · 共{n}题', wbScopeOne: '（本课件）', wbScopeAll: '（全部课件）',
adminEntry: '教师管理入口 →', teacherExit: '✓ 退出教师版', tchExpired: '登录已过期，请重新登录', tchPwPrompt: '请输入管理密码进入教师版：',
tchPwWrong: '密码错误', tchAnsFail: '获取答案失败', tchAnsT: '📖 教师版答案：', tchOpenAns: '开放性答案',
wbEmptyAlert: '错题本是空的', popupBlocked: '浏览器阻止了新窗口，请允许弹窗后重试'
},
en: {
/* P0/P1/P2 学习路径+证书 */
path_title: 'Learning Paths', path_myCerts: 'My Certificates', path_continue: 'Continue', path_start: 'Start Learning', path_doneOf: '{a}/{b} completed', path_completed: 'Completed ✓', path_empty: 'No learning paths yet', path_back: '← Back to Paths', social_back: '← Back', path_loginFirst: 'Please set your student name first; progress will be saved under it', path_loadFail: 'Failed to load, please retry', path_viewCert: 'View Certificate', path_courseMissing: 'Course unavailable', cert_title: 'Certificate of Completion', cert_awarded: 'This is to certify that', cert_completedPath: 'has successfully completed the learning path', cert_no: 'Certificate No.', cert_date: 'Date Issued', cert_print: '🖨 Print Certificate', cert_empty: 'No certificates yet. One will be issued automatically when you complete a path.', cert_congrats: '🎉 Congratulations on completing the path! Your certificate has been issued.', allCourses: '📚 All Courses', backToPaths: '← Learning Paths',
appName: 'Fellowship Study',
wrongBook: '📝 Wrong Answers',
setName: 'Set Name',
langT: 'Choose Language',
cancel: 'Cancel',
searchPh: 'Search courses...',
statAll: 'Total Courses',
statDone: 'Completed',
statDoing: 'In Progress',
statAvg: 'Avg Score',
startLearning: 'Start Learning', loading: 'Loading...',
videoBadge: '🎬 Video',
copyLinkT: 'Copy share link',
nLessons: '{n} lessons',
emptyResult: 'No matching courses found',
stDone: 'Completed',
stDoing: 'In Progress',
stNot: 'Not Started',
backList: '← Back to Course List',
backHome: '← Back to Fellowship Study',
studentIs: 'Student: ',
changeBtn: 'Change',
loginReg: 'Login / Register',
tabGuide: '📚 Course Guide',
tabReport: '📊 Score Report',
tyVerse: 'Scripture Reading',
tyFill: 'Fill in the Blanks',
tySingle: 'Single Choice',
tyMulti: 'Multiple Choice',
tyJudge: 'True / False',
tyEssay: 'Q & A',
nQuestions: '{n} questions',
teacherBtn: '🔑 Teacher Answer View',
allAnswers: '📖 View Full Answer Key',
watchVideo: 'Watch Course Video',
videoMulti: '{n} video sources — tap to choose',
modeChapters: 'Thematic Course · Chapter Interactive',
modeQuiz: 'Interactive Quiz · Instant Check',
checkBtn: 'Check Answers',
checking: 'Checking…',
fillActive: 'Fill in all {n} blanks to activate checking',
needName: 'Please set your student name at the top first. Scores will be recorded under that name.',
notComplete: 'Some items are still blank. Please complete them before checking.',
checkFail: 'Check failed. Please check your network and retry.',
fillDoneToast: '🎉 All filled! You can check your answers now.',
progFill: 'Progress: {a} / {b} filled',
vOk: '✓ Correct',
vNg: '✗ Incorrect',
vOpen: '○ Open-ended — please self-review against the reference',
yourAns: 'Your answer: ',
rightAns: 'Correct answer: ',
multiTag: '(Multiple)',
coreVerse: 'Core Verse',
essayPh: 'Type your answer...',
repWait: 'Pending',
repHint: 'Once everything is filled in, tap "Check Answers" to see your score and mastery rating here.',
rateTop: 'Excellent',
rateGood: 'Good',
rateRetry: 'Needs Review',
rateGo: 'Keep Going',
repDone: 'Check complete. Score uploaded and mistakes added to your wrong-answer book. To redo, tap "Edit Answers" or "Retry".',
backEdit: 'Edit Answers',
scoreDone: 'Checked: {s} (score uploaded)',
scoreUnit: ' · Score',
loginT: '👤 Student Login',
regT: '👤 Student Register',
loginD: 'Enter your name and password. Scores and wrong answers are saved under this name.', loginNeedQuiz: 'Please log in to answer. Scores and wrong answers are saved under this name.',
regD: 'First time? Set a login password and remember it.',
namePh: 'Student name',
pwPh: 'Password (min 4 chars)',
pw2Ph: 'Confirm password',
doLogin: 'Login',
doReg: 'Register',
goReg: 'First time? Register here',
goLogin: 'Have an account? Login here',
forgotPw: 'Forgot password? Ask your teacher to reset it.',
errName: 'Please enter your name',
errPw: 'Password must be at least 4 characters',
errPw2: 'The two passwords do not match',
doing: 'Processing…',
opFail: 'Operation failed. Please retry.',
netErr: 'Network error. Please retry.',
logoutAsk: 'Log out student ({name})?\\nWrong answers and local progress under this name will be kept.',
welcome: 'Welcome, {name}! Begin your learning journey!',
wbT: '📝 Wrong Answers',
wbMyT: '📝 My Wrong Answers',
wbEmptyC: 'No mistakes in this course yet. Wrong answers will be collected here automatically.',
wbEmpty: 'Your wrong-answer book is empty. Mistakes will be collected here automatically.',
wbU: 'Your answer: ',
wbE: 'Correct answer: ',
wbNA: '(blank)',
wbClearC: 'Clear wrong answers for this course?',
wbClearA: 'Clear the whole wrong-answer book?',
wbAnon: 'Anonymous',
vidEntry: 'Video source: ',
vidSimple: 'Simple',
vidAll: 'All',
vidToggle: '(tap to switch)',
vidWx: 'Open in WeChat to watch',
vidWxT: 'Please open in WeChat',
vidWxD1: 'This video must be watched inside WeChat.<br>Tap the button below to copy the link.',
vidCopy: 'Copy Video Link',
vidWxD2: 'After copying, send it to any WeChat chat<br>and open the link to watch.',
vidChoose: 'Choose Video Source',
vidChooseD: 'Pick a video link to watch',
fontT: 'Font',
fontS: 'S',
fontM: 'M',
fontL: 'L',
fontXL: 'XL',
fontXXL: 'XXL',
toDesk: 'Switch to desktop view',
toMob: 'Switch to mobile view',
linkCopied: 'Link copied!',
resetBtn: 'Reset',
vidEntryT: 'Video Source Settings',
vidSetD: 'Choose how video entries are displayed. Your choice will be remembered.',
vidSimpleD: 'Some video entries will be hidden for a cleaner page',
vidAllD: 'Show all video entries',
vidLater: 'Later',
fontZoomIn: 'Increase font size',
fontZoomOut: 'Decrease font size',
fontResetT: 'Reset to default size',
courseWord: 'Course',
onlineLesson: 'Interactive Lesson',
secDefault: 'Lesson Content',
quizGuideT: 'Instructions: ',
defaultGuide: 'This lesson covers {summary}. Answer each tab above in order. When everything is filled in, tap "Check Answers" at the bottom to see your score and feedback. Mistakes are saved to your wrong-answer book for review.',
multiTypes: 'various question types',
startQuiz: 'Start Quiz →',
reportT: 'Quiz Score & Review Report',
reportSub: '· Overall Assessment',
repAnswered: 'Objective Answered',
repObjScore: 'Objective Score',
repRating: 'Mastery Rating',
redoBtn: '↺ Retry',
srcFrom: 'Source: ',
prevType: '← Previous: ',
nextType: 'Next: ',
viewReport: 'View Score Report →',
qrefToggle: '📖 Show / Hide Reference',
myCourses: 'My Courses', heroSub: 'Study systematically, grow steadily', myScores: '📊 My Scores', exportBtn: '📥 Export', clearBtn: 'Clear',
scoreSummary: '{n} records', scoreAvg: ', avg {a}',
expWrongT: '📥 Export Mistakes', wbExpSub: '{name} · {n} questions', wbScopeOne: ' (this lesson)', wbScopeAll: ' (all lessons)',
adminEntry: 'Teacher Admin →', teacherExit: '✓ Exit Teacher View', tchExpired: 'Session expired, please log in again', tchPwPrompt: 'Enter admin password for teacher view:',
tchPwWrong: 'Wrong password', tchAnsFail: 'Failed to load answers', tchAnsT: '📖 Teacher answer: ', tchOpenAns: 'Open-ended',
wbEmptyAlert: 'The mistake book is empty', popupBlocked: 'Popup blocked. Please allow popups and retry.'
},
ja: {
/* P0/P1/P2 学习路径+证书 */
path_title: '学習パス', path_myCerts: '私の修了証', path_continue: '学習を続ける', path_start: '学習を始める', path_doneOf: '{a}/{b} 修了', path_completed: '修了済み ✓', path_empty: '学習パスはまだありません', path_back: '← パス一覧に戻る', social_back: '← 戻る', path_loginFirst: '学習者名を先に設定してください', path_loadFail: '読み込みに失敗しました。もう一度お試しください', path_viewCert: '修了証を見る', path_courseMissing: '削除された課程', cert_title: '修了証', cert_awarded: 'ここに証明します', cert_completedPath: '学習パスを修了しました', cert_no: '証書番号', cert_date: '発行日', cert_print: '🖨 修了証を印刷', cert_empty: 'まだ修了証がありません。パスを修了すると自動発行されます。', cert_congrats: '🎉 パス修了おめでとうございます！修了証を発行しました', allCourses: '📚 すべての課程', backToPaths: '← 学習パス',
appName: 'フェローシップ学習',
wrongBook: '📝 間違いノート',
setName: '名前を設定',
langT: '言語を選択',
cancel: 'キャンセル',
searchPh: 'コースを検索…',
statAll: '全コース',
statDone: '完了',
statDoing: '学習中',
statAvg: '平均点',
startLearning: '学習開始', loading: '読み込み中...',
videoBadge: '🎬 動画',
copyLinkT: '共有リンクをコピー',
nLessons: '{n}課',
emptyResult: '一致するコースがありません',
stDone: '完了',
stDoing: '進行中',
stNot: '未開始',
backList: '← コース一覧に戻る',
backHome: '← 学習システムに戻る',
studentIs: '学習者：',
changeBtn: '変更',
loginReg: 'ログイン / 登録',
tabGuide: '📚 コースガイド',
tabReport: '📊 成績レポート',
tyVerse: '聖句朗読',
tyFill: '空欄補充',
tySingle: '単一選択',
tyMulti: '複数選択',
tyJudge: '正誤判定',
tyEssay: '記述・思考',
nQuestions: '{n}問',
teacherBtn: '🔑 教師用解答表示',
allAnswers: '📖 全解答を見る',
watchVideo: 'コース動画を見る',
videoMulti: '{n}件の動画ソース、タップして選択',
modeChapters: '章別インタラクティブ版',
modeQuiz: 'インタラクティブクイズ・即時採点版',
checkBtn: '答え合わせ',
checking: '採点中…',
fillActive: '全{n}個の空欄を埋めると答え合わせできます',
needName: '先にページ上部で学習者名を設定してください。成績はその名前で記録されます。',
notComplete: '未入力の項目があります。すべて入力してから答え合わせしてください。',
checkFail: '採点に失敗しました。ネットワークを確認して再試行してください。',
fillDoneToast: '🎉 入力完了！答え合わせができます。',
progFill: '進捗：{a} / {b} 入力済み',
vOk: '✓ 正解',
vNg: '✗ 不正解',
vOpen: '○ 記述式 — 参考解答と照合してください',
yourAns: 'あなたの答え：',
rightAns: '正解：',
multiTag: '（複数選択）',
coreVerse: '中心聖句',
essayPh: '答えを入力…',
repWait: '未採点',
repHint: 'すべて入力後、「答え合わせ」をタップすると得点と習熟度がここに表示されます。',
rateTop: '完全習得',
rateGood: '良好',
rateRetry: '復習が必要',
rateGo: '頑張ろう',
repDone: '採点完了、成績をアップロード済み。間違いは間違いノートに追加されました。やり直す場合は「入力に戻る」または「再挑戦」をタップしてください。',
backEdit: '入力に戻る',
scoreDone: '採点完了：{s}（成績アップロード済み）',
scoreUnit: ' · 得点',
loginT: '👤 学習者ログイン',
regT: '👤 学習者登録',
loginD: '名前とパスワードを入力してください。成績と間違いノートはこの名前で記録されます。', loginNeedQuiz: '解答するにはログインが必要です。成績と間違いノートはこの名前で記録されます。',
regD: '初回利用時はログインパスワードを設定し、忘れないようにしてください。',
namePh: '学習者名',
pwPh: 'パスワード（4文字以上）',
pw2Ph: 'パスワード確認',
doLogin: 'ログイン',
doReg: '登録',
goReg: '初めての方？こちらで登録',
goLogin: 'アカウントをお持ちの方？こちらでログイン',
forgotPw: 'パスワードを忘れた方？先生にリセットを依頼してください。',
errName: '名前を入力してください',
errPw: 'パスワードは4文字以上',
errPw2: 'パスワードが一致しません',
doing: '処理中…',
opFail: '操作に失敗しました。再試行してください。',
netErr: 'ネットワークエラー。再試行してください。',
logoutAsk: '学習者（{name}）からログアウトしますか？\\nこの名前の間違いノートと学習記録は保持されます。',
welcome: 'ようこそ、{name}さん！学びの旅を始めましょう！',
wbT: '📝 間違いノート',
wbMyT: '📝 マイ間違いノート',
wbEmptyC: 'このコースの間違いはまだありません。間違えた問題は自動でここに収録されます。',
wbEmpty: '間違いノートは空です。間違えた問題は自動でここに収録されます。',
wbU: 'あなたの答え：',
wbE: '正解：',
wbNA: '（未入力）',
wbClearC: 'このコースの間違い記録をクリアしますか？',
wbClearA: '間違いノートをすべてクリアしますか？',
wbAnon: '匿名',
vidEntry: '動画ソース：',
vidSimple: 'シンプル表示',
vidAll: '全表示',
vidToggle: '（タップで切替）',
vidWx: 'WeChatで開いて視聴',
vidWxT: 'WeChatで開いてください',
vidWxD1: 'この動画はWeChat内での視聴が必要です。<br>下のボタンでリンクをコピーしてください。',
vidCopy: '動画リンクをコピー',
vidWxD2: 'コピー後、WeChatの任意のチャットに送信し<br>リンクを開いて視聴してください。',
vidChoose: '動画ソースを選択',
vidChooseD: '視聴する動画リンクを選んでください',
fontT: '文字サイズ',
fontS: '小',
fontM: '標準',
fontL: '大',
fontXL: '特大',
fontXXL: '最大',
toDesk: 'デスクトップ表示に切替',
toMob: 'モバイル表示に切替',
linkCopied: 'リンクをコピーしました！',
resetBtn: 'リセット',
vidEntryT: '動画ソース設定',
vidSetD: '動画の表示方法を選択してください。選択は記憶されます。',
vidSimpleD: '一部の動画を非表示にしてすっきり表示',
vidAllD: 'すべての動画を表示',
vidLater: '後で',
fontZoomIn: '文字を大きく',
fontZoomOut: '文字を小さく',
fontResetT: '標準サイズに戻す',
courseWord: 'コース',
onlineLesson: 'インタラクティブ授業',
secDefault: '本課の内容',
quizGuideT: '解答の説明：',
defaultGuide: 'この課は{summary}です。上のタブを順に解答し、すべて入力したら下部の「答え合わせ」で採点と解説を確認してください。間違いは復習用に間違いノートに保存されます。',
multiTypes: '様々な問題形式',
startQuiz: '解答開始 →',
reportT: '解答成績と復習レポート',
reportSub: '· 総合評価',
repAnswered: '客観式解答済',
repObjScore: '客観式得点',
repRating: '理解度評価',
redoBtn: '↺ やり直す',
srcFrom: '出典：',
prevType: '← 前の形式：',
nextType: '次の形式：',
viewReport: '成績レポートを見る →',
qrefToggle: '📖 参考表示 / 非表示',
myCourses: 'マイコース', heroSub: '体系的に学び、着実に成長', myScores: '📊 マイ成績', exportBtn: '📥 エクスポート', clearBtn: 'クリア',
scoreSummary: '{n}件の記録', scoreAvg: '、平均 {a} 点',
expWrongT: '📥 間違いノートをエクスポート', wbExpSub: '{name} · {n}問', wbScopeOne: '（このレッスン）', wbScopeAll: '（全レッスン）',
adminEntry: '教師管理入口 →', teacherExit: '✓ 教師モード終了', tchExpired: 'ログインの有効期限が切れました。再ログインしてください。', tchPwPrompt: '教師表示には管理パスワードを入力してください：',
tchPwWrong: 'パスワードが正しくありません', tchAnsFail: '解答の取得に失敗しました', tchAnsT: '📖 教師用解答：', tchOpenAns: '記述式',
wbEmptyAlert: '間違いノートは空です', popupBlocked: 'ポップアップがブロックされました。許可して再試行してください。'
},
ko: {
/* P0/P1/P2 学习路径+证书 */
path_title: '학습 경로', path_myCerts: '내 수료증', path_continue: '계속 학습', path_start: '학습 시작', path_doneOf: '{a}/{b} 완료', path_completed: '수료 완료 ✓', path_empty: '학습 경로가 아직 없습니다', path_back: '← 경로 목록으로 돌아가기', social_back: '← 돌아가기', path_loginFirst: '학습자 이름을 먼저 설정해 주세요', path_loadFail: '불러오지 못했습니다. 다시 시도해 주세요', path_viewCert: '수료증 보기', path_courseMissing: '삭제된 강의', cert_title: '수료증', cert_awarded: '이에 증명합니다', cert_completedPath: '학습 경로를 성공적으로 수료했습니다', cert_no: '증서 번호', cert_date: '발급일', cert_print: '🖨 수료증 인쇄', cert_empty: '아직 수료증이 없습니다. 경로를 수료하면 자동으로 발급됩니다.', cert_congrats: '🎉 경로 수료를 축하합니다! 수료증이 발급되었습니다.', allCourses: '📚 모든 강의', backToPaths: '← 학습 경로',
appName: '펠로우십 학습',
wrongBook: '📝 오답 노트',
setName: '이름 설정',
langT: '언어 선택',
cancel: '취소',
searchPh: '강의 검색…',
statAll: '전체 강의',
statDone: '완료',
statDoing: '학습 중',
statAvg: '평균 점수',
startLearning: '학습 시작', loading: '로딩 중...',
videoBadge: '🎬 영상',
copyLinkT: '공유 링크 복사',
nLessons: '{n}강',
emptyResult: '일치하는 강의가 없습니다',
stDone: '완료',
stDoing: '진행 중',
stNot: '시작 전',
backList: '← 강의 목록으로 돌아가기',
backHome: '← 학습 시스템으로 돌아가기',
studentIs: '학습자: ',
changeBtn: '변경',
loginReg: '로그인 / 회원가입',
tabGuide: '📚 강의 안내',
tabReport: '📊 성적 리포트',
tyVerse: '성경 읽기',
tyFill: '빈칸 채우기',
tySingle: '단일 선택',
tyMulti: '다중 선택',
tyJudge: '참 / 거짓',
tyEssay: '서술형',
nQuestions: '{n}문제',
teacherBtn: '🔑 교사용 정답 보기',
allAnswers: '📖 전체 정답 보기',
watchVideo: '강의 영상 보기',
videoMulti: '{n}개의 영상 소스, 탭하여 선택',
modeChapters: '챕터별 인터랙티브 버전',
modeQuiz: '인터랙티브 퀴즈 · 즉시 채점 버전',
checkBtn: '정답 확인',
checking: '채점 중…',
fillActive: '모든 {n}개의 빈칸을 채우면 정답 확인이 활성화됩니다',
needName: '먼저 페이지 상단에서 학습자 이름을 설정해 주세요. 성적은 해당 이름으로 기록됩니다.',
notComplete: '입력하지 않은 항목이 있습니다. 모두 입력한 후 정답을 확인해 주세요.',
checkFail: '채점에 실패했습니다. 네트워크를 확인하고 다시 시도해 주세요.',
fillDoneToast: '🎉 입력 완료! 이제 정답을 확인할 수 있습니다.',
progFill: '진행: {a} / {b} 입력됨',
vOk: '✓ 정답',
vNg: '✗ 오답',
vOpen: '○ 서술형 — 참고 정답과 대조해 주세요',
yourAns: '내 답: ',
rightAns: '정답: ',
multiTag: '(다중 선택)',
coreVerse: '핵심 성경구절',
essayPh: '답을 입력…',
repWait: '채점 대기',
repHint: '모두 입력한 후 ‘정답 확인’을 탭하면 점수와 숙련도가 여기에 표시됩니다.',
rateTop: '완벽 습득',
rateGood: '양호',
rateRetry: '복습 필요',
rateGo: '계속 노력하세요',
repDone: '채점 완료, 성적이 업로드되었습니다. 오답은 오답 노트에 추가되었습니다. 다시 하려면 ‘입력으로 돌아가기’ 또는 ‘다시 풀기’를 탭하세요.',
backEdit: '입력으로 돌아가기',
scoreDone: '채점 완료: {s} (성적 업로드됨)',
scoreUnit: ' · 점수',
loginT: '👤 학습자 로그인',
regT: '👤 학습자 회원가입',
loginD: '이름과 비밀번호를 입력해 주세요. 성적과 오답 노트는 이 이름으로 기록됩니다.', loginNeedQuiz: '답안을 제출하려면 로그인이 필요합니다. 성적과 오답 노트는 이 이름으로 기록됩니다.',
regD: '처음 이용 시 로그인 비밀번호를 설정하고 잊지 마세요.',
namePh: '학습자 이름',
pwPh: '비밀번호(4자 이상)',
pw2Ph: '비밀번호 확인',
doLogin: '로그인',
doReg: '회원가입',
goReg: '처음이신가요? 여기서 가입하세요',
goLogin: '계정이 있으신가요? 여기서 로그인하세요',
forgotPw: '비밀번호를 잊으셨나요? 선생님께 초기화를 요청하세요.',
errName: '이름을 입력해 주세요',
errPw: '비밀번호는 4자 이상이어야 합니다',
errPw2: '비밀번호가 일치하지 않습니다',
doing: '처리 중…',
opFail: '작업에 실패했습니다. 다시 시도해 주세요.',
netErr: '네트워크 오류. 다시 시도해 주세요.',
logoutAsk: '학습자({name})에서 로그아웃하시겠습니까?\\n이 이름의 오답 노트와 학습 기록은 유지됩니다.',
welcome: '환영합니다, {name}님! 학습 여정을 시작하세요!',
wbT: '📝 오답 노트',
wbMyT: '📝 나의 오답 노트',
wbEmptyC: '이 강의의 오답이 아직 없습니다. 틀린 문제는 자동으로 여기에 수집됩니다.',
wbEmpty: '오답 노트가 비어 있습니다. 틀린 문제는 자동으로 여기에 수집됩니다.',
wbU: '내 답: ',
wbE: '정답: ',
wbNA: '(미입력)',
wbClearC: '이 강의의 오답 기록을 지우시겠습니까?',
wbClearA: '오답 노트를 모두 지우시겠습니까?',
wbAnon: '익명',
vidEntry: '영상 소스: ',
vidSimple: '간단히 표시',
vidAll: '모두 표시',
vidToggle: '(탭하여 전환)',
vidWx: '위챗에서 열어 시청',
vidWxT: '위챗에서 열어 주세요',
vidWxD1: '이 영상은 위챗 내에서 시청해야 합니다.<br>아래 버튼을 눌러 링크를 복사하세요.',
vidCopy: '영상 링크 복사',
vidWxD2: '복사 후 위챗 채팅에 붙여넣고<br>링크를 열어 시청하세요.',
vidChoose: '영상 소스 선택',
vidChooseD: '시청할 영상 링크를 선택하세요',
fontT: '글꼴',
fontS: '작게',
fontM: '보통',
fontL: '크게',
fontXL: '아주 크게',
fontXXL: '최대',
toDesk: '데스크톱 보기로 전환',
toMob: '모바일 보기로 전환',
linkCopied: '링크가 복사되었습니다!',
resetBtn: '초기화',
vidEntryT: '영상 소스 설정',
vidSetD: '영상 표시 방식을 선택하세요. 선택이 기억됩니다.',
vidSimpleD: '일부 영상을 숨기고 간결하게 표시',
vidAllD: '모든 영상 표시',
vidLater: '나중에',
fontZoomIn: '글자 키우기',
fontZoomOut: '글자 줄이기',
fontResetT: '기본 크기로 복원',
courseWord: '강의',
onlineLesson: '인터랙티브 강의',
secDefault: '본 강의 내용',
quizGuideT: '답안 안내: ',
defaultGuide: '이 강의는 {summary}를 다룹니다. 위 탭을 순서대로 푸시고, 모두 입력한 후 하단의 ‘정답 확인’을 눌러 점수와 해설을 확인하세요. 오답은 복습을 위해 오답 노트에 저장됩니다.',
multiTypes: '다양한 문제 유형',
startQuiz: '문제 풀기 →',
reportT: '문제 성적 및 복습 리포트',
reportSub: '· 종합 평가',
repAnswered: '객관식 응답',
repObjScore: '객관식 점수',
repRating: '이해도 평가',
redoBtn: '↺ 다시 풀기',
srcFrom: '출처: ',
prevType: '← 이전 유형: ',
nextType: '다음 유형: ',
viewReport: '성적 리포트 보기 →',
qrefToggle: '📖 참고 표시 / 숨기기',
myCourses: '내 강의', heroSub: '체계적으로 학습하고 꾸준히 성장', myScores: '📊 내 성적', exportBtn: '📥 내보내기', clearBtn: '지우기',
scoreSummary: '{n}개의 기록', scoreAvg: ', 평균 {a}점',
expWrongT: '📥 오답노트 내보내기', wbExpSub: '{name} · {n}문제', wbScopeOne: ' (이 레슨)', wbScopeAll: ' (전체 레슨)',
adminEntry: '교사 관리 →', teacherExit: '✓ 교사 모드 종료', tchExpired: '로그인이 만료되었습니다. 다시 로그인해 주세요.', tchPwPrompt: '교사 보기를 위해 관리 비밀번호를 입력하세요:',
tchPwWrong: '비밀번호가 틀렸습니다', tchAnsFail: '정답을 불러오지 못했습니다', tchAnsT: '📖 교사용 정답: ', tchOpenAns: '서술형',
wbEmptyAlert: '오답노트가 비어 있습니다', popupBlocked: '팝업이 차단되었습니다. 팝업을 허용하고 다시 시도해 주세요.'
}
};
function tr(k) {
    var L = curLang();
    var d = I18N[L] || I18N.zh;
    var s = (d[k] !== undefined) ? d[k] : ((I18N.zh[k] !== undefined) ? I18N.zh[k] : k);
    return (L === 'tw') ? toTW(s) : s;
}
function tf(k, obj) {
    var s = tr(k);
    for (var p in obj) { if (Object.prototype.hasOwnProperty.call(obj, p)) s = s.split('{' + p + '}').join(obj[p]); }
    return s;
}
/* 静态 data-i18n 元素应用当前语言 */
function applyI18n() {
    try {
        document.querySelectorAll('[data-i18n]').forEach(function(el) { el.textContent = tr(el.getAttribute('data-i18n')); });
        document.querySelectorAll('[data-i18n-html]').forEach(function(el) { el.innerHTML = tr(el.getAttribute('data-i18n-html')); });
        document.querySelectorAll('[data-i18n-ph]').forEach(function(el) { el.setAttribute('placeholder', tr(el.getAttribute('data-i18n-ph'))); });
        document.querySelectorAll('[data-i18n-title]').forEach(function(el) { el.setAttribute('title', tr(el.getAttribute('data-i18n-title'))); });
        document.title = tr('appName');
        var nb = document.getElementById('noticeBarText');
        if (nb) {
            if (nb.dataset.orig === undefined) nb.dataset.orig = nb.textContent;
            var L = curLang(), ntx = nb.dataset.orig;
            if (L === 'tw') ntx = toTW(nb.dataset.orig);
            else if (L === 'en' && nb.dataset.noticeEn) ntx = nb.dataset.noticeEn;
            else if (L === 'ja' && nb.dataset.noticeJa) ntx = nb.dataset.noticeJa;
            else if (L === 'ko' && nb.dataset.noticeKo) ntx = nb.dataset.noticeKo;
            nb.innerHTML = hlVerse(esc(ntx));
        }
        var lb = document.getElementById('langBtn');
        if (lb) lb.innerHTML = '🌐 ' + langShort(curLang());
    } catch (e) {}
}
/* 英文圣经版本设置：NIV / KJV（localStorage 记住，默认 NIV） */
var BIBLE_VER_KEY = "TQ_BIBLE_VER";
function getBibleVer() { try { return localStorage.getItem(BIBLE_VER_KEY) || "NIV"; } catch(e) { return "NIV"; } }
function setBibleVer(v) {
    try { localStorage.setItem(BIBLE_VER_KEY, v); } catch(e) {}
    // 刷新当前已显示的经文参考卡
    try { document.querySelectorAll('[data-bible-ref]').forEach(function(el) { loadBibleRef(el); }); } catch(e) {}
    // 刷新语言面板中的版本按钮状态
    try { renderBibleVerBtns(); } catch(e) {}
}
/* 经文参考卡：按当前版本从 /api/bible 拉取 NIV/KJV 全文 */
var _bibleCache = {};
function loadBibleRef(el) {
    var ref = el.getAttribute('data-bible-ref');
    if (!ref) return;
    var ver = getBibleVer();
    var key = ver + '::' + ref;
    var show = function(text) {
        el.innerHTML = '<div class="text-xs font-bold text-emerald-700 mb-1">📖 ' + ver + ' ' + esc(ref) + '</div>'
            + '<div class="text-sm text-slate-700 leading-relaxed">' + esc(text) + '</div>'
            + '<div class="text-[10px] text-slate-400 mt-1">' + (ver === 'NIV' ? 'New International Version © Biblica' : 'King James Version (Public Domain)') + '</div>';
    };
    if (_bibleCache[key]) { show(_bibleCache[key]); return; }
    el.innerHTML = '<div class="text-xs text-slate-400">加载经文中…</div>';
    fetch('/api/bible?ref=' + encodeURIComponent(ref)).then(function(r) { return r.json(); }).then(function(d) {
        var t = ver === 'NIV' ? d.niv : d.kjv;
        if (t) { _bibleCache[key] = t; show(t); }
        else el.innerHTML = '<div class="text-xs text-slate-400">暂无该经文英文版</div>';
    }).catch(function() { el.innerHTML = '<div class="text-xs text-slate-400">经文加载失败</div>'; });
}
function renderBibleVerBtns() {
    var wrap = document.getElementById('bibleVerBtns');
    if (!wrap) return;
    var cur = getBibleVer();
    wrap.innerHTML = ['NIV', 'KJV'].map(function(v) {
        var sel = cur === v;
        return '<button data-bv="' + v + '" style="flex:1;padding:10px;border-radius:14px;font-size:13px;font-weight:700;'
            + (sel ? 'background:#ecfdf5;border:2px solid #10b981;color:#047857;' : 'background:#f8fafc;border:2px solid transparent;color:#64748b;') + '">'
            + (sel ? '✓ ' : '') + v + '</button>';
    }).join('');
    wrap.querySelectorAll('[data-bv]').forEach(function(b) { b.onclick = function() { setBibleVer(b.getAttribute('data-bv')); }; });
}
function openLangPanel() {
    var m = document.getElementById('langModal');
    if (!m) {
        m = document.createElement('div');
        m.id = 'langModal';
        m.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:16px;';
        m.innerHTML = '<div style="position:absolute;inset:0;background:rgba(15,23,42,.5)" data-close="1"></div>'
            + '<div style="position:relative;background:#fff;border-radius:24px;padding:24px;width:100%;max-width:320px;box-shadow:0 25px 50px rgba(0,0,0,.25)">'
            + '<button data-close="1" style="position:absolute;top:12px;right:14px;background:none;border:none;font-size:20px;color:#94a3b8;cursor:pointer;line-height:1">×</button>'
            + '<h3 style="font-weight:800;color:#1e293b;margin:0 0 16px">' + tr('langT') + '</h3>'
            + '<div id="langList"></div>'
            + '<div id="bibleVerSection" style="margin-top:4px;padding-top:12px;border-top:1px solid #f1f5f9">'
            + '<div style="font-size:12px;font-weight:700;color:#64748b;margin-bottom:8px">📖 English Bible Version</div>'
            + '<div id="bibleVerBtns" style="display:flex;gap:8px"></div></div>'
            + '<button data-close="1" style="margin-top:4px;width:100%;font-size:12px;color:#94a3b8;padding:8px;background:none;border:none">' + tr('cancel') + '</button></div>';
        m.querySelectorAll('[data-close]').forEach(function(x) { x.onclick = function() { m.style.display = 'none'; }; });
        document.body.appendChild(m);
    }
    document.getElementById('langList').innerHTML = LANGS.map(function(L) {
        var sel = curLang() === L[0];
        return '<button data-lang="' + L[0] + '" style="width:100%;text-align:left;padding:12px 14px;border-radius:16px;margin-bottom:8px;font-size:14px;color:#334155;'
            + (sel ? 'background:#ede9fe;border:2px solid #7c3aed;font-weight:800;' : 'background:#f8fafc;border:2px solid transparent;') + '">'
            + (sel ? '✓ ' : '<span style="display:inline-block;width:18px"></span>') + L[1] + '</button>';
    }).join('');
    m.querySelectorAll('[data-lang]').forEach(function(b) { b.onclick = function() { setLang(b.getAttribute('data-lang')); }; });
    renderBibleVerBtns();
    m.style.display = 'flex';
}
/* 繁简转换（字表来源 OpenCC STCharacters，Apache-2.0） */
var TWP = "㐷傌㐹㑶㐽偑㑇㑳㑈倲㑔㑯㑩儸㓥劏㓰劃㔉劚㖊噚㖞喎㘎㘚㚯㜄㛀媰㛣㜏㛤孋㟆㠏㟥嵾㡎幓㤘㥮㤽懤㥪慺㧏掆㧐㩳㧑撝㧟擓㧰擽㨫㩜㭎棡㭏椲㭤樢㭴樫㱩殰㱮殨㲿瀇㳔濧㳕灡㳠澾㳡濄㳽瀰㴋潚㶉鸂㶶燶㶽煱㺍獱㻅璯䀥䁻䁖瞜䂵碽䃅磾䅉稏䅟穇䇲筴䉤籔䌶䊷䌷紬䌸縳䌹絅䌺䋙䌻䋚䌼綐䌽綵䌾䋻䌿䋹䍀繿䍁繸䍠䍦䎬䎱䏝膞䓓薵䓕薳䓖藭䓨罃䗖螮䙌䙡䙓襬䜣訢䜤鿁䜧䜀䜩讌䝙貙䞍䝼䞐賰䟢躎䥺釾䥽鏺䥾䥱䦂䥇䦃鐯䦅鐥䦆钁䦶䦛䦷䦟䩄靦䯄騧䯅䯀䲝䱽䲟鮣䲠鰆䲡鰌䲢鰧䲣䱷䴓鳾䴔鵁䴕鴷䴖鶄䴗鶪䴘鷉䴙鸊䶮龑万萬与與丑醜专專业業丛叢东東丝絲丢丟两兩严嚴丧喪个個丰豐临臨为爲丽麗举舉么麼义義乌烏乐樂乔喬习習乡鄉书書买買乱亂争爭于於亏虧云雲亘亙亚亞产產亩畝亲親亵褻亸嚲亿億仅僅仆僕从從仑侖仓倉仪儀们們价價众衆优優伙夥会會伛傴伞傘伟偉传傳伡俥伣俔伤傷伥倀伦倫伧傖伪僞伫佇体體余餘佣傭佥僉侠俠侣侶侥僥侦偵侧側侨僑侩儈侪儕侬儂侭儘俣俁俦儔俨儼俩倆俪儷俫倈俭儉债債倾傾偬傯偻僂偾僨偿償傤儎傥儻傧儐储儲傩儺儿兒兑兌兖兗党黨兰蘭关關兴興兹茲养養兽獸冁囅内內冈岡册冊写寫军軍农農冯馮冲衝决決况況冻凍净淨凄悽准準凉涼减減凑湊凛凜几幾凤鳳凫鳧凭憑凯凱凶兇击擊凿鑿刍芻划劃刘劉则則刚剛创創删刪别別刬剗刭剄刹剎刽劊刾㓨刿劌剀剴剂劑剐剮剑劍剥剝剧劇劝勸办辦务務劢勱动動励勵劲勁劳勞势勢勋勳勚勩匀勻匦匭匮匱区區医醫华華协協单單卖賣占佔卢盧卤滷卧臥卫衛却卻卺巹厂廠厅廳历歷厉厲压壓厌厭厍厙厐龎厕廁厘釐厢廂厣厴厦廈厨廚厩廄厮廝县縣叁叄参參叆靉叇靆双雙发發变變叙敘叠疊台臺叶葉号號叹嘆叽嘰吁籲吃喫后後吓嚇吕呂吗嗎吨噸听聽启啓吴吳呐吶呒嘸呓囈呕嘔呖嚦呗唄员員呙咼呛嗆呜嗚咏詠咙嚨咛嚀咝噝咤吒咨諮咸鹹响響哑啞哒噠哓嘵哔嗶哕噦哗譁哙噲哜嚌哝噥哟喲唇脣唛嘜唝嗊唠嘮唡啢唢嗩唤喚啧嘖啬嗇啭囀啮齧啯嘓啰囉啴嘽啸嘯喷噴喽嘍喾嚳嗫囁嗳噯嘘噓嘤嚶嘱囑噜嚕嚣囂团團园園囱囪围圍囵圇国國图圖圆圓圣聖圹壙场場坏壞块塊坚堅坛壇坜壢坝壩坞塢坟墳坠墜垄壟垅壠垆壚垒壘垦墾垩堊垫墊垭埡垯墶垱壋垲塏垴堖埘塒埙壎埚堝堑塹堕墮塆壪墙牆壮壯声聲壳殼壶壺壸壼处處备備复復够夠头頭夸誇夹夾夺奪奁奩奂奐奋奮奖獎奥奧妆妝妇婦妈媽妩嫵妪嫗妫嬀姗姍姹奼娄婁娅婭娆嬈娇嬌娈孌娱娛娲媧娴嫺婳嫿婴嬰婵嬋婶嬸媪媼媭嬃嫒嬡嫔嬪嫱嬙嬷嬤孙孫学學孪孿宁寧宝寶实實宠寵审審宪憲宫宮宽寬宾賓寝寢对對寻尋导導寿壽将將尔爾尘塵尝嘗尧堯尴尷尸屍尽盡层層屃屓屉屜届屆属屬屡屢屦屨屿嶼岁歲岂豈岖嶇岗崗岘峴岚嵐岛島岩巖岭嶺岳嶽岽崬岿巋峃嶨峄嶧峡峽峣嶢峤嶠峥崢峦巒峰峯崂嶗崃崍崄嶮崭嶄嵘嶸嵚嶔嵝嶁巅巔巩鞏巯巰币幣帅帥师師帏幃帐帳帘簾帜幟带帶帧幀帮幫帱幬帻幘帼幗幂冪干幹并並广廣庄莊庆慶床牀庐廬庑廡库庫应應庙廟庞龐废廢庼廎廪廩开開异異弃棄弑弒张張弥彌弪弳弯彎弹彈强強归歸当當录錄彟彠彦彥彨彲彻徹征徵径徑徕徠忆憶忏懺忧憂忾愾怀懷态態怂慫怃憮怄慪怅悵怆愴怜憐总總怼懟怿懌恋戀恒恆恳懇恶惡恸慟恹懨恺愷恻惻恼惱恽惲悦悅悫愨悬懸悭慳悮悞悯憫惊驚惧懼惨慘惩懲惫憊惬愜惭慚惮憚惯慣愠慍愤憤愦憒愿願慑懾慭憖懑懣懒懶懔懍戆戇戋戔戏戲戗戧战戰戬戩戯戱户戶扑撲执執扩擴扪捫扫掃扬揚扰擾抚撫抛拋抟摶抠摳抡掄抢搶护護报報担擔拟擬拢攏拣揀拥擁拦攔拧擰拨撥择擇挂掛挚摯挛攣挜掗挝撾挞撻挟挾挠撓挡擋挢撟挣掙挤擠挥揮挦撏捝挩捞撈损損捡撿换換捣搗据據掳擄掴摑掷擲掸撣掺摻掼摜揽攬揾搵揿撳搀攙搁擱搂摟搄揯搅攪携攜摄攝摅攄摆擺摇搖摈擯摊攤撄攖撑撐撵攆撷擷撸擼撺攛擜㩵擞擻攒攢敌敵敚敓敛斂敩斆数數斋齋斓斕斗鬥斩斬断斷无無旧舊时時旷曠旸暘昙曇昵暱昼晝昽曨显顯晋晉晒曬晓曉晔曄晕暈晖暉暂暫暧曖术術朴樸机機杀殺杂雜权權杠槓条條来來杨楊杩榪杰傑极極构構枞樅枢樞枣棗枥櫪枧梘枨棖枪槍枫楓枭梟柜櫃柠檸柽檉栀梔栅柵标標栈棧栉櫛栊櫳栋棟栌櫨栎櫟栏欄树樹栖棲样樣栾欒桠椏桡橈桢楨档檔桤榿桥橋桦樺桧檜桨槳桩樁桪樳梦夢梼檮梾棶梿槤检檢棁梲棂欞椁槨椝槼椟櫝椠槧椢槶椤欏椫樿椭橢椮槮楼樓榄欖榅榲榇櫬榈櫚榉櫸榝樧槚檟槛檻槟檳槠櫧横橫樯檣樱櫻橥櫫橱櫥橹櫓橼櫞檩檁欢歡欤歟欧歐歼殲殁歿殇殤残殘殒殞殓殮殚殫殡殯殴毆毁毀毂轂毕畢毙斃毡氈毵毿氇氌气氣氢氫氩氬氲氳汇匯汉漢汤湯汹洶沄澐沟溝没沒沣灃沤漚沥瀝沦淪沧滄沨渢沩潙沪滬泞濘泪淚泶澩泷瀧泸瀘泺濼泻瀉泼潑泽澤泾涇洁潔洒灑洼窪浃浹浅淺浆漿浇澆浈湞浉溮浊濁测測浍澮济濟浏瀏浐滻浑渾浒滸浓濃浔潯浕濜涂塗涌湧涚涗涛濤涝澇涞淶涟漣涠潿涡渦涢溳涣渙涤滌润潤涧澗涨漲涩澀淀澱渊淵渌淥渍漬渎瀆渐漸渑澠渔漁渖瀋渗滲温溫游遊湾灣湿溼溁濚溃潰溅濺溆漵溇漊滗潷滚滾滞滯滟灩滠灄满滿滢瀅滤濾滥濫滦灤滨濱滩灘滪澦潆瀠潇瀟潋瀲潍濰潜潛潴瀦澛瀂澜瀾濑瀨濒瀕灏灝灭滅灯燈灵靈灶竈灾災灿燦炀煬炉爐炖燉炜煒炝熗点點炼煉炽熾烁爍烂爛烃烴烛燭烟煙烦煩烧燒烨燁烩燴烫燙烬燼热熱焕煥焖燜焘燾煴熅熏燻爱愛爷爺牍牘牦犛牵牽牺犧犊犢状狀犷獷犸獁犹猶狈狽狝獮狞獰独獨狭狹狮獅狯獪狰猙狱獄狲猻猃獫猎獵猕獼猡玀猪豬猫貓猬蝟献獻獭獺玑璣玙璵玚瑒玛瑪玮瑋环環现現玱瑲玺璽珐琺珑瓏珰璫珲琿琎璡琏璉琐瑣琼瓊瑶瑤瑷璦瑸璸璎瓔瓒瓚瓮甕瓯甌电電画畫畅暢畴疇疖癤疗療疟瘧疠癘疡瘍疬癧疭瘲疮瘡疯瘋疱皰疴痾痈癰痉痙痒癢痖瘂痨癆痪瘓痫癇痴癡瘅癉瘆瘮瘗瘞瘘瘻瘪癟瘫癱瘾癮瘿癭癞癩癣癬癫癲皂皁皑皚皱皺皲皸盏盞盐鹽监監盖蓋盗盜盘盤眍瞘眦眥眬矓睁睜睐睞睑瞼瞆瞶瞒瞞瞩矚矫矯矶磯矾礬矿礦砀碭码碼砖磚砗硨砚硯砜碸砺礪砻礱砾礫础礎硁硜硕碩硖硤硗磽硙磑硚礄确確硵磠碍礙碛磧碜磣碱鹼礼禮祃禡祎禕祢禰祯禎祷禱祸禍禀稟禄祿禅禪离離秃禿秆稈种種秘祕积積称稱秽穢秾穠稆穭税稅稣穌稳穩穑穡穞穭穷窮窃竊窍竅窎窵窑窯窜竄窝窩窥窺窦竇窭窶竖豎竞競笃篤笋筍笔筆笕筧笺箋笼籠笾籩筑築筚篳筛篩筜簹筝箏筹籌筼篔签籤筿篠简簡箓籙箦簀箧篋箨籜箩籮箪簞箫簫篑簣篓簍篮籃篯籛篱籬簖籪籁籟籴糴类類籼秈粜糶粝糲粤粵粪糞粮糧粽糉糁糝糇餱糍餈紧緊絷縶緼縕縆緪纟糹纠糾纡紆红紅纣紂纤纖纥紇约約级級纨紈纩纊纪紀纫紉纬緯纭紜纮紘纯純纰紕纱紗纲綱纳納纴紝纵縱纶綸纷紛纸紙纹紋纺紡纻紵纼紖纽紐纾紓线線绀紺绁紲绂紱练練组組绅紳细細织織终終绉縐绊絆绋紼绌絀绍紹绎繹经經绐紿绑綁绒絨结結绔絝绕繞绖絰绗絎绘繪给給绚絢绛絳络絡绝絕绞絞统統绠綆绡綃绢絹绣繡绤綌绥綏绦絛继繼绨綈绩績绪緒绫綾绬緓续續绮綺绯緋绰綽绱鞝绲緄绳繩维維绵綿绶綬绷繃绸綢绹綯绺綹绻綣综綜绽綻绾綰绿綠缀綴缁緇缂緙缃緗缄緘缅緬缆纜缇緹缈緲缉緝缊縕缋繢缌緦缍綞缎緞缏緶缐線缑緱缒縋缓緩缔締缕縷编編缗緡缘緣缙縉缚縛缛縟缜縝缝縫缞縗缟縞缠纏缡縭缢縊缣縑缤繽缥縹缦縵缧縲缨纓缩縮缪繆缫繅缬纈缭繚缮繕缯繒缰繮缱繾缲繰缳繯缴繳缵纘罂罌网網罗羅罚罰罢罷罴羆羁羈羟羥羡羨群羣翘翹翙翽翚翬耢耮耧耬耸聳耻恥聂聶聋聾职職聍聹联聯聩聵聪聰肃肅肠腸肤膚肮骯肴餚肾腎肿腫胀脹胁脅胆膽胜勝胧朧胨腖胪臚胫脛胶膠脉脈脍膾脏髒脐臍脑腦脓膿脔臠脚腳脱脫脶腡脸臉腊臘腌醃腘膕腭齶腻膩腼靦腽膃腾騰膑臏膻羶臜臢舆輿舣艤舰艦舱艙舻艫艰艱艳豔艺藝节節芈羋芗薌芜蕪芦蘆苁蓯苇葦苈藶苋莧苌萇苍蒼苎苧苏蘇苧薴苹蘋范範茎莖茏蘢茑蔦茔塋茕煢茧繭荆荊荐薦荙薘荚莢荛蕘荜蓽荝萴荞蕎荟薈荠薺荡蕩荣榮荤葷荥滎荦犖荧熒荨蕁荩藎荪蓀荫蔭荬蕒荭葒荮葤药藥莅蒞莱萊莲蓮莳蒔莴萵莶薟获獲莸蕕莹瑩莺鶯莼蓴萚蘀萝蘿萤螢营營萦縈萧蕭萨薩葱蔥蒀蒕蒇蕆蒉蕢蒋蔣蒌蔞蒏醟蓝藍蓟薊蓠蘺蓣蕷蓥鎣蓦驀蔂虆蔷薔蔹蘞蔺藺蔼藹蕰薀蕲蘄蕴蘊薮藪藓蘚藴蘊蘖櫱虏虜虑慮虚虛虫蟲虬虯虮蟣虱蝨虽雖虾蝦虿蠆蚀蝕蚁蟻蚂螞蚃蠁蚕蠶蚝蠔蚬蜆蛊蠱蛎蠣蛏蟶蛮蠻蛰蟄蛱蛺蛲蟯蛳螄蛴蠐蜕蛻蜗蝸蜡蠟蝇蠅蝈蟈蝉蟬蝎蠍蝼螻蝾蠑螀螿螨蟎蟏蠨衅釁衔銜补補衬襯衮袞袄襖袅嫋袆褘袜襪袭襲袯襏装裝裆襠裈褌裢褳裣襝裤褲裥襉褛褸褴襤襕襴见見观觀觃覎规規觅覓视視觇覘览覽觉覺觊覬觋覡觌覿觍覥觎覦觏覯觐覲觑覷觞觴触觸觯觶訚誾詟讋誉譽誊謄讠訁计計订訂讣訃认認讥譏讦訐讧訌讨討让讓讪訕讫訖讬託训訓议議讯訊记記讱訒讲講讳諱讴謳讵詎讶訝讷訥许許讹訛论論讻訩讼訟讽諷设設访訪诀訣证證诂詁诃訶评評诅詛识識诇詗诈詐诉訴诊診诋詆诌謅词詞诎詘诏詔诐詖译譯诒詒诓誆诔誄试試诖詿诗詩诘詰诙詼诚誠诛誅诜詵话話诞誕诟詬诠詮诡詭询詢诣詣诤諍该該详詳诧詫诨諢诩詡诪譸诫誡诬誣语語诮誚误誤诰誥诱誘诲誨诳誑说說诵誦诶誒请請诸諸诹諏诺諾读讀诼諑诽誹课課诿諉谀諛谁誰谂諗调調谄諂谅諒谆諄谇誶谈談谉讅谊誼谋謀谌諶谍諜谎謊谏諫谐諧谑謔谒謁谓謂谔諤谕諭谖諼谗讒谘諮谙諳谚諺谛諦谜謎谝諞谞諝谟謨谠讜谡謖谢謝谣謠谤謗谥諡谦謙谧謐谨謹谩謾谪謫谫譾谬謬谭譚谮譖谯譙谰讕谱譜谲譎谳讞谴譴谵譫谶讖豮豶贝貝贞貞负負贠貟贡貢财財责責贤賢败敗账賬货貨质質贩販贪貪贫貧贬貶购購贮貯贯貫贰貳贱賤贲賁贳貰贴貼贵貴贶貺贷貸贸貿费費贺賀贻貽贼賊贽贄贾賈贿賄赀貲赁賃赂賂赃贓资資赅賅赆贐赇賕赈賑赉賚赊賒赋賦赌賭赍齎赎贖赏賞赐賜赑贔赒賙赓賡赔賠赕賧赖賴赗賵赘贅赙賻赚賺赛賽赜賾赝贗赞贊赟贇赠贈赡贍赢贏赣贛赪赬赵趙赶趕趋趨趱趲趸躉跃躍跄蹌跖蹠跞躒践踐跶躂跷蹺跸蹕跹躚跻躋踌躊踪蹤踬躓踯躑蹑躡蹒蹣蹰躕蹿躥躏躪躜躦躯軀輼轀车車轧軋轨軌轩軒轪軑轫軔转轉轭軛轮輪软軟轰轟轱軲轲軻轳轤轴軸轵軹轶軼轷軤轸軫轹轢轺軺轻輕轼軾载載轾輊轿轎辀輈辁輇辂輅较較辄輒辅輔辆輛辇輦辈輩辉輝辊輥辋輞辌輬辍輟辎輜辏輳辐輻辑輯辒轀输輸辔轡辕轅辖轄辗輾辘轆辙轍辚轔辞辭辟闢辩辯辫辮边邊辽遼达達迁遷过過迈邁运運还還这這进進远遠违違连連迟遲迩邇迳逕迹跡适適选選逊遜递遞逦邐逻邏遗遺遥遙邓鄧邝鄺邬鄔邮郵邹鄒邺鄴邻鄰郁鬱郏郟郐鄶郑鄭郓鄆郦酈郧鄖郸鄲酂酇酝醞酦醱酱醬酽釅酾釃酿釀醖醞采採释釋里裏鉴鑑銮鑾錾鏨钅釒钆釓钇釔针針钉釘钊釗钋釙钌釕钍釷钎釺钏釧钐釤钑鈒钒釩钓釣钔鍆钕釹钖鍚钗釵钘鈃钙鈣钚鈈钛鈦钜鉅钝鈍钞鈔钟鍾钠鈉钡鋇钢鋼钣鈑钤鈐钥鑰钦欽钧鈞钨鎢钩鉤钪鈧钫鈁钬鈥钭鈄钮鈕钯鈀钰鈺钱錢钲鉦钳鉗钴鈷钵鉢钶鈳钷鉕钸鈽钹鈸钺鉞钻鑽钼鉬钽鉭钾鉀钿鈿铀鈾铁鐵铂鉑铃鈴铄鑠铅鉛铆鉚铇鉋铈鈰铉鉉铊鉈铋鉍铌鈮铍鈹铎鐸铏鉶铐銬铑銠铒鉺铓鋩铔錏铕銪铖鋮铗鋏铘鋣铙鐃铚銍铛鐺铜銅铝鋁铞銱铟銦铠鎧铡鍘铢銖铣銑铤鋌铥銩铦銛铧鏵铨銓铩鎩铪鉿铫銚铬鉻铭銘铮錚铯銫铰鉸铱銥铲鏟铳銃铴鐋铵銨银銀铷銣铸鑄铹鐒铺鋪铻鋙铼錸铽鋱链鏈铿鏗销銷锁鎖锂鋰锃鋥锄鋤锅鍋锆鋯锇鋨锈鏽锉銼锊鋝锋鋒锌鋅锍鋶锎鐦锏鐧锐銳锑銻锒鋃锓鋟锔鋦锕錒锖錆锗鍺锘鍩错錯锚錨锛錛锜錡锝鍀锞錁锟錕锠錩锡錫锢錮锣鑼锤錘锥錐锦錦锧鑕锨鍁锩錈锪鍃锫錇锬錟锭錠键鍵锯鋸锰錳锱錙锲鍥锳鍈锴鍇锵鏘锶鍶锷鍔锸鍤锹鍬锺鍾锻鍛锼鎪锽鍠锾鍰锿鎄镀鍍镁鎂镂鏤镃鎡镄鐨镅鎇镆鏌镇鎮镈鎛镉鎘镊鑷镋钂镌鐫镍鎳镎鎿镏鎦镐鎬镑鎊镒鎰镓鎵镔鑌镕鎔镖鏢镗鏜镘鏝镙鏍镚鏰镛鏞镜鏡镝鏑镞鏃镟鏇镠鏐镡鐔镢钁镣鐐镤鏷镥鑥镦鐓镧鑭镨鐠镩鑹镪鏹镫鐙镬鑊镭鐳镮鐶镯鐲镰鐮镱鐿镲鑔镳鑣镴鑞镵鑱镶鑲长長门門闩閂闪閃闫閆闬閈闭閉问問闯闖闰閏闱闈闲閒闳閎间間闵閔闶閌闷悶闸閘闹鬧闺閨闻聞闼闥闽閩闾閭闿闓阀閥阁閣阂閡阃閫阄鬮阅閱阆閬阇闍阈閾阉閹阊閶阋鬩阌閿阍閽阎閻阏閼阐闡阑闌阒闃阓闠阔闊阕闋阖闔阗闐阘闒阙闕阚闞阛闤队隊阳陽阴陰阵陣阶階际際陆陸陇隴陈陳陉陘陕陝陦隯陧隉陨隕险險随隨隐隱隶隸隽雋难難雇僱雏雛雠讎雳靂雾霧霁霽霉黴霡霢霭靄靓靚靔靝静靜靥靨鞑韃鞒鞽鞯韉鞲韝韦韋韧韌韨韍韩韓韪韙韫韞韬韜韵韻页頁顶頂顷頃顸頇项項顺順须須顼頊顽頑顾顧顿頓颀頎颁頒颂頌颃頏预預颅顱领領颇頗颈頸颉頡颊頰颋頲颌頜颍潁颎熲颏頦颐頤频頻颒頮颓頹颔頷颕頴颖穎颗顆题題颙顒颚顎颛顓颜顏额額颞顳颟顢颠顛颡顙颢顥颣纇颤顫颥顬颦顰颧顴风風飏颺飐颭飑颮飒颯飓颶飔颸飕颼飖颻飗飀飘飄飙飆飚飈飞飛飨饗餍饜饣飠饤飣饥飢饦飥饧餳饨飩饩餼饪飪饫飫饬飭饭飯饮飲饯餞饰飾饱飽饲飼饳飿饴飴饵餌饶饒饷餉饸餄饹餎饺餃饻餏饼餅饽餑饾餖饿餓馀餘馁餒馂餕馃餜馄餛馅餡馆館馇餷馈饋馉餶馊餿馋饞馌饁馍饃馎餺馏餾馐饈馑饉馒饅馓饊馔饌馕饢马馬驭馭驮馱驯馴驰馳驱驅驲馹驳駁驴驢驵駔驶駛驷駟驸駙驹駒驺騶驻駐驼駝驽駑驾駕驿驛骀駘骁驍骂罵骃駰骄驕骅驊骆駱骇駭骈駢骉驫骊驪骋騁验驗骍騂骎駸骏駿骐騏骑騎骒騍骓騅骔騌骕驌骖驂骗騙骘騭骙騤骚騷骛騖骜驁骝騮骞騫骟騸骠驃骡騾骢驄骣驏骤驟骥驥骦驦骧驤髅髏髋髖髌髕鬓鬢鬶鬹魇魘魉魎鱼魚鱽魛鱾魢鱿魷鲀魨鲁魯鲂魴鲃䰾鲄魺鲅鮁鲆鮃鲇鮎鲈鱸鲉鮋鲊鮓鲋鮒鲌鮊鲍鮑鲎鱟鲏鮍鲐鮐鲑鮭鲒鮚鲓鮳鲔鮪鲕鮞鲖鮦鲗鰂鲘鮜鲙鱠鲚鱭鲛鮫鲜鮮鲝鮺鲞鯗鲟鱘鲠鯁鲡鱺鲢鰱鲣鰹鲤鯉鲥鰣鲦鰷鲧鯀鲨鯊鲩鯇鲪鮶鲫鯽鲬鯒鲭鯖鲮鯪鲯鯕鲰鯫鲱鯡鲲鯤鲳鯧鲴鯝鲵鯢鲶鯰鲷鯛鲸鯨鲹鰺鲺鯴鲻鯔鲼鱝鲽鰈鲾鰏鲿鱨鳀鯷鳁鰮鳂鰃鳃鰓鳄鱷鳅鰍鳆鰒鳇鰉鳈鰁鳉鱂鳊鯿鳋鰠鳌鰲鳍鰭鳎鰨鳏鰥鳐鰩鳑鰟鳒鰜鳓鰳鳔鰾鳕鱈鳖鱉鳗鰻鳘鰵鳙鱅鳚䲁鳛鰼鳜鱖鳝鱔鳞鱗鳟鱒鳠鱯鳡鱤鳢鱧鳣鱣鳤䲘鸟鳥鸠鳩鸡雞鸢鳶鸣鳴鸤鳲鸥鷗鸦鴉鸧鶬鸨鴇鸩鴆鸪鴣鸫鶇鸬鸕鸭鴨鸮鴞鸯鴦鸰鴒鸱鴟鸲鴝鸳鴛鸴鷽鸵鴕鸶鷥鸷鷙鸸鴯鸹鴰鸺鵂鸻鴴鸼鵃鸽鴿鸾鸞鸿鴻鹀鵐鹁鵓鹂鸝鹃鵑鹄鵠鹅鵝鹆鵒鹇鷳鹈鵜鹉鵡鹊鵲鹋鶓鹌鵪鹍鵾鹎鵯鹏鵬鹐鵮鹑鶉鹒鶊鹓鵷鹔鷫鹕鶘鹖鶡鹗鶚鹘鶻鹙鶖鹚鷀鹛鶥鹜鶩鹝鷊鹞鷂鹟鶲鹠鶹鹡鶺鹢鷁鹣鶼鹤鶴鹥鷖鹦鸚鹧鷓鹨鷚鹩鷯鹪鷦鹫鷲鹬鷸鹭鷺鹮䴉鹯鸇鹰鷹鹱鸌鹲鸏鹳鸛鹴鸘鹾鹺麦麥麸麩麹麴麺麪麽麼黄黃黉黌黡黶黩黷黪黲黾黽鼋黿鼌鼂鼍鼉鼹鼴齐齊齑齏齿齒龀齔龁齕龂齗龃齟龄齡龅齙龆齠龇齜龈齦龉齬龊齪龋齲龌齷龙龍龚龔龛龕龟龜鿎䃮鿏䥑鿒鿓鿔鎶";
var TW_MAP = null;
function twMap() {
    if (!TW_MAP) {
        TW_MAP = {};
        for (var i = 0; i + 1 < TWP.length; i += 2) TW_MAP[TWP.charAt(i)] = TWP.charAt(i + 1);
    }
    return TW_MAP;
}
function toTW(s) {
    s = String(s == null ? "" : s);
    var M = twMap();
    var parts = s.split(/(https?:\\/\\/[^\\s<>"']+)/g);
    for (var i = 0; i < parts.length; i += 2) {
        var p = parts[i], out = "";
        for (var j = 0; j < p.length; j++) { var ch = p.charAt(j); out += M[ch] || ch; }
        parts[i] = out;
    }
    return parts.join("").split("爲").join("為");
}
/* 课程对象转繁体（学员端展示用；管理端不调用，避免污染数据） */
function twCourse(c) {
    if (!c || c._twc) return c;
    var nc = {};
    for (var k in c) { if (Object.prototype.hasOwnProperty.call(c, k)) nc[k] = c[k]; }
    ["title", "content", "category", "subcategory", "instructions"].forEach(function(k) { if (nc[k]) nc[k] = toTW(nc[k]); });
    if (nc.video_url) {
        nc.video_url = String(nc.video_url).split("\\n").map(function(line) {
            var p = line.indexOf("|");
            if (p > 0) return toTW(line.slice(0, p)) + line.slice(p);
            return line;
        }).join("\\n");
    }
    if (nc.guide_json !== undefined) try {
        var g = JSON.parse(nc.guide_json || "[]");
        g.forEach(function(ch) {
            if (ch.title) ch.title = toTW(ch.title);
            if (Array.isArray(ch.points)) ch.points = ch.points.map(function(x) { return toTW(x); });
        });
        nc.guide_json = JSON.stringify(g);
    } catch (e) {}
    if (nc.quizzes_json !== undefined) try {
        var qs = JSON.parse(nc.quizzes_json || "[]");
        qs.forEach(function(q) {
            ["q", "o", "h", "s"].forEach(function(k) { if (q[k]) q[k] = toTW(q[k]); });
        });
        nc.quizzes_json = JSON.stringify(qs);
    } catch (e) {}
    nc._twc = 1;
    return nc;
}
/* 课程内容多语言：en/ja/ko 用 i18n_json，无翻译时回退中文 */
function i18nCourse(c) {
    if (!c || c._i18nc) return c;
    var L = curLang();
    if (L !== 'en' && L !== 'ja' && L !== 'ko') return c;
    var i18n = null;
    try { i18n = JSON.parse(c.i18n_json || '{}'); } catch (e) {}
    if (!i18n || !i18n[L]) return c;
    var d = i18n[L];
    var nc = {};
    for (var k in c) { if (Object.prototype.hasOwnProperty.call(c, k)) nc[k] = c[k]; }
    if (d.title) nc.title = d.title;
    if (d.content) nc.content = d.content;
    if (d.instructions) nc.instructions = d.instructions;
    if (d.guide) {
        try {
            var g = JSON.parse(nc.guide_json || "[]");
            // d.guide 是翻译后的数组，直接替换
            if (Array.isArray(d.guide) && d.guide.length === g.length) {
                nc.guide_json = JSON.stringify(d.guide);
            }
        } catch (e) {}
    }
    if (d.quizzes) {
        try {
            var qs = JSON.parse(nc.quizzes_json || "[]");
            if (Array.isArray(d.quizzes) && d.quizzes.length === qs.length) {
                // 替换 q/s/a，保留 id 等；o（经文出处）不翻译，保持原文用于 bible_verses 查询
                for (var i = 0; i < qs.length; i++) {
                    if (d.quizzes[i].q) qs[i].q = d.quizzes[i].q;
                    if (d.quizzes[i].s) qs[i].s = d.quizzes[i].s;
                    if (d.quizzes[i].a) qs[i].a = d.quizzes[i].a;
                }
                nc.quizzes_json = JSON.stringify(qs);
            }
        } catch (e) {}
    }
    nc._i18nc = 1;
    return nc;
}

        /* 学习进度（存浏览器本地） */
        function getProg() { try { return JSON.parse(localStorage.getItem(PROG_KEY) || "{}"); } catch(e) { return {}; } }
        function setProg(p) { localStorage.setItem(PROG_KEY, JSON.stringify(p)); }
        /* 学习进度按姓名隔离；未登录视为空；老格式（顶层为课程id）自动迁移到当前姓名下 */
        function progName() { try { return (localStorage.getItem(USER_KEY) || "").trim(); } catch (e) { return ""; } }
        function getMyProg() {
            var nm = progName();
            var all = getProg();
            if (!nm) return {};
            if (all[nm] && typeof all[nm] === "object" && !("started" in all[nm]) && !("completed" in all[nm])) return all[nm];
            var mine = {}, rest = {}, moved = false, k, v;
            for (k in all) {
                if (!all.hasOwnProperty(k)) continue;
                if (k === nm) { rest[k] = all[k]; continue; }
                v = all[k];
                if (v && typeof v === "object" && ("started" in v || "completed" in v)) { mine[k] = v; moved = true; }
                else rest[k] = v;
            }
            if (moved) { rest[nm] = mine; setProg(rest); return mine; }
            return {};
        }
        function setMyProg(p) {
            var nm = progName();
            if (!nm) return;
            var all = getProg();
            all[nm] = p;
            setProg(all);
        }

        /* 错题本（按姓名存浏览器本地） */
        function getWrong() { try { return JSON.parse(localStorage.getItem(WRONG_KEY) || "{}"); } catch(e) { return {}; } }
        function setWrong(w) { try { localStorage.setItem(WRONG_KEY, JSON.stringify(w)); } catch(e) {} }
        function saveWrongs(items) {
            var name = progName() || tr("wbAnon");
            var w = getWrong();
            var arr = w[name] || [];
            items.forEach(function(it) {
                arr = arr.filter(function(x) { return !(x.cid === it.cid && x.q === it.q); });
                arr.unshift(it);
            });
            w[name] = arr.slice(0, 100);
            setWrong(w);
        }
        function openWrongBook(courseId) {
            window._wrongCourseId = courseId || null;
            var name = progName() || tr("wbAnon");
            var all = (getWrong()[name] || []);
            var arr = courseId ? all.filter(function(x) { return x.cid === courseId; }) : all;
            var titleEl = document.getElementById('wrongBookTitle');
            if (titleEl) titleEl.innerText = courseId ? (tr("wbT") + (arr.length && arr[0].title ? ' · ' + arr[0].title : '')) : tr("wbMyT");
            var list = document.getElementById('wrongBookList');
            if (!arr.length) {
                list.innerHTML = '<div class="text-center text-slate-400 text-sm py-10">' + (courseId ? tr("wbEmptyC") : tr("wbEmpty")) + '</div>';
            } else {
                list.innerHTML = arr.map(function(x) {
                    return '<div class="border border-slate-100 rounded-2xl p-4">'
                        + '<div class="text-[11px] text-violet-500 font-bold mb-1">' + esc([x.series, x.sub, x.title].filter(function(s) { return s; }).join(' · ') || '') + '</div>'
                        + '<div class="text-[11px] text-indigo-500 font-bold mb-1">' + esc(wrongTypeNum(x)) + '</div>'
                        + '<div class="text-sm font-bold text-slate-800 mb-2">' + esc(x.type === 'verse' ? stripVerseTag(x.q) : (x.q || '')) + '</div>'
                        + '<div class="text-xs text-slate-500">' + tr("wbU") + esc(x.u || tr("wbNA")) + '</div>'
                        + '<div class="text-xs text-emerald-600 font-bold mt-1">' + tr("wbE") + esc(x.expected || '') + '</div></div>';
                }).join('');
            }
            toggleModal('wrongBookModal');
        }
        function clearWrongBook() {
            var fc = window._wrongCourseId || null;
            if (!confirm(fc ? tr("wbClearC") : tr("wbClearA"))) return;
            var name = progName() || tr("wbAnon");
            var w = getWrong();
            if (fc) w[name] = (w[name] || []).filter(function(x) { return x.cid !== fc; });
            else w[name] = [];
            setWrong(w);
            openWrongBook(fc);
        }

        /* 小工具 */
        function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
        function stripEmoji(s) { return String(s == null ? "" : s).replace(/^[📖📜\s]+/, ""); } /* 去掉标题开头自带的 📖，避免与固定图标重复 */
        /* 去掉经文题干开头的"【经文填空】"等字样（支持翻译后的[]版本） */
        function stripVerseTag(s) {
            s = String(s == null ? "" : s);
            if (s.charAt(0) === '【') { var e = s.indexOf('】'); if (e > 0 && e < 12) s = s.slice(e + 1); }
            else if (s.charAt(0) === '[') { var e2 = s.indexOf(']'); if (e2 > 0 && e2 < 40) s = s.slice(e2 + 1); }
            return s;
        }
        /* 经文高亮：引用→紫色徽章（完整显示），引用后经文正文→琥珀底纹；s须为已转义文本 */
        var BIBLE_BOOKS_TW = null;
        function bibleBooks() { if (!BIBLE_BOOKS_TW) BIBLE_BOOKS_TW = BIBLE_BOOKS + '|' + toTW(BIBLE_BOOKS); return BIBLE_BOOKS_TW; }
        var BIBLE_BOOKS = '撒母耳记上|撒母耳记下|列王纪上|列王纪下|历代志上|历代志下|帖撒罗尼迦前书|帖撒罗尼迦后书|提摩太前书|提摩太后书|哥林多前书|哥林多后书|约翰一书|约翰二书|约翰三书|彼得前书|彼得后书|创世记|出埃及记|利未记|民数记|申命记|约书亚记|士师记|路得记|以斯拉记|尼希米记|以斯帖记|约伯记|传道书|以赛亚书|耶利米书|耶利米哀歌|以西结书|但以理书|何西阿书|约珥书|阿摩司书|俄巴底亚书|约拿书|弥迦书|那鸿书|哈巴谷书|西番雅书|哈该书|撒迦利亚书|玛拉基书|马太福音|马可福音|路加福音|约翰福音|使徒行传|罗马书|加拉太书|以弗所书|腓立比书|歌罗西书|提多书|腓利门书|希伯来书|雅各书|犹大书|启示录|诗篇|箴言|雅歌|撒上|撒下|王上|王下|代上|代下|林前|林后|帖前|帖后|提前|提后|彼前|彼后|约壹|约贰|约叁|创|出|利|民|申|书|士|得|拉|尼|斯|伯|诗|箴|传|歌|赛|耶|哀|结|但|何|珥|摩|俄|拿|弥|鸿|哈|番|该|亚|玛|太|可|路|约|徒|罗|加|弗|腓|西|多|门|来|雅|犹|启';
        /* 英文书名（全称+常用缩写） */
        var BIBLE_BOOKS_EN = '1 Samuel|2 Samuel|1 Kings|2 Kings|1 Chronicles|2 Chronicles|1 Corinthians|2 Corinthians|1 Thessalonians|2 Thessalonians|1 Timothy|2 Timothy|1 Peter|2 Peter|1 John|2 John|3 John|Song of Solomon|Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Ezra|Nehemiah|Esther|Job|Psalms|Proverbs|Ecclesiastes|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Galatians|Ephesians|Philippians|Colossians|Titus|Philemon|Hebrews|James|Jude|Revelation|Gen|Ex|Lev|Num|Deut|Josh|Judg|Ruth|1 Sam|2 Sam|1 Kgs|2 Kgs|1 Chr|2 Chr|Ezra|Neh|Esth|Job|Ps|Prov|Eccl|Song|Isa|Jer|Lam|Ezek|Dan|Hos|Joel|Amos|Obad|Jonah|Mic|Nah|Hab|Zeph|Hag|Zech|Mal|Matt|Mark|Luke|John|Acts|Rom|1 Cor|2 Cor|Gal|Eph|Phil|Col|1 Thess|2 Thess|1 Tim|2 Tim|Titus|Phlm|Heb|Jas|1 Pet|2 Pet|1 Jn|2 Jn|3 Jn|Jude|Rev';
        /* 日文书名 */
        var BIBLE_BOOKS_JA = 'サムエル記第一|サムエル記第二|列王記第一|列王記第二|歴代誌第一|歴代誌第二|コリント人への第一の手紙|コリント人への第二の手紙|テサロニケ人への第一の手紙|テサロニケ人への第二の手紙|テモテへの第一の手紙|テモテへの第二の手紙|ペテロの第一の手紙|ペテロの第二の手紙|ヨハネの第一の手紙|ヨハネの第二の手紙|ヨハネの第三の手紙|創世記|出エジプト記|レビ記|民数記|申命記|ヨシュア記|士師記|ルツ記|エズラ記|ネヘミヤ記|エステル記|ヨブ記|詩篇|箴言|伝道者の書|雅歌|イザヤ書|エレミヤ書|哀歌|エゼキエル書|ダニエル書|ホセア書|ヨエル書|アモス書|オバデヤ書|ヨナ書|ミカ書|ナホム書|ハバクク書|ゼパニヤ書|ハガイ書|ゼカリヤ書|マラキ書|マタイの福音書|マルコの福音書|ルカの福音書|ヨハネの福音書|使徒の働き|ローマ人への手紙|ガラテヤ人への手紙|エペソ人への手紙|ピリピ人への手紙|コロサイ人への手紙|テトスへの手紙|ピレモンへの手紙|ヘブル人への手紙|ヤコブの手紙|ユダの手紙|黙示録|創|出|レビ|民|申|ヨシュア|士師|ルツ|サムエル上|サムエル下|列王上|列王下|歴代上|歴代下|エズラ|ネヘミヤ|エステル|ヨブ|詩|箴言|伝道|雅歌|イザヤ|エレミヤ|哀歌|エゼキエル|ダニエル|ホセア|ヨエル|アモス|オバデヤ|ヨナ|ミカ|ナホム|ハバクク|ゼパニヤ|ハガイ|ゼカリヤ|マラキ|マタイ|マルコ|ルカ|ヨハネ|使徒|ローマ|コリント上|コリント下|ガラテヤ|エペソ|ピリピ|コロサイ|テサロニケ上|テサロニケ下|テモテ上|テモテ下|テトス|ピレモン|ヘブル|ヤコブ|ペテロ上|ペテロ下|ヨハネ上|ヨハネ下|ヨハネ三|ユダ|黙示';
        /* 韩文书名 */
        var BIBLE_BOOKS_KO = '사무엘상|사무엘하|열왕기상|열왕기하|역대상|역대하|고린도전서|고린도후서|데살로니가전서|데살로니가후서|디모데전서|디모데후서|베드로전서|베드로후서|요한1서|요한2서|요한3서|창세기|출애굽기|레위기|민수기|신명기|여호수아|사사기|룻기|에스라|느헤미야|에스더|욥기|시편|잠언|전도서|아가|이사야|예레미야|예레미야애가|에스겔|다니엘|호세아|요엘|아모스|오바댜|요나|미가|나훔|하박국|스바냐|학개|스가랴|말라기|마태복음|마가복음|누가복음|요한복음|사도행전|로마서|갈라디아서|에베소서|빌립보서|골로새서|디도서|빌레몬서|히브리서|야고보서|유다서|요한계시록|삼상|삼하|왕상|왕하|대상|대하|고전|고후|살전|살후|딤전|딤후|벧전|벧후|요일|요이|요삼|창|출|레|민|신|수|삿|룻|스|느|에|욥|시|잠|전|아|사|렘|애|겔|단|호|욜|암|옵|욘|미|나|합|습|학|슥|말|마|막|눅|요|행|롬|갈|엡|빌|골|살전|살후|딤전|딤후|딛|몬|히|약|유|계';
        /* 经文高亮：引用→紫色徽章（完整显示），引用后经文正文→琥珀底纹；s须为已转义文本 */
        /* 书名简称→全称（如太→马太福音），高亮徽章统一显示全称 */
        var BOOK_FULL = null;
        function bookFull(nm) {
            if (!BOOK_FULL) {
                BOOK_FULL = {};
                var pairs = '撒上=撒母耳记上|撒下=撒母耳记下|王上=列王纪上|王下=列王纪下|代上=历代志上|代下=历代志下|林前=哥林多前书|林后=哥林多后书|帖前=帖撒罗尼迦前书|帖后=帖撒罗尼迦后书|提前=提摩太前书|提后=提摩太后书|彼前=彼得前书|彼后=彼得后书|约壹=约翰一书|约贰=约翰二书|约叁=约翰三书|创=创世记|出=出埃及记|利=利未记|民=民数记|申=申命记|书=约书亚记|士=士师记|得=路得记|拉=以斯拉记|尼=尼希米记|斯=以斯帖记|伯=约伯记|诗=诗篇|箴=箴言|传=传道书|歌=雅歌|赛=以赛亚书|耶=耶利米书|哀=耶利米哀歌|结=以西结书|但=但以理书|何=何西阿书|珥=约珥书|摩=阿摩司书|俄=俄巴底亚书|拿=约拿书|弥=弥迦书|鸿=那鸿书|哈=哈巴谷书|番=西番雅书|该=哈该书|亚=撒迦利亚书|玛=玛拉基书|太=马太福音|可=马可福音|路=路加福音|约=约翰福音|徒=使徒行传|罗=罗马书|加=加拉太书|弗=以弗所书|腓=腓立比书|西=歌罗西书|多=提多书|门=腓利门书|来=希伯来书|雅=雅各书|犹=犹大书|启=启示录'.split('|'), i, kv;
                for (var i = 0; i < pairs.length; i++) { var kv = pairs[i].split('='); BOOK_FULL[kv[0]] = kv[1]; BOOK_FULL[toTW(kv[0])] = kv[1]; }
            }
            var f = BOOK_FULL[nm];
            if (!f) return nm;
            return curLang() === 'tw' ? toTW(f) : f;
        }
        /* 子栏目名差异化高亮：旧约/新约/讲员实心徽章 + 分类描边徽章 */
        /* 子栏目徽章：A+B 命名规则，A 实心徽章 + B 描边徽章 */
        function hlSubcat(s) {
            s = esc(s);
            var SOLID = 'display:inline-block;font-weight:700;font-size:.72rem;padding:.12rem .6rem;border-radius:9999px;white-space:nowrap;vertical-align:.05em;box-shadow:0 1px 4px rgba(0,0,0,.2);color:#fff;';
            var HOLLOW = 'display:inline-block;font-weight:700;font-size:.72rem;padding:.1rem .55rem;border-radius:9999px;white-space:nowrap;vertical-align:.05em;border:1.5px solid;';
            var DOT = '<span style="color:#94a3b8;margin:0 .3rem;font-weight:900;">•</span>';
            function solidBadge(t, bg) {
                return '<span style="' + SOLID + 'background:' + bg + ';">' + t + '</span>';
            }
            function hollowBadge(t, color, bg) {
                return '<span style="' + HOLLOW + 'color:' + color + ';border-color:' + color + ';background:' + bg + ';">' + t + '</span>';
            }
            var pi = s.indexOf('•');
            if (pi < 0) pi = s.indexOf('+');
            if (pi > 0) {
                var A = s.slice(0, pi).trim(), B = s.slice(pi + 1).trim();
                var bg1, c2, bg2;
                if (/旧|舊|Old|구약/.test(A)) {
                    bg1 = 'linear-gradient(135deg,#f59e0b,#d97706)'; c2 = '#b45309'; bg2 = '#fef3c7';
                } else if (/新|New|신약/.test(A)) {
                    bg1 = 'linear-gradient(135deg,#3b82f6,#1d4ed8)'; c2 = '#1d4ed8'; bg2 = '#dbeafe';
                } else {
                    bg1 = 'linear-gradient(135deg,#8b5cf6,#6d28d9)'; c2 = '#6d28d9'; bg2 = '#ede9fe';
                }
                return solidBadge(A, bg1) + (B ? DOT + hollowBadge(B, c2, bg2) : '');
            }
            return s;
        }
        /* 子栏目徽章深色版（课件页头用）：A+B 拆分，A 实心 + B 描边 */
        function subBadgeDark(s) {
            s = String(s || '');
            var pi = s.indexOf('•');
            if (pi < 0) pi = s.indexOf('+');
            if (pi <= 0) return '<span class="bg-amber-900/60 text-amber-200 px-2.5 py-0.5 rounded-full border border-amber-600/50 truncate">📁 ' + esc(s) + '</span>';
            var A = s.slice(0, pi).trim(), B = s.slice(pi + 1).trim();
            var bgA, bdB, txB;
            if (/旧|舊|Old|구약/.test(A)) { bgA = 'background:linear-gradient(135deg,#f59e0b,#d97706)'; bdB = '#fbbf24'; txB = '#fde68a'; }
            else if (/新|New|신약/.test(A)) { bgA = 'background:linear-gradient(135deg,#3b82f6,#1d4ed8)'; bdB = '#93c5fd'; txB = '#bfdbfe'; }
            else { bgA = 'background:linear-gradient(135deg,#8b5cf6,#6d28d9)'; bdB = '#c4b5fd'; txB = '#ddd6fe'; }
            return '<span class="truncate" style="display:inline-flex;align-items:center;gap:.35rem;">'
                + '<span style="display:inline-block;font-weight:700;font-size:.72rem;padding:.12rem .6rem;border-radius:9999px;white-space:nowrap;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.3);' + bgA + ';">' + esc(A) + '</span>'
                + (B ? '<span style="display:inline-block;font-weight:700;font-size:.72rem;padding:.1rem .55rem;border-radius:9999px;white-space:nowrap;border:1.5px solid ' + bdB + ';color:' + txB + ';">' + esc(B) + '</span>' : '')
                + '</span>';
        }
        /* 系列名匹配图标 */
        function catIcon(cat) {
            var c = String(cat || "").trim();
            /* 全名精确匹配（按名称含义） */
            var fullMap = {
                "基要真理": "🏠",
                "圣经导览": "🗺️"
            };
            if (fullMap[c]) return fullMap[c];
            /* 按全名含义语义匹配 */
            if (/导览|概览|纵览/.test(c)) return "🗺️";
            if (/基要|根基|初信|栽培/.test(c)) return "🏠";
            if (/真理|教义|神学/.test(c)) return "📖";
            if (/祷告|祈祷/.test(c)) return "🙏";
            if (/敬拜|赞美|诗歌/.test(c)) return "🎵";
            if (/宣教|布道|差传/.test(c)) return "🌍";
            if (/团契|小组|相交/.test(c)) return "🤝";
            if (/家庭|婚姻|亲子/.test(c)) return "👨‍👩‍👧‍👦";
            if (/福音书|福音/.test(c)) return "✝️";
            if (/书信/.test(c)) return "✉️";
            if (/先知|预言|启示/.test(c)) return "🔥";
            if (/智慧/.test(c)) return "💡";
            if (/历史/.test(c)) return "🏛️";
            if (/圣经|经卷/.test(c)) return "📖";
            return "📚";
        }
        function hlVerse(s) {
            s = String(s == null ? "" : s);
            var L = curLang();
            var isEN = (L === 'en'), isJA = (L === 'ja'), isKO = (L === 'ko');
            var JIE = (L === 'tw') ? '節' : '节';
            var JIEP = '[节節]';
            var ZP = '[章篇]';
            var SP = ' *';
            var DASH = '[\u2013\u2014\uFF0D-]';
            /* vref：fmt=en/ja/ko/zh，输出对应语言格式的徽章 */
            var BOOK_ZH2KO = null;
            function bookZh2Ko(nm) {
                if (!BOOK_ZH2KO) {
                    var ko = BIBLE_BOOKS_KO.split('|'), zh = '撒母耳记上|撒母耳记下|列王纪上|列王纪下|历代志上|历代志下|哥林多前书|哥林多后书|帖撒罗尼迦前书|帖撒罗尼迦后书|提摩太前书|提摩太后书|彼得前书|彼得后书|约翰一书|约翰二书|约翰三书|创世记|出埃及记|利未记|民数记|申命记|约书亚记|士师记|路得记|以斯拉记|尼希米记|以斯帖记|约伯记|诗篇|箴言|传道书|雅歌|以赛亚书|耶利米书|耶利米哀歌|以西结书|但以理书|何西阿书|约珥书|阿摩司书|俄巴底亚书|约拿书|弥迦书|那鸿书|哈巴谷书|西番雅书|哈该书|撒迦利亚书|玛拉基书|马太福音|马可福音|路加福音|约翰福音|使徒行传|罗马书|加拉太书|以弗所书|腓立比书|歌罗西书|提多书|腓利门书|希伯来书|雅各书|犹大书|启示录'.split('|');
                    BOOK_ZH2KO = {};
                    for (var i = 0; i < zh.length && i < ko.length; i++) BOOK_ZH2KO[zh[i]] = ko[i];
                    // 简称也映射
                    var abbr = '撒上|撒下|王上|王下|代上|代下|林前|林后|帖前|帖后|提前|提后|彼前|彼后|约壹|约贰|约叁|创|出|利|民|申|书|士|得|拉|尼|斯|伯|诗|箴|传|歌|赛|耶|哀|结|但|何|珥|摩|俄|拿|弥|鸿|哈|番|该|亚|玛|太|可|路|约|徒|罗|加|弗|腓|西|多|门|来|雅|犹|启'.split('|');
                    for (var j = 0; j < abbr.length && j < ko.length; j++) BOOK_ZH2KO[abbr[j]] = ko[j];
                }
                return BOOK_ZH2KO[nm] || nm;
            }
            var BOOK_ZH2EN = null, BOOK_ZH2JA = null;
            function bookZh2En(nm) {
                if (!BOOK_ZH2EN) {
                    var en = BIBLE_BOOKS_EN.split('|'), zh = '撒母耳记上|撒母耳记下|列王纪上|列王纪下|历代志上|历代志下|哥林多前书|哥林多后书|帖撒罗尼迦前书|帖撒罗尼迦后书|提摩太前书|提摩太后书|彼得前书|彼得后书|约翰一书|约翰二书|约翰三书|创世记|出埃及记|利未记|民数记|申命记|约书亚记|士师记|路得记|以斯拉记|尼希米记|以斯帖记|约伯记|诗篇|箴言|传道书|雅歌|以赛亚书|耶利米书|耶利米哀歌|以西结书|但以理书|何西阿书|约珥书|阿摩司书|俄巴底亚书|约拿书|弥迦书|那鸿书|哈巴谷书|西番雅书|哈该书|撒迦利亚书|玛拉基书|马太福音|马可福音|路加福音|约翰福音|使徒行传|罗马书|加拉太书|以弗所书|腓立比书|歌罗西书|提多书|腓利门书|希伯来书|雅各书|犹大书|启示录'.split('|');
                    BOOK_ZH2EN = {};
                    for (var i = 0; i < zh.length && i < en.length; i++) BOOK_ZH2EN[zh[i]] = en[i];
                }
                return BOOK_ZH2EN[nm] || nm;
            }
            function bookZh2Ja(nm) {
                if (!BOOK_ZH2JA) {
                    var ja = BIBLE_BOOKS_JA.split('|'), zh = '撒母耳记上|撒母耳记下|列王纪上|列王纪下|历代志上|历代志下|哥林多前书|哥林多后书|帖撒罗尼迦前书|帖撒罗尼迦后书|提摩太前书|提摩太后书|彼得前书|彼得后书|约翰一书|约翰二书|约翰三书|创世记|出埃及记|利未记|民数记|申命记|约书亚记|士师记|路得记|以斯拉记|尼希米记|以斯帖记|约伯记|诗篇|箴言|传道书|雅歌|以赛亚书|耶利米书|耶利米哀歌|以西结书|但以理书|何西阿书|约珥书|阿摩司书|俄巴底亚书|约拿书|弥迦书|那鸿书|哈巴谷书|西番雅书|哈该书|撒迦利亚书|玛拉基书|马太福音|马可福音|路加福音|约翰福音|使徒行传|罗马书|加拉太书|以弗所书|腓立比书|歌罗西书|提多书|腓利门书|希伯来书|雅各书|犹大书|启示录'.split('|');
                    BOOK_ZH2JA = {};
                    for (var i = 0; i < zh.length && i < ja.length; i++) BOOK_ZH2JA[zh[i]] = ja[i];
                }
                return BOOK_ZH2JA[nm] || nm;
            }
            function vref(bk, ch, vs, ve, fmt) {
                var numTxt, bookTxt = bk;
                if (fmt === 'ko') bookTxt = bookZh2Ko(bookFull(bk));
                else if (fmt === 'en') bookTxt = bookZh2En(bookFull(bk));
                else if (fmt === 'ja') bookTxt = bookZh2Ja(bookFull(bk));
                if (fmt === 'en') {
                    numTxt = ch + (vs ? ':' + vs + (ve ? '-' + ve : '') : '');
                } else if (fmt === 'ja') {
                    numTxt = '第' + ch + '章' + (vs ? vs + (ve ? '-' + ve : '') + '節' : '');
                } else if (fmt === 'ko') {
                    numTxt = ch + '장' + (vs ? ' ' + vs + (ve ? '-' + ve : '') + '절' : '');
                } else {
                    var unit = /诗篇|詩篇/.test(bk) ? '篇' : '章';
                    numTxt = '第' + ch + unit + (vs ? vs + (ve ? '-' + ve : '') + JIE : '');
                    bookTxt = bookFull(bk);
                }
                return '<span class="verse-ref-icon">📜</span>'
                    + '<span class="verse-ref-book">' + bookTxt + '</span>'
                    + '<span class="verse-ref-num">' + numTxt + '</span>';
            }
            /* 英日韩遍：Book 3:16（含经文正文琥珀高亮） */
            function passLang(text, books, fmt) {
                var B2 = books;
                var VP2 = new RegExp('(' + B2 + ')' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([0-9]+)' + SP + DASH + SP + '([0-9]+)' + SP + '[:：]' + SP + '([^<]*)'
                    + '|(' + B2 + ')' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([0-9]+)' + SP + DASH + SP + '([0-9]+)'
                    + '|(' + B2 + ')' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([^<]*)'
                    + '|(' + B2 + ')' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([0-9]+)', 'g');
                return text.replace(VP2, function (m) {
                    var a = arguments;
                    if (a[1] !== undefined) return vref(a[1], a[2], a[3], a[4], fmt) + '<span class="verse-text">' + a[5] + '</span>';
                    if (a[6] !== undefined) return vref(a[6], a[7], a[8], a[9], fmt);
                    if (a[10] !== undefined) return vref(a[10], a[11], a[12], null, fmt) + '<span class="verse-text">' + a[13] + '</span>';
                    return vref(a[14], a[15], a[16], null, fmt);
                });
            }
            /* 第一遍：目标语言（英日韩） */
            if (isEN) s = passLang(s, BIBLE_BOOKS_EN, 'en');
            else if (isJA) s = passLang(s, BIBLE_BOOKS_JA, 'ja');
            else if (isKO) s = passLang(s, BIBLE_BOOKS_KO, 'ko');
            /* 第二遍：中文（覆盖未翻译的fallback内容；中文模式下这是主遍） */
            var B = bibleBooks();
            var VP = new RegExp('《(' + B + ')》' + SP + '([0-9]+)' + SP + ZP + SP + '([0-9]+)' + SP + DASH + SP + '([0-9]+)' + SP + JIEP
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + ZP + SP + '([0-9]+)' + SP + DASH + SP + '([0-9]+)' + SP + JIEP
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([0-9]+)' + SP + DASH + SP + '([0-9]+)' + SP + '[：:]' + SP + '([^<]*)'
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([0-9]+)' + SP + DASH + SP + '([0-9]+)'
                + '|《(' + B + ')》' + SP + '([0-9]+)' + SP + ZP + SP + '([0-9]+)' + SP + JIEP
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + ZP + SP + '([0-9]+)' + SP + JIEP + SP + '[说說]' + SP + '[：:，,]' + SP + '([^<]*)'
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + ZP + SP + '([0-9]+)' + SP + JIEP + SP + '[：:]' + SP + '([^<]*)'
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + ZP + SP + '([0-9]+)' + SP + JIEP
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([0-9]+)' + SP + '[：:]' + SP + '([^<]*)'
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([0-9]+)'
                + '|《(' + B + ')》' + SP + '([0-9]+)' + SP + ZP + SP + '([0-9]+)' + SP + '(?!' + JIEP + ')'
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + ZP + SP + '([0-9]+)' + SP + '(?!' + JIEP + ')'
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + ZP + SP + '[：:]' + SP + '([^<]*)'
                + '|(' + B + ')' + SP + '([0-9]+)' + SP + ZP + '(?!' + SP + '[0-9])', 'g');
            var langFmt = isEN ? 'en' : isJA ? 'ja' : isKO ? 'ko' : 'zh';
            s = s.replace(VP, function (m) {
                var a = arguments;
                if (a[1] !== undefined) return vref(a[1], a[2], a[3], a[4], langFmt);
                if (a[5] !== undefined) return vref(a[5], a[6], a[7], a[8], langFmt);
                if (a[9] !== undefined) return vref(a[9], a[10], a[11], a[12], langFmt) + '<span class="verse-text">' + a[13] + '</span>';
                if (a[14] !== undefined) return vref(a[14], a[15], a[16], a[17], langFmt);
                if (a[18] !== undefined) return vref(a[18], a[19], a[20], null, langFmt);
                if (a[21] !== undefined) return vref(a[21], a[22], a[23], null, langFmt) + '<span class="verse-text">' + a[24] + '</span>';
                if (a[25] !== undefined) return vref(a[25], a[26], a[27], null, langFmt) + '<span class="verse-text">' + a[28] + '</span>';
                if (a[29] !== undefined) return vref(a[29], a[30], a[31], null, langFmt);
                if (a[32] !== undefined) return vref(a[32], a[33], a[34], null, langFmt) + '<span class="verse-text">' + a[35] + '</span>';
                if (a[36] !== undefined) return vref(a[36], a[37], a[38], null, langFmt);
                if (a[39] !== undefined) return vref(a[39], a[40], a[41], null, langFmt);
                if (a[42] !== undefined) return vref(a[42], a[43], a[44], null, langFmt);
                if (a[45] !== undefined) return vref(a[45], a[46], null, null, langFmt) + '<span class="verse-text">' + a[47] + '</span>';
                if (a[48] !== undefined) return vref(a[48], a[49], null, null, langFmt);
                return vref(a[48], a[49], null, null, langFmt);
            });
            return s;
        }
        /* verseSegs：将 hlVerse 输出切分为段 [{k:0普通|1引用|2经文, t:文本}]，供 PPT 多 run 渲染 */
        /* verseSegs：将 hlVerse 输出切分为段 [{k:0普通|1书名|2经文|3章节|4图标, t:文本}]，供 PPT 多 run 渲染 */
        function verseSegs(s) {
            var html = hlVerse(s), segs = [], i = 0;
            var tags = [['<span class="verse-ref-icon">', 4], ['<span class="verse-ref-book">', 1], ['<span class="verse-ref-num">', 3],
                        ['<span class="verse-ref">', 1], ['<span class="verse-text">', 2]];
            var E = '</span>';
            while (i < html.length) {
                var bj = -1, bk = 0, btag = '', ti, j;
                for (ti = 0; ti < tags.length; ti++) {
                    j = html.indexOf(tags[ti][0], i);
                    if (j >= 0 && (bj < 0 || j < bj)) { bj = j; bk = tags[ti][1]; btag = tags[ti][0]; }
                }
                if (bj < 0) { segs.push({ k: 0, t: html.slice(i) }); break; }
                if (bj > i) segs.push({ k: 0, t: html.slice(i, bj) });
                var e = html.indexOf(E, bj + btag.length);
                segs.push({ k: bk, t: html.slice(bj + btag.length, e) });
                i = e + E.length;
            }
            return segs;
        }
        function stripMd(s) { return String(s || "").replace(/[#>*_~]/g, "").replace(/\\\\s+/g, " ").trim(); }
        function fmtTime(t) { if (!t) return ""; try { return new Date(t).toLocaleString("zh-CN", { hour12: false }).slice(0, 16); } catch(e) { return t; } }
        /* 字号调节：改根 font-size，Tailwind rem 单位全站跟随；localStorage 持久化 */
        var FONT_KEY = "TQ_FONT_V1";
        var FONT_SCALES = [0.85, 1, 1.15, 1.3, 1.5];
        var FONT_LABELS = [tr("fontS"), tr("fontM"), tr("fontL"), tr("fontXL"), tr("fontXXL")];
        var FONT_DEFAULT = 2;
        function getFontIdx() { var v = String(FONT_DEFAULT); try { v = localStorage.getItem(FONT_KEY) || v; } catch (e) {} var i = parseInt(v, 10); if (isNaN(i)) i = FONT_DEFAULT; return Math.min(4, Math.max(0, i)); }
        function applyFontScale() {
            var i = getFontIdx();
            document.documentElement.style.fontSize = (16 * FONT_SCALES[i]) + "px";
            var lb = document.getElementById("fontLevelLabel"); if (lb) lb.innerText = FONT_LABELS[i];
        }
        function fontStep(d) { var i = getFontIdx() + d; i = Math.min(4, Math.max(0, i)); try { localStorage.setItem(FONT_KEY, String(i)); } catch(e) {} applyFontScale(); }
        var VIEW_MODE_KEY = "TQ_VIEW_MODE_V1";
        /* 视频显示：学员按网络环境二选一（零网络探测，最安全） */
        var VIDEO_NET_KEY = "TQ_VIDEO_NET_ENV_V1";
        var BLOCKED_VIDEO_DOMAINS = ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "twitch.tv", "facebook.com", "twitter.com", "instagram.com"];
        function videoDomain(url) {
            try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ""; }
        }
        /* 解析多视频链接：一行一个，格式 "名称|URL" 或纯 URL；返回 [{label, url}] */
        function parseVideoUrls(s) {
            var out = [];
            String(s || "").split("\\n").forEach(function (line) {
                line = line.trim();
                if (!line) return;
                var label = "", url = line;
                var p = line.indexOf("|");
                if (p > 0) { label = line.slice(0, p).trim(); url = line.slice(p + 1).trim(); }
                if (!url) return;
                if (!label) {
                    var d = videoDomain(url);
                    if (/youtu.?be|youtube/i.test(d)) label = "YouTube";
                    else if (/bilibili/i.test(d)) label = "哔哩哔哩";
                    else if (/weixin\\.qq/i.test(d)) label = "企业微盘";
                    else if (/\\.(mp4|webm|m4v|ogg)(\\?|#|$)/i.test(url)) label = "视频直链";
                    else label = d || "视频链接";
                }
                if (curLang() === "tw" && !BOOT.isAdmin) label = toTW(label);
                if (!isVideoBlocked(url)) out.push({ label: label, url: url });
            });
            return out;
        }
        function openVideoChoice(videos) {
            if (!videos.length) return;
            if (videos.length === 1) { openVideoUrl(videos[0].url); return; }
            window._vidsChoice = videos;
            var m = document.getElementById("videoChoiceModal");
            if (!m) return;
            document.getElementById("videoChoiceList").innerHTML = videos.map(function (v, i) {
                var wxTip = (isWeComUrl(v.url) && !isWeChat()) ? '<span class="block text-xs text-emerald-600 mt-0.5">' + tr("vidWx") + '</span>' : '';
                return '<button data-vi="' + i + '" onclick="openVideoByIdx(this)" class="w-full p-4 rounded-2xl border-2 border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 text-left transition active:scale-95 flex items-center gap-3">'
                    + '<span class="text-2xl">\u25b6\ufe0f</span><span><span class="block font-bold text-slate-800">' + esc(v.label) + '</span><span class="block text-xs text-slate-400 truncate max-w-[220px]">' + esc(v.url) + '</span>' + wxTip + '</span></button>';
            }).join("");
            m.classList.remove("hidden");
        }
        function openVideoByIdx(el) {
            var i = parseInt(el.getAttribute("data-vi") || "0", 10);
            var v = (window._vidsChoice || [])[i];
            document.getElementById("videoChoiceModal").classList.add("hidden");
            if (v && v.url) openVideoUrl(v.url);
        }
        function isWeChat() { try { return /micromessenger/i.test(navigator.userAgent); } catch (e) { return false; } }
        function isWeComUrl(u) { return /drive\\.weixin\\.qq\\.com/i.test(u || ""); }
        function openVideoUrl(url) {
            if (isWeComUrl(url) && !isWeChat()) {
                window._wecomPendingUrl = url;
                var m = document.getElementById("wechatTipModal");
                if (m) m.classList.remove("hidden");
                return;
            }
            window.open(url, "_blank", "noopener");
        }
        function copyWecomLink() {
            var url = window._wecomPendingUrl || "";
            var done = function () {
                var m = document.getElementById("wechatTipModal");
                if (m) m.classList.add("hidden");
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(done, done);
            } else {
                var ta = document.createElement("textarea");
                ta.value = url;
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand("copy"); } catch (e) {}
                document.body.removeChild(ta);
                done();
            }
        }
        function getVideoNetEnv() {
            try { return localStorage.getItem(VIDEO_NET_KEY) || ""; } catch (e) { return ""; }
        }
        function setVideoNetEnv(env, norefresh) {
            try { localStorage.setItem(VIDEO_NET_KEY, env); } catch (e) {}
            var m = document.getElementById("netEnvModal");
            if (m) m.classList.add("hidden");
            syncVideoBtn();
            if (!norefresh) location.reload();
        }
        function openNetEnvModal() {
            var m = document.getElementById("netEnvModal");
            if (m) {
                m.classList.remove("hidden");
                var cur = getVideoNetEnv() || "cn";
                document.querySelectorAll("#netEnvModal .netenv-opt").forEach(function (el) {
                    el.classList.toggle("netenv-cur", el.dataset.env === cur);
                });
            }
        }
        function isVideoBlocked(url) {
            if (!url) return false;
            var env = getVideoNetEnv() || "cn";
            if (env === "intl") return false;
            var d = videoDomain(url);
            if (!d) return false;
            for (var i = 0; i < BLOCKED_VIDEO_DOMAINS.length; i++) {
                var b = BLOCKED_VIDEO_DOMAINS[i];
                if (d === b || d.slice(-b.length - 1) === "." + b) return true;
            }
            return false;
        }
        function syncVideoBtn() {
            var b = document.getElementById("videoToggleBtn");
            if (b) {
                var env = getVideoNetEnv() || "cn";
                b.innerHTML = "🎬";
                b.title = tr("vidEntry") + (env === "cn" ? tr("vidSimple") : tr("vidAll")) + tr("vidToggle");
                b.style.opacity = env === "cn" ? ".55" : "1";
            }
        }

        function applyViewMode() {
            var mode = "mobile";
            try { mode = localStorage.getItem(VIEW_MODE_KEY) || "mobile"; } catch (e) {}
            var de = document.documentElement;
            var btn = document.getElementById("viewModeBtn");
            var vmFab = document.getElementById("viewModeFab");
            var fontFab = document.getElementById("fontFab");
            if (mode === "desktop") {
                de.classList.add("view-desktop");
                var scale = window.innerWidth / 1024;
                scale = Math.max(0.3, Math.min(1, scale));
                de.style.zoom = scale;
                var inv = 1 / scale;
                if (vmFab) { vmFab.style.zoom = inv; vmFab.style.left = "0.5rem"; vmFab.style.bottom = "5rem"; }
                if (fontFab) { fontFab.style.zoom = inv; fontFab.style.right = "0.5rem"; fontFab.style.bottom = "5rem"; }
            } else {
                de.classList.remove("view-desktop");
                de.style.zoom = "";
                if (vmFab) { vmFab.style.zoom = ""; vmFab.style.left = ""; vmFab.style.bottom = ""; }
                if (fontFab) { fontFab.style.zoom = ""; fontFab.style.right = ""; fontFab.style.bottom = ""; }
            }
            if (btn) {
                btn.innerHTML = mode === "desktop" ? "📱" : "🖥️";
                btn.title = mode === "desktop" ? tr("toMob") : tr("toDesk");
            }
        }
        function toggleViewMode() {
            var cur = "mobile";
            try { cur = localStorage.getItem(VIEW_MODE_KEY) || "mobile"; } catch (e) {}
            try { localStorage.setItem(VIEW_MODE_KEY, cur === "desktop" ? "mobile" : "desktop"); } catch (e) {}
            applyViewMode();
        }
        function toggleFontPanel() {
            var p = document.getElementById("fontPanel");
            var f = document.getElementById("fontFab");
            p.classList.toggle("hidden");
            if (f) f.classList.toggle("open", !p.classList.contains("hidden"));
        }
        function fontReset() { try { localStorage.setItem(FONT_KEY, String(FONT_DEFAULT)); } catch(e) {} applyFontScale(); }

        async function load() {
            /* 首屏数据服务端已注入 BOOT.list（学员端为精简版），无需再请求 /api/data；分类并行拉取 */
            var needFetch = BOOT.isAdmin || !(BOOT.list && BOOT.list.length);
            var dataP = needFetch ? fetch(BOOT.isAdmin ? '/api/data' : '/api/data?brief=1').then(function(r) { return r.json(); }).catch(function() { return []; }) : null;
            var catP = fetch('/api/categories').then(function(r) { return r.json(); }).catch(function() { return []; });
            allData = dataP ? await dataP : BOOT.list;
            /* 繁体模式（学员端）：课程内容转繁体展示，不改数据库 */
            if (curLang() === 'tw' && !BOOT.isAdmin) {
                allData = allData.map(twCourse);
                if (BOOT.list && BOOT.list.length) BOOT.list = BOOT.list.map(twCourse);
            }
            try {
                var cj = await catP;
                catRows = Array.isArray(cj) ? cj : [];
                catInfo = {};
                catRows.forEach(function(s) {
                    var sd = {}, sdI18n = {};
                    (s.subs || []).forEach(function(x) { sd[x.name] = x.description || ""; if (x.i18n) sdI18n[x.name] = x.i18n; });
                    catInfo[s.name] = { description: s.description || "", subDesc: sd, i18n: s.i18n || null, subI18n: sdI18n };
                });
                if (curLang() === 'tw' && !BOOT.isAdmin) {
                    var _ci2 = {};
                    Object.keys(catInfo).forEach(function(k) {
                        var ci = catInfo[k];
                        if (ci.description) ci.description = toTW(ci.description);
                        Object.keys(ci.subDesc || {}).forEach(function(sk) { ci.subDesc[sk] = toTW(ci.subDesc[sk] || ''); });
                        _ci2[toTW(k)] = ci;
                    });
                    catInfo = _ci2;
                }
            } catch (e) {}
            var list = (BOOT.list && BOOT.list.length) ? BOOT.list : (BOOT.shareMode ? [] : allData);
            renderSections(list);
            try { if (!BOOT.isAdmin && typeof renderPathsPage === 'function') renderPathsPage(); } catch (e) {}
            showHomeView(BOOT.isAdmin ? 'catalog' : 'paths');
            updateStats();
            if (!BOOT.isAdmin) {
                refreshStats();
            } else {
                var gate = document.getElementById('adminGate');
                if (gate && (BOOT.adminAuthed || sessionStorage.getItem('TQ_ADMIN_OK') === '1')) gate.style.display = 'none';
                var nrt = await fetch('/api/notice').then(function(x){ return x.json(); }).catch(function(){ return {}; });
                var nt = document.getElementById('noticeText');
                if (nt && nrt.notice) nt.value = nrt.notice;
                renderCatList();
                renderCatForm();
                try { if (typeof renderPathAdminList === 'function') renderPathAdminList(); } catch (e) {}
                try { if (typeof renderAdminStatsSection === 'function') renderAdminStatsSection(); } catch (e) {}
                try { if (typeof renderAdminClassesSection === 'function') renderAdminClassesSection(); } catch (e) {}
            }
            var sid = new URLSearchParams(window.location.search).get('id');
            if (!sid) {
                var pm = window.location.pathname.match(/^\\/(ID-[A-Za-z0-9_-]+)$/);
                if (pm) sid = pm[1];
            }
            if (sid && allData.length > 0) startLesson(sid);
            if (!sid) {
                var _qs = new URLSearchParams(window.location.search);
                var _qSeries = _qs.get('series'), _qSub = _qs.get('sub'), _qPath = _qs.get('path');
                if (_qPath) setTimeout(function() { if (typeof renderPathDetail === 'function') renderPathDetail(_qPath); }, 350);
                else if (_qSeries && allData.length > 0) setTimeout(function() { jumpToSeries(_qSeries, _qSub); }, 350);
            }
            try { var _w = sessionStorage.getItem('TQ_WELCOME'); if (_w) { sessionStorage.removeItem('TQ_WELCOME'); showWelcomeToast(_w); } } catch (e) {}
            applyI18n();
        }
        window.onload = load;

        /* 状态徽标 */
        function statusBadge(id) {
            var p = getMyProg()[id] || {};
            if (p.completed)
                return '<span class="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-full"><span class="w-3.5 h-3.5 rounded-full border-2 border-emerald-500 flex items-center justify-center text-[9px]">✓</span>' + tr("stDone") + '</span>';
            if (p.started)
                return '<span class="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full"><span class="w-3.5 h-3.5 rounded-full border-2 border-amber-500"></span>' + tr("stDoing") + '</span>';
            return '<span class="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 bg-slate-100 px-3 py-1.5 rounded-full"><span class="w-3.5 h-3.5 rounded-full border-2 border-slate-300"></span>' + tr("stNot") + '</span>';
        }

        /* 课程卡片（新 UI） */
        function courseCard(c, idx) {
            if (!BOOT.isAdmin) c = i18nCourse(c);
            var desc = stripMd(c.content).slice(0, 44) + "…";
            var shareBtn = '<button data-id="' + c.id + '" onclick="copyShareLink(this.dataset.id)" title="' + tr("copyLinkT") + '" class="text-slate-300 hover:text-violet-600 transition">🔗</button>';
            var adminBtns = "";
            if (BOOT.isAdmin) {
                adminBtns = '<button data-id="' + c.id + '" onclick="editCourse(this.dataset.id)" title="编辑" class="admin-only text-slate-300 hover:text-violet-600 transition">🖊️</button>'
                    + '<button data-id="' + c.id + '" data-dir="up" onclick="moveCourse(this.dataset.id,this.dataset.dir)" title="上移" class="text-slate-300 hover:text-violet-600 transition">⬆️</button>'
                    + '<button data-id="' + c.id + '" data-dir="down" onclick="moveCourse(this.dataset.id,this.dataset.dir)" title="下移" class="text-slate-300 hover:text-violet-600 transition">⬇️</button>'
                    + '<button data-id="' + c.id + '" onclick="exportCourse(this.dataset.id)" title="导出HTML（手机电脑可打开）" class="text-slate-300 hover:text-emerald-600 transition">📥</button>'
                    + '<button data-id="' + c.id + '" onclick="deleteCourse(this.dataset.id)" title="删除" class="admin-only text-slate-300 hover:text-red-500 transition">🗑️</button>';
            }
            var cardBtns = '<div class="flex items-center gap-3 text-[15px]">' + shareBtn + adminBtns + '</div>';
            var videoBadge = parseVideoUrls(c.video_url).length ? ' <span class="video-badge text-[11px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full align-middle">' + tr("videoBadge") + '</span>' : '';
            var goText = tr("startLearning");
            return '<div class="course-card bg-white rounded-[1.75rem] border border-slate-100 shadow-sm p-6 flex flex-col gap-4 hover:shadow-lg hover:-translate-y-0.5 transition"'
                + ' data-search="' + esc(c.title + " " + c.content + " " + (c.subcategory || "")).toLowerCase() + '"'
                + ' style="animation-delay:' + Math.min(idx * 40, 600) + 'ms">'
                + '<div class="flex items-center justify-between"><div class="flex items-center gap-2">' + (BOOT.isAdmin ? '<input type="checkbox" class="exp-check w-4 h-4 accent-violet-600" data-id="' + c.id + '" title="勾选后可批量导出">' : '') + statusBadge(c.id) + '</div>' + cardBtns + '</div>'
                + '<div><h3 class="font-bold text-[1.05rem] text-slate-900 leading-snug">' + hlVerse(esc(c.title)) + videoBadge + '</h3>'
                + '<p class="text-sm text-slate-400 mt-2 leading-relaxed line-clamp-2">' + hlVerse(esc(desc)) + '</p></div>'
                + '<button data-id="' + c.id + '" onclick="startLesson(this.dataset.id)" onmouseenter="prefetchCourse(this.dataset.id)" ontouchstart="prefetchCourse(this.dataset.id)" class="mt-auto w-full bg-gradient-to-r from-violet-600 to-indigo-600 text-white py-3.5 rounded-2xl font-bold shadow-lg shadow-violet-200 hover:shadow-xl hover:opacity-95 active:scale-[.99] transition flex items-center justify-center gap-2">' + goText + ' <span aria-hidden="true">→</span></button>'
                + '</div>';
        }

        /* 系列→子栏目 树状结构：点击可展开/折叠，状态存浏览器本地 */
        var TREE_KEY = "TQ_TREE_V1";
        function getTreeState() { try { return JSON.parse(localStorage.getItem(TREE_KEY) || "{}"); } catch(e) { return {}; } }
        function setTreeState(s) { try { localStorage.setItem(TREE_KEY, JSON.stringify(s)); } catch(e) {} }
        function toggleTree(btn) {
            var key = btn.getAttribute("data-tkey");
            var body = document.getElementById(btn.getAttribute("data-tbody"));
            var chev = document.getElementById(btn.getAttribute("data-tchev"));
            if (!body) return;
            var hidden = body.classList.toggle("hidden");
            if (chev) chev.innerText = hidden ? "▶" : "▼";
            var st = getTreeState();
            if (hidden) st[key] = 1; else delete st[key];
            setTreeState(st);
        }
        /* 首页视图切换：paths（学习路径入口，默认）/ catalog（全部课程目录） */
        function showHomeView(v) {
            var toCatalog = (v === 'catalog');
            var pr = document.getElementById('pathsRoot');
            var cw = document.getElementById('catalogWrap');
            if (pr) pr.style.display = toCatalog ? 'none' : '';
            if (cw) cw.style.display = toCatalog ? '' : 'none';
            if (toCatalog) { try { window.scrollTo(0, 0); } catch (e) {} }
        }
        function toggleHomeView() {
            var cw = document.getElementById('catalogWrap');
            showHomeView(cw && cw.style.display !== 'none' ? 'paths' : 'catalog');
        }
        /* 按栏目渲染分区（树状可折叠） */
        function renderSections(list) {
            var wrap = document.getElementById('courseSections');
            document.getElementById('loadingState').classList.add('hidden');
            var st = getTreeState();
            var groups = {};
            list.forEach(function(c) { (groups[c.category] = groups[c.category] || []).push(c); });
            var html = "";
            var si = 0;
            Object.keys(groups).forEach(function(cat) {
                si++;
                var info = catInfo[cat] || { description: "", subDesc: {} };
                /* 系列内按子栏目二次分组（无子栏目的课程直接列在系列下） */
                var subgroups = {}, subOrder = [];
                groups[cat].forEach(function(c) {
                    var sk = c.subcategory || "";
                    if (!subgroups[sk]) { subgroups[sk] = []; subOrder.push(sk); }
                    subgroups[sk].push(c);
                });
                var sKey = "ser:" + cat, sBody = "treeBodyS" + si, sChev = "treeChevS" + si;
                var sCollapsed = !!st[sKey];
                var bodyHtml = "";
                var ki = 0;
                subOrder.forEach(function(sk) {
                    ki++;
                    var cards = subgroups[sk].map(function(c, idx) { return courseCard(c, idx); }).join('');
                    var gridHtml = '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-8 course-cards">' + cards + '</div>';
                    if (sk) {
                        var sd = info.subDesc[sk] || "";
                        var kKey = "sub:" + cat + "::" + sk, kBody = "treeBodyS" + si + "K" + ki, kChev = "treeChevS" + si + "K" + ki;
                        var kCollapsed = !!st[kKey];
                        bodyHtml += '<div class="ml-1 md:ml-5 mt-7">'
                            + '<div class="flex items-center gap-1 mb-3">'
                            + '<button data-tkey="' + esc(kKey) + '" data-tbody="' + kBody + '" data-tchev="' + kChev + '" onclick="toggleTree(this)" class="flex items-center gap-1 group min-w-0">'
                            + '<span id="' + kChev + '" class="text-xs text-violet-500 w-4 text-center shrink-0">' + (kCollapsed ? "▶" : "▼") + '</span>'
                            + '<span class="text-[15px] font-bold text-slate-700 group-hover:text-violet-700">📁' + hlSubcat(subNameL(cat, sk)) + '</span>'
                            + '<span class="text-xs text-slate-400 shrink-0">' + tf("nLessons", { n: subgroups[sk].length }) + '</span></button>'
                            + '<span class="flex items-center gap-2.5 shrink-0 ml-1">'
                            + '<button data-cat="' + esc(cat) + '" data-sub="' + esc(sk) + '" onclick="copySubLink(this.dataset.cat,this.dataset.sub)" title="' + tr("copyLinkT") + '" class="text-slate-300 hover:text-violet-600 transition text-[13px]">🔗</button>'
                            + (BOOT.isAdmin ? '<button data-cat="' + esc(cat) + '" data-sub="' + esc(sk) + '" onclick="exportSub(this.dataset.cat,this.dataset.sub)" title="导出本子栏目全部课件" class="text-slate-300 hover:text-emerald-600 transition text-[13px]">📥</button>' : '')
                            + '</span></div>'
                            + (subDescL(cat, sk) ? '<p class="text-xs text-slate-500 mb-3 ml-6 leading-relaxed">' + hlVerse(esc(stripMd(subDescL(cat, sk)))) + '</p>' : '')
                            + '<div id="' + kBody + '" class="' + (kCollapsed ? "hidden" : "") + '">' + gridHtml + '</div></div>';
                    } else {
                        bodyHtml += gridHtml;
                    }
                });
                html += '<div class="mb-6">'
                    + '<div class="flex items-center gap-1">'
                    + '<button data-tkey="' + esc(sKey) + '" data-tbody="' + sBody + '" data-tchev="' + sChev + '" onclick="toggleTree(this)" class="flex items-center gap-3 flex-1 min-w-0 text-left group">'
                    + '<span id="' + sChev + '" class="text-sm text-violet-500 w-5 text-center shrink-0">' + (sCollapsed ? "▶" : "▼") + '</span>'
                    + '<span class="w-1.5 h-7 bg-violet-500 rounded-full shrink-0"></span>'
                    + '<h2 class="text-xl font-black tracking-tight group-hover:text-violet-700">' + catIcon(cat) + ' ' + esc(catNameL(cat)) + '</h2>'
                    + '<span class="text-sm text-slate-400 shrink-0">' + tf("nLessons", { n: groups[cat].length }) + '</span></button>'
                    + '<span class="flex items-center gap-2.5 shrink-0 pr-1">'
                    + '<button data-cat="' + esc(cat) + '" onclick="copySeriesLink(this.dataset.cat)" title="' + tr("copyLinkT") + '" class="text-slate-300 hover:text-violet-600 transition text-[15px]">🔗</button>'
                    + (BOOT.isAdmin ? '<button data-cat="' + esc(cat) + '" onclick="exportSeries(this.dataset.cat)" title="导出本系列全部课件" class="text-slate-300 hover:text-emerald-600 transition text-[15px]">📥</button>' : '')
                    + '</span></div>'
                    + (catDescL(cat) ? '<p class="text-sm text-slate-500 mt-2 ml-[52px] leading-relaxed">' + hlVerse(esc(stripMd(catDescL(cat)))) + '</p>' : '')
                    + '<div id="' + sBody + '" class="' + (sCollapsed ? "hidden" : "") + ' mt-2">' + bodyHtml + '</div></div>';
            });
            wrap.innerHTML = html;
            filterCourses();
        }

        /* 统计卡片（本地进度） */
        function updateStats() {
            if (!document.getElementById('statTotal')) return;
            var prog = getMyProg();
            var done = 0, doing = 0, sum = 0, n = 0;
            allData.forEach(function(c) {
                var p = prog[c.id];
                if (!p) return;
                if (p.completed) { done++; if (p.total > 0) { sum += p.score / p.total; n++; } }
                else if (p.started) doing++;
            });
            document.getElementById('statTotal').innerText = allData.length;
            document.getElementById('statDone').innerText = done;
            document.getElementById('statDoing').innerText = doing;
            document.getElementById('statAvg').innerText = n > 0 ? Math.round(sum / n * 100) + "" : "--";
        }

        /* 用服务端成绩刷新统计 + 我的成绩 */
        async function refreshStats() {
            var name = progName();
            if (!name || !document.getElementById('statTotal')) return;
            try {
                var r = await fetch('/api/scores?username=' + encodeURIComponent(name));
                var j = await r.json();
                var rows = j.scores || [];
                var titleToId = {};
                allData.forEach(function(c) { titleToId[c.title] = c.id; if (c.title) titleToId[c.title.trim()] = c.id; });
                var doneIds = {}, sum = 0, n = 0;
                rows.forEach(function(s) {
                    var title = (s.course_title || s.course_id || "").trim();
                    var id = titleToId[title] || s.course_id;
                    var mm = String(s.score || "").match(/(\\\d+)\\\s*\\\/\\\s*(\\\d+)/);
                    if (mm && +mm[2] > 0 && allData.some(function(c){ return c.id === id; })) {
                        doneIds[id] = true; sum += (+mm[1]) / (+mm[2]); n++;
                    }
                });
                var done = Object.keys(doneIds).length;
                var prog = getMyProg(), doing = 0;
                allData.forEach(function(c) {
                    var p = prog[c.id];
                    if (p && p.started && !p.completed && !doneIds[c.id]) doing++;
                });
                document.getElementById('statDone').innerText = done;
                document.getElementById('statDoing').innerText = doing;
                document.getElementById('statAvg').innerText = n > 0 ? Math.round(sum / n * 100) + "" : "--";
                renderMyScores(rows, n > 0 ? Math.round(sum / n * 100) : null);
            } catch (e) {}
        }
        function renderMyScores(rows, avg) {
            var card = document.getElementById('myScoresCard');
            if (!card) return;
            if (!rows.length) { card.classList.add('hidden'); return; }
            card.classList.remove('hidden');
            document.getElementById('myScoresAvg').innerText = tf("scoreSummary", { n: rows.length }) + (avg != null ? tf("scoreAvg", { a: avg }) : '');
            document.getElementById('myScoresList').innerHTML = rows.map(function(s) {
                return '<li class="flex items-center justify-between text-sm border-b border-slate-50 pb-2">'
                    + '<span class="text-slate-600">' + esc(s.course_title || s.course_id) + '</span>'
                    + '<span class="text-slate-400 text-xs">' + esc(fmtTime(s.submitted_at)) + '</span>'
                    + '<span class="text-indigo-600 font-bold">' + esc(s.score) + '</span></li>';
            }).join('');
        }

        /* 搜索过滤 */
        var _filterT = null;
        function debouncedFilter() { clearTimeout(_filterT); _filterT = setTimeout(filterCourses, 150); }
        function filterCourses() {
            var kw = document.getElementById('searchInput').value.trim().toLowerCase();
            if (kw) { try { showHomeView('catalog'); } catch (e) {} }
            var visible = 0;
            document.querySelectorAll('.course-card').forEach(function(card) {
                var hit = !kw || card.dataset.search.indexOf(kw) >= 0;
                card.classList.toggle('hidden', !hit);
                if (hit) visible++;
            });
            document.getElementById('emptyState').classList.toggle('hidden', visible > 0);
            /* 找课件：有关键词时自动展开整棵树；清空后恢复折叠状态 */
            var bodies = document.querySelectorAll('[id^="treeBodyS"]');
            if (kw) {
                bodies.forEach(function(b) { b.classList.remove('hidden'); });
                document.querySelectorAll('[id^="treeChevS"]').forEach(function(c) { c.innerText = '▼'; });
            } else {
                var st = getTreeState();
                bodies.forEach(function(b) {
                    var btn = document.querySelector('[data-tbody="' + b.id + '"]');
                    var key = btn ? btn.getAttribute('data-tkey') : '';
                    var hidden = !!st[key];
                    b.classList.toggle('hidden', hidden);
                    var chev = btn ? document.getElementById(btn.getAttribute('data-tchev')) : null;
                    if (chev) chev.innerText = hidden ? '▶' : '▼';
                });
            }
        }

        function switchEmTab(which) {
            var isMobile = window.innerWidth < 768;
            var info = document.getElementById('emPaneInfo');
            var quiz = document.getElementById('emPaneQuiz');
            var tInfo = document.getElementById('emTabInfo');
            var tQuiz = document.getElementById('emTabQuiz');
            if (!isMobile) return;
            if (which === 'quiz') {
                info.classList.add('hidden'); quiz.classList.remove('hidden'); quiz.classList.add('flex');
                tQuiz.classList.add('bg-white', 'shadow'); tInfo.classList.remove('bg-white', 'shadow');
            } else {
                quiz.classList.add('hidden'); quiz.classList.remove('flex'); info.classList.remove('hidden');
                tInfo.classList.add('bg-white', 'shadow'); tQuiz.classList.remove('bg-white', 'shadow');
            }
        }
        var previewMode = false;
        function togglePreview() {
            previewMode = !previewMode;
            document.body.classList.toggle('preview-mode', previewMode);
            document.getElementById('previewBtn').textContent = previewMode ? '⚙️ 回到管理' : '👁️ 学员预览';
            // 重新渲染课程卡片以隐藏/显示管理按钮
            if (typeof renderHome === 'function') renderHome();
        }
        function toggleModal(id) {
            var el = document.getElementById(id);
            el.classList.toggle('hidden');
            if (id === 'lessonModal') {
                try { document.body.style.overflow = el.classList.contains('hidden') ? '' : 'hidden'; } catch (e) {}
            }
        }
        function closeLessonModal() {
            document.getElementById('lessonModal').classList.add('hidden');
            try { document.body.style.overflow = ''; } catch (e) {}
        }
        function closeAuthModal() { try { document.getElementById('authModal').style.display = 'none'; } catch (e) {} }
        function login() { openAuthModal('login', null, true); }
        /* 姓名按钮：未登记则登录，已登记则确认后登出（本地错题本按姓名保留） */
        function syncNameBtn() {
            var nm = "";
            try { nm = progName(); } catch (e) {}
            var nb = document.getElementById("nameBtn");
            if (nb) nb.innerText = nm || tr("setName");
        }
        function nameBtnClick() {
            var nm = "";
            try { nm = progName(); } catch (e) {}
            if (!nm) { login(); return; }
            if (confirm(tf("logoutAsk", { name: nm }))) {
                try { localStorage.removeItem(USER_KEY); localStorage.removeItem(STUDENT_TOKEN_KEY); localStorage.removeItem(STUDENT_ADMIN_KEY); } catch (e) {}
                location.reload();
            }
        }
        /* 答题前必须输入姓名：无姓名时弹窗阻断，登记后继续 */
        function requireNameForQuiz(tab) {
            var nm = "";
            try { nm = progName(); } catch (e) {}
            if (nm) return true;
            openAuthModal('login', tab, false);
            try {
                var d = document.getElementById('authDesc');
                if (d) d.textContent = tr("loginNeedQuiz");
            } catch (e) {}
            return false;
        }
        var STUDENT_TOKEN_KEY = "TQ_STUDENT_TOKEN_V1";
        var STUDENT_ADMIN_KEY = "TQ_STUDENT_ADMIN_V1";
        function studentToken() { try { return localStorage.getItem(STUDENT_TOKEN_KEY) || ""; } catch (e) { return ""; } }
        function studentIsAdmin() { try { return !!(progName()) && localStorage.getItem(STUDENT_ADMIN_KEY) === "1"; } catch (e) { return false; } }
        function canViewAnswers() { return BOOT.isAdmin || studentIsAdmin(); }
        async function refreshStudentAdmin() {
            if (BOOT.isAdmin || !progName() || !studentToken()) return;
            try {
                var r = await fetch("/api/student/me?username=" + encodeURIComponent(progName()) + "&token=" + encodeURIComponent(studentToken()));
                if (!r.ok) return;
                var j = await r.json();
                try { localStorage.setItem(STUDENT_ADMIN_KEY, j.is_admin ? "1" : "0"); } catch (e) {}
            } catch (e) {}
        }
        /* 学员登录/注册弹窗（姓名+密码）。pendingTab: 登录后要去的题签；reloadAfter: 登录后刷新页面 */
        function openAuthModal(mode, pendingTab, reloadAfter) {
            window._pendingQTab = (pendingTab === undefined || pendingTab === null) ? null : pendingTab;
            window._authReload = !!reloadAfter;
            var m = document.getElementById('authModal');
            if (!m) {
                m = document.createElement('div');
                m.id = 'authModal';
                m.style.cssText = 'position:fixed;inset:0;z-index:130;display:none;align-items:center;justify-content:center;padding:16px;';
                var inp = 'style="width:100%;border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;font-size:14px;outline:none;margin-bottom:10px;box-sizing:border-box"';
                m.innerHTML = '<div style="position:absolute;inset:0;background:rgba(15,23,42,.6)"></div>'
                    + '<div style="position:relative;background:#fff;border-radius:24px;padding:24px;width:100%;max-width:340px;box-shadow:0 25px 50px rgba(0,0,0,.25)">'
                    + '<button onclick="closeAuthModal()" style="position:absolute;top:12px;right:14px;background:none;border:none;font-size:20px;color:#94a3b8;cursor:pointer;line-height:1">×</button>'
                    + '<h3 id="authTitle" style="font-weight:800;color:#1e293b;margin:0 0 6px;font-size:17px">' + tr("loginT") + '</h3>'
                    + '<p id="authDesc" style="font-size:12px;color:#94a3b8;margin:0 0 14px">' + tr("loginD") + '</p>'
                    + '<input id="authName" placeholder="' + tr("namePh") + '" ' + inp + '>'
                    + '<input id="authPw" type="password" placeholder="' + tr("pwPh") + '" ' + inp + '>'
                    + '<input id="authPw2" type="password" placeholder="' + tr("pw2Ph") + '" ' + inp + ' style="display:none;width:100%;border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;font-size:14px;outline:none;margin-bottom:10px;box-sizing:border-box">'
                    + '<div id="authErr" style="display:none;color:#dc2626;font-size:12px;margin-bottom:10px"></div>'
                    + '<button id="authOk" onclick="submitAuth()" style="width:100%;background:#4f46e5;color:#fff;border:none;border-radius:12px;padding:11px;font-size:14px;font-weight:700;margin-bottom:8px">' + tr("doLogin") + '</button>'
                    + '<button id="authSwitch" onclick="toggleAuthMode()" style="width:100%;background:none;border:none;color:#4f46e5;font-size:12px;padding:6px">' + tr("goReg") + '</button>'
                    + '<p style="font-size:11px;color:#94a3b8;margin:6px 0 0">' + tr("forgotPw") + '</p>'
                    + '</div>';
                document.body.appendChild(m);
                ['authName','authPw','authPw2'].forEach(function(id) {
                    var el = document.getElementById(id);
                    if (el) el.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') submitAuth(); });
                });
            }
            setAuthMode(mode === 'register' ? 'register' : 'login');
            var nm = document.getElementById('authName');
            if (nm && !nm.value) { try { nm.value = progName(); } catch (e) {} }
            m.style.display = 'flex';
            setTimeout(function() { var el = document.getElementById(window._authMode === 'login' ? 'authPw' : 'authName'); if (el) el.focus(); }, 60);
        }
        function setAuthMode(mode) {
            window._authMode = mode;
            var isReg = (mode === 'register');
            document.getElementById('authTitle').innerText = isReg ? tr("regT") : tr("loginT");
            document.getElementById('authDesc').innerText = isReg ? tr("regD") : tr("loginD");
            document.getElementById('authOk').innerText = isReg ? tr("doReg") : tr("doLogin");
            document.getElementById('authSwitch').innerText = isReg ? tr("goLogin") : tr("goReg");
            document.getElementById('authPw2').style.display = isReg ? '' : 'none';
            hideAuthErr();
        }
        function toggleAuthMode() { setAuthMode(window._authMode === 'register' ? 'login' : 'register'); }
        function showAuthErr(msg) { var e = document.getElementById('authErr'); if (e) { e.innerText = msg; e.style.display = ''; } }
        function hideAuthErr() { var e = document.getElementById('authErr'); if (e) e.style.display = 'none'; }
        async function submitAuth() {
            var name = (document.getElementById('authName').value || "").trim();
            var pw = document.getElementById('authPw').value || "";
            var mode = window._authMode || 'login';
            if (!name) { showAuthErr(tr("errName")); return; }
            if (pw.length < 4) { showAuthErr(tr("errPw")); return; }
            if (mode === 'register') {
                var pw2 = document.getElementById('authPw2').value || "";
                if (pw !== pw2) { showAuthErr(tr("errPw2")); return; }
            }
            var btn = document.getElementById('authOk');
            btn.disabled = true; btn.innerText = tr("doing");
            try {
                var r = await fetch('/api/student/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: pw, mode: mode }) });
                var j = await r.json();
                if (!j.success) { showAuthErr(j.error || tr("opFail")); return; }
                try { localStorage.setItem(USER_KEY, name); localStorage.setItem(STUDENT_TOKEN_KEY, j.token || ""); localStorage.setItem(STUDENT_ADMIN_KEY, j.is_admin ? "1" : "0"); } catch (e) {}
                document.getElementById('authPw').value = '';
                document.getElementById('authPw2').value = '';
                document.getElementById('authModal').style.display = 'none';
                if (window._authReload) { window._authReload = false; try { sessionStorage.setItem('TQ_WELCOME', name); } catch (e) {} location.reload(); return; }
                syncNameBtn();
                showWelcomeToast(name);
                var snb = document.getElementById("shareNameBox"); if (snb) snb.innerHTML = shareNameHTML();
                if (activeLessonId) { var _pg = getMyProg(); if (!_pg[activeLessonId] || !_pg[activeLessonId].completed) { _pg[activeLessonId] = { started: true, completed: false }; setMyProg(_pg); } }
                var t = window._pendingQTab; window._pendingQTab = null;
                if (t) switchQTab(t);
            } catch (e) {
                showAuthErr(tr("netErr"));
            } finally {
                btn.disabled = false;
                setAuthMode(window._authMode || 'login');
            }
        }
        function openShareAuth() { openAuthModal('login', null, false); }
        /* 登录成功欢迎动画：全屏遮罩 + 渐入弹跳卡片，自动消失，可点击提前关闭 */
        function showWelcomeToast(name) {
            var old = document.getElementById('welcomeToast');
            if (old) old.remove();
            var st = document.getElementById('welcomeToastStyle');
            if (!st) {
                st = document.createElement('style');
                st.id = 'welcomeToastStyle';
                st.textContent = '@keyframes tqWelcomeIn{0%{opacity:0;transform:scale(.8) translateY(24px)}60%{opacity:1;transform:scale(1.05) translateY(0)}100%{opacity:1;transform:scale(1) translateY(0)}}'
                    + '@keyframes tqWelcomeGlow{0%,100%{box-shadow:0 0 24px rgba(139,92,246,.45)}50%{box-shadow:0 0 48px rgba(139,92,246,.8)}}'
                    + '@keyframes tqWelcomeFade{to{opacity:0;visibility:hidden}}';
                document.head.appendChild(st);
            }
            var div = document.createElement('div');
            div.id = 'welcomeToast';
            div.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(15,10,40,.45);backdrop-filter:blur(4px);animation:tqWelcomeFade .4s ease 2.6s forwards;cursor:pointer';
            div.innerHTML = '<div style="text-align:center;padding:36px 52px;background:linear-gradient(135deg,#7c3aed,#4f46e5);border-radius:24px;color:#fff;animation:tqWelcomeIn .55s cubic-bezier(.2,1.4,.4,1),tqWelcomeGlow 2s ease-in-out infinite;max-width:86vw">'
                + '<div style="font-size:46px;margin-bottom:12px">🎉</div>'
                + '<div style="font-size:22px;font-weight:800;margin-bottom:8px">' + tf("welcome", { name: esc(name) }) + '</div></div>';
            div.onclick = function() { div.remove(); };
            setTimeout(function() { if (div.parentNode) div.remove(); }, 3100);
            document.body.appendChild(div);
        }
        /* 分享页姓名条：与主站共用同一本地姓名，成绩自动记在其名下 */
        function shareNameHTML() {
            var sn0 = progName();
            if (sn0) return '<span class="text-slate-600">' + tr("studentIs") + '<b class="text-slate-800">' + esc(sn0) + '</b></span>'
                + '<button onclick="shareRename()" class="text-xs text-violet-600 underline">' + tr("changeBtn") + '</button>';
            return '<button onclick="openShareAuth()" class="text-xs bg-violet-600 text-white px-3 py-1.5 rounded-xl font-bold">' + tr("loginReg") + '</button>';
        }
        function shareRename() {
            try { localStorage.removeItem(USER_KEY); localStorage.removeItem(STUDENT_TOKEN_KEY); localStorage.removeItem(STUDENT_ADMIN_KEY); } catch(e) {}
            document.getElementById("shareNameBox").innerHTML = shareNameHTML();
            var nb = document.getElementById("nameBtn"); if (nb) nb.innerText = tr("setName");
        }

        function copyShareLink(id) {
            var url = window.location.origin + "/" + id;
            navigator.clipboard.writeText(url).then(function() { alert(tr("linkCopied")); });
        }
        /* 系列/子栏目分享：与单个课件一致的复制链接规则 */
        function copyPathLink(pid) {
            var url = window.location.origin + "/?path=" + encodeURIComponent(pid);
            navigator.clipboard.writeText(url).then(function() { alert(tr("linkCopied")); });
        }
        function copySeriesLink(cat) {
            var url = window.location.origin + "/?series=" + encodeURIComponent(cat);
            navigator.clipboard.writeText(url).then(function() { alert(tr("linkCopied")); });
        }
        function copySubLink(cat, sub) {
            var url = window.location.origin + "/?series=" + encodeURIComponent(cat) + "&sub=" + encodeURIComponent(sub);
            navigator.clipboard.writeText(url).then(function() { alert(tr("linkCopied")); });
        }
        /* 系列/子栏目导出：与单个课件一致的六格式导出规则（批量逐个下载） */
        function exportSeries(cat) {
            var ids = (allData || []).filter(function(c) { return c.category === cat; }).map(function(c) { return c.id; });
            if (!ids.length) { alert('该系列下暂无课件'); return; }
            openExportMenu(ids, '系列：' + cat + '（' + ids.length + '个课件）');
        }
        function exportSub(cat, sub) {
            var ids = (allData || []).filter(function(c) { return c.category === cat && (c.subcategory || '') === sub; }).map(function(c) { return c.id; });
            if (!ids.length) { alert('该子栏目下暂无课件'); return; }
            openExportMenu(ids, '子栏目：' + sub + '（' + ids.length + '个课件）');
        }
        /* 分享链接打开：展开对应系列/子栏目并滚动定位 */
        function jumpToSeries(cat, sub) {
            if (!cat) return;
            try { showHomeView('catalog'); } catch (e) {}
            try {
                var st = getTreeState();
                delete st["ser:" + cat];
                if (sub) delete st["sub:" + cat + "::" + sub];
                setTreeState(st);
            } catch (e) {}
            var list = (BOOT.list && BOOT.list.length) ? BOOT.list : allData;
            renderSections(list);
            var groups = {};
            list.forEach(function(c) { (groups[c.category] = groups[c.category] || []).push(c); });
            var cats = Object.keys(groups), si = cats.indexOf(cat);
            if (si < 0) return;
            var targetId = "treeBodyS" + (si + 1);
            if (sub) {
                var subOrder = [], ki = 0, found = -1, i;
                groups[cat].forEach(function(c) {
                    var sk = c.subcategory || "";
                    if (subOrder.indexOf(sk) < 0) subOrder.push(sk);
                });
                for (i = 0; i < subOrder.length; i++) {
                    ki++;
                    if (subOrder[i] === sub && subOrder[i]) { found = ki; break; }
                }
                if (found > 0) targetId = "treeBodyS" + (si + 1) + "K" + found;
            }
            setTimeout(function() {
                var el = document.getElementById(targetId);
                if (el) { el.classList.remove("hidden"); el.scrollIntoView({ behavior: "smooth", block: "start" }); }
            }, 150);
        }

        /* ===== 统一智能渲染：章节自动分组 + 题型自动识别（填空内嵌/问答文本框/单选药丸乱序/经文卡片）+ 填完核对 ===== */
        var studyRevealed = false;
        var lastGradeRes = null; /* 最近一次核对结果（成绩报告 Tab 用） */
        var SEP = String.fromCharCode(1); /* 多空格答案分隔符（与服务端 MBSEP 对应） */
        function studyInputHtml(qi, bi, w) {
            return '<input type="text" id="u-' + qi + '-' + bi + '" data-sq="' + qi + '" class="blank-input quiz-input" style="width:' + w + 'px">'
                + '<span class="answer-text" id="ans-' + qi + '-' + bi + '"></span>';
        }
        /* 把题目文本中的 ____（下划线越多空格越宽）替换为填空；无占位符则在末尾追加 */
        function studyPara(q, qi) {
            var bi = 0;
            var html = hlVerse(esc(q.q)).replace(/_{4,}|＿{2,}/g, function(m) {
                var w = Math.min(220, Math.max(80, m.length * 16));
                return studyInputHtml(qi, bi++, w);
            });
            if (bi === 0) html += ' ' + studyInputHtml(qi, bi++, 120);
            return html;
        }
        /* 智能识别题型并渲染：verse→经文卡片，single/judge→药丸选项（单选乱序），essay→大文本框，fill→段落内嵌填空 */
        function renderQ(q, i, num) {
            var verdict = '<div class="qverdict hidden mt-2 text-sm font-bold" id="verdict-' + i + '"></div>';
            if (q.type === 'verse') {
                var vq = Object.assign({}, q);
                vq.q = stripVerseTag(q.q);
                var bibleRef = stripEmoji(q.o || q.h || '');
                var bibleCard = '';
                if (curLang() === 'en' && bibleRef) {
                    bibleCard = '<details class="mt-3 bg-emerald-50/70 border border-emerald-100 rounded-xl">'
                        + '<summary class="text-xs font-bold text-emerald-700 px-3 py-2 cursor-pointer select-none">📖 <span class="bible-ver-label">' + getBibleVer() + '</span></summary>'
                        + '<div class="px-3 pb-3" data-bible-ref="' + esc(bibleRef) + '"></div></details>';
                }
                return '<div id="qcard-' + i + '" data-qnum="' + num + '"><div class="bg-blue-50 border-l-4 border-blue-400 p-6 rounded-r-lg">'
                    + ((q.h || q.o) ? '<p class="mb-3">' + hlVerse(esc(stripEmoji(q.h || q.o))) + '</p>' : '')
                    + '<div class="text-slate-800"><span class="verse-text">' + studyPara(vq, i) + '</span></div>' + bibleCard + verdict + '</div></div>';
            }
            if (q.type === 'single' || q.type === 'judge' || q.type === 'multiple') {
                var isMulti = q.type === 'multiple';
                var rawQ = q.q || '';
                if (isMulti) {
                    /* 题干末尾自带的"（多选）"去掉，统一只保留紫色徽章，避免重复显示 */
                    var mtags = ['（多选）', '(多选)'];
                    for (var mi = 0; mi < mtags.length; mi++) {
                        var mtg = mtags[mi], me = rawQ.length;
                        while (me > 0 && (rawQ.charAt(me - 1) === ' ' || rawQ.charAt(me - 1) === '　')) me--;
                        if (me >= mtg.length && rawQ.slice(me - mtg.length, me) === mtg) rawQ = rawQ.slice(0, me - mtg.length);
                    }
                }
                var opts = q.type === 'judge' ? ['√', '×'] : String(q.o || '').split(',');
                var pills = opts.map(function(o) {
                    var t = o.trim(); if (!t) return '';
                    var val = t.charAt(0);
                    return '<label class="sopt" data-val="' + esc(val) + '"><input type="' + (isMulti ? 'checkbox' : 'radio') + '" name="u-' + i + '" value="' + esc(val) + '" class="hidden"><span>' + esc(t) + '</span></label>';
                }).join('');
                return '<div id="qcard-' + i + '" data-qnum="' + num + '"><p>' + num + '. ' + hlVerse(esc(rawQ)) + (isMulti ? ' <span class="text-xs text-indigo-500 font-bold">' + tr("multiTag") + '</span>' : '') + '</p>'
                    + '<div class="flex flex-wrap gap-2 mt-3">' + pills + '</div>' + verdict + '</div>';
            }
            if (q.type === 'essay') {
                return '<div id="qcard-' + i + '" data-qnum="' + num + '"><p>' + num + '. ' + hlVerse(esc(q.q)) + '</p>'
                    + '<textarea id="u-' + i + '" class="quiz-input w-full p-4 border rounded-2xl bg-slate-50 h-28 mt-3" placeholder="' + tr("essayPh") + '"></textarea>' + verdict + '</div>';
            }
            return '<div id="qcard-' + i + '" data-qnum="' + num + '"><p>' + num + '. ' + studyPara(q, i) + '</p>' + verdict + '</div>';
        }
        /* 进度统计：填空按空格数，选择/问答按题数 */
        function studyProgress() {
            var total = 0, filled = 0;
            for (var v = 0; v < activeQuizzes.length; v++) {
                var qv = activeQuizzes[v];
                if (!renderedQTypes[qv.type]) continue;
                if (qv.type === 'single' || qv.type === 'judge' || qv.type === 'multiple') {
                    total++;
                    if (document.querySelector('input[name="u-' + v + '"]:checked')) filled++;
                } else {
                    var blanks = document.querySelectorAll('input[data-sq="' + v + '"]');
                    var ta = document.getElementById('u-' + v);
                    if (blanks.length) {
                        total += blanks.length;
                        blanks.forEach(function(el) { if (el.value.trim() !== '') filled++; });
                    } else if (ta) { /* 问答题文本框 */
                        total++;
                        if (ta.value.trim() !== '') filled++;
                    } else { total++; filled++; } /* 无空格的纯展示题自动算完成 */
                }
            }
            return { filled: filled, total: total };
        }
        /* 页头总题数（与 studyProgress 计数口径一致，无需 DOM） */
        function countUnits() {
            var total = 0;
            activeQuizzes.forEach(function(q) {
                if (q.type === 'single' || q.type === 'judge' || q.type === 'multiple') total++;
                else if (q.type === 'essay') total++;
                else {
                    var mm = String(q.q || '').match(/_{4,}|＿{2,}/g);
                    total += mm ? mm.length : 1;
                }
            });
            return total;
        }
        function updateStudyBar() {
            var bar = document.getElementById('progress-bar');
            if (!bar) return;
            var p = studyProgress();
            bar.innerText = tf("progFill", { a: p.filled, b: p.total });
            if (studyRevealed) return;
            var btn = document.getElementById('studySubmit'), hint = document.getElementById('studyHint');
            if (!btn || !hint) return;
            if (p.total > 0 && p.filled === p.total) {
                btn.disabled = false;
                hint.innerText = tr("fillDoneToast");
                hint.className = 'mt-4 text-emerald-600 text-sm italic';
            } else {
                btn.disabled = true;
                hint.innerText = tf("fillActive", { n: p.total });
                hint.className = 'mt-4 text-rose-500 text-sm italic';
            }
        }
        function studySubmitBtn() { if (studyRevealed) toggleStudyEdit(); else submitStudy(); }
        async function submitStudy() {
            renderAllQTypeTabs();
            if (BOOT.shareMode && !progName()) {
                alert(tr("needName"));
                var sni = document.getElementById("shareNameInput"); if (sni) sni.focus();
                return;
            }
            if (!progName()) { openAuthModal('login', null, false); return; }
            var answers = [], ok = true;
            for (var v = 0; v < activeQuizzes.length; v++) {
                var qv = activeQuizzes[v], u = '';
                if (qv.type === 'multiple') {
                    var sels = document.querySelectorAll('input[name="u-' + v + '"]:checked');
                    if (!sels.length) { ok = false; break; }
                    var mvals = [];
                    sels.forEach(function (s) { mvals.push(s.value); });
                    u = mvals.join(',');
                } else if (qv.type === 'single' || qv.type === 'judge') {
                    var sel = document.querySelector('input[name="u-' + v + '"]:checked');
                    if (!sel) { ok = false; break; }
                    u = sel.value;
                } else {
                    var blanks = document.querySelectorAll('input[data-sq="' + v + '"]');
                    if (blanks.length) {
                        var parts = [];
                        blanks.forEach(function(el) { parts.push(el.value.trim()); });
                        if (parts.some(function(x) { return x === ''; })) { ok = false; break; }
                        u = parts.join(SEP);
                    } else {
                        var ta2 = document.getElementById('u-' + v); /* 问答题文本框 */
                        u = ta2 ? ta2.value.trim() : '';
                        if (!u) { ok = false; break; }
                    }
                }
                answers.push({ i: v, u: u });
            }
            if (!ok) { alert(tr("notComplete")); return; }
            var btn = document.getElementById('studySubmit');
            btn.disabled = true; btn.innerText = tr("checking");
            var name = progName() || tr("wbAnon");
            try {
                var r = await fetch('/api/submit', {
                    method: 'POST',
                    body: JSON.stringify({ username: name, course_id: activeLessonId, courseTitle: activeCourseTitle, answers: answers, lang: curLang(), token: (function(){ try { return localStorage.getItem(STUDENT_TOKEN_KEY) || ""; } catch(e) { return ""; } })() })
                });
                var res = await r.json();
                if (!r.ok || !res.details) throw 0;
                renderStudyGraded(res);
            } catch (e) {
                alert(tr("checkFail"));
                btn.disabled = false; btn.innerText = tr("checkBtn");
            }
        }
        /* 按选项值取选项完整文字（用于答案对比显示） */
        function optTextByVal(card, vchr) {
            if (!card || !vchr) return vchr || "";
            var sp = null;
            try { sp = card.querySelector('.sopt[data-val="' + vchr + '"] span'); } catch(e) {}
            return sp ? sp.textContent : vchr;
        }
        function renderStudyGraded(res) {
            studyRevealed = true;
            lastGradeRes = res;
            var wrongs = [];
            res.details.forEach(function(d) {
                var q = activeQuizzes[d.i] || {};
                var groups = String(d.expected || '').split(/[|｜；]/).map(function(g) {
                    return String(g).split(/[\\/／、，,;\\\\或]/).map(function(x) { return x.trim(); }).filter(function(x) { return x !== ''; });
                }).filter(function(g) { return g.length > 0; });
                var parts = [];
                groups.forEach(function(g) { parts = parts.concat(g); });
                var card = document.getElementById('qcard-' + d.i);
                if (card) card.classList.add('show-answers');
                var blanks = document.querySelectorAll('input[data-sq="' + d.i + '"]');
                var uv = [];
                blanks.forEach(function(el, bi) {
                    uv.push(el.value.trim());
                    var ansEl = document.getElementById('ans-' + d.i + '-' + bi);
                    if (ansEl) ansEl.textContent = (groups[bi] ? groups[bi].join(' / ') : (groups[0] ? groups[0].join(' / ') : ''));
                });
                if ((q.type === 'single' || q.type === 'judge' || q.type === 'multiple') && d.expected) {
                    var sels2 = document.querySelectorAll('input[name="u-' + d.i + '"]:checked');
                    var expVals = {};
                    parts.forEach(function (pp) { var c0 = pp.trim().charAt(0); if (c0) expVals[c0] = 1; });
                    sels2.forEach(function (s) {
                        uv.push(s.value);
                        if (!expVals[s.value]) {
                            var wlab = s.closest ? s.closest('label.sopt') : null;
                            if (wlab) wlab.classList.add('sopt-wrong');
                        }
                    });
                    String(d.expected).split(/[、；;，,\\\\/|｜]/).forEach(function (p) {
                        var vchr = p.trim().charAt(0);
                        if (!vchr) return;
                        var okEl = card ? card.querySelector('.sopt[data-val="' + vchr + '"]') : null;
                        if (okEl) okEl.classList.add('sopt-ok');
                    });
                }
                var vEl = document.getElementById('verdict-' + d.i);
                if (vEl) {
                    vEl.classList.remove('hidden');
                    if (d.verdict === null) vEl.innerHTML = '<span class="text-amber-600">' + tr("vOpen") + '</span>';
                    else vEl.innerHTML = d.verdict ? '<span class="text-emerald-600">' + tr("vOk") + '</span>' : '<span class="text-red-500">' + tr("vNg") + '</span>';
                }
                /* 整理“你的答案 / 正确答案”文字（按题型） */
                var userAnsText = uv.join(' / '), correctText = d.expected || '';
                if (q.type === 'single' || q.type === 'judge' || q.type === 'multiple') {
                    userAnsText = uv.map(function(x) { return optTextByVal(card, x); }).join('、');
                    correctText = parts.map(function(p) { return optTextByVal(card, p.trim().charAt(0)); }).join('、');
                } else if (q.type === 'essay') {
                    var taEl = document.getElementById('u-' + d.i);
                    userAnsText = taEl ? taEl.value.trim() : '';
                } else if (blanks.length) {
                    correctText = groups.map(function(g) { return g.join(' / '); }).join('；');
                }
                if (q.type === 'essay' && d.expected && vEl) {
                    vEl.insertAdjacentHTML('afterend',
                        '<div class="qref-wrap mt-2"><button onclick="toggleQRef(' + d.i + ')" class="text-xs font-bold text-indigo-600 hover:underline">' + tr("qrefToggle") + '</button>'
                        + '<div id="qref-' + d.i + '" class="hidden mt-2 text-sm rounded-xl bg-indigo-50 border border-indigo-100 p-3 text-slate-700 text-left">' + esc(d.expected) + '</div></div>');
                }
                if (d.verdict === false) {
                    if (vEl) vEl.insertAdjacentHTML('afterend',
                        '<div class="ans-compare mt-2 text-sm rounded-xl bg-red-50 border border-red-100 p-3 space-y-1 text-left">'
                        + '<div><span class="font-bold text-red-500">' + tr("yourAns") + '</span><span class="text-slate-700">' + esc(userAnsText || tr("wbNA")) + '</span></div>'
                        + '<div><span class="font-bold text-emerald-600">' + tr("rightAns") + '</span><span class="text-slate-700">' + esc(correctText || '') + '</span></div></div>');
                    var qn = card ? (card.getAttribute('data-qnum') || '') : '';
                    wrongs.push({ cid: activeLessonId, title: activeCourseTitle, series: activeCategory, sub: activeSubcategory, q: q.q || '', type: q.type || '', n: qn, u: userAnsText, expected: correctText, ts: Date.now() });
                }
            });
            if (wrongs.length) saveWrongs(wrongs);
            /* 答对的题从错题本移除 */
            try {
                var w2 = getWrong();
                var arr2 = w2[name] || [];
                var fixed = [];
                res.details.forEach(function(d) {
                    if (d.verdict === true) fixed.push({ cid: activeLessonId, q: d.q });
                });
                if (fixed.length && arr2.length) {
                    w2[name] = arr2.filter(function(x) {
                        return !fixed.some(function(f) { return f.cid === x.cid && f.q === x.q; });
                    });
                    setWrong(w2);
                }
            } catch (e) {}
            /* 错题同步到服务端，教师可在管理端查看（失败不影响本地） */
            try {
                if (name && name !== tr("wbAnon")) {
                    fetch('/api/wrongs/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: name, course_id: activeLessonId, courseTitle: activeCourseTitle, wrongs: wrongs,
                            token: (function(){ try { return localStorage.getItem(STUDENT_TOKEN_KEY) || ""; } catch(e) { return ""; } })() }) });
                }
            } catch (e) {}
            if (activeLessonId) {
                var prog = getMyProg();
                prog[activeLessonId] = { started: true, completed: true, score: res.score, total: res.gradable };
                setMyProg(prog);
            }
            var btn = document.getElementById('studySubmit'), hint = document.getElementById('studyHint');
            var p = studyProgress();
            if (btn) { btn.disabled = false; btn.innerText = tr("backEdit"); btn.classList.remove('bg-slate-800', 'hover:bg-slate-900'); btn.classList.add('bg-emerald-600', 'hover:bg-emerald-700'); }
            if (hint) { hint.innerText = tf("scoreDone", { s: res.score + ' / ' + res.gradable }); hint.className = 'mt-4 text-slate-500 text-sm'; }
            var bar = document.getElementById('progress-bar');
            if (bar) bar.innerText = tf("progFill", { a: p.total, b: p.total }) + tr("scoreUnit") + ' ' + res.score + ' / ' + res.gradable;
            if (!BOOT.isAdmin) refreshStats();
            var qc = document.getElementById('quizContainer');
            if (qc && qc.scrollIntoView) qc.scrollIntoView();
            updateQReport();
        }
        function toggleStudyEdit() {
            studyRevealed = false;
            document.querySelectorAll('#quizContainer .show-answers').forEach(function(el) { el.classList.remove('show-answers'); });
            document.querySelectorAll('#quizContainer .qverdict').forEach(function(el) { el.classList.add('hidden'); });
            document.querySelectorAll('#quizContainer .sopt-ok').forEach(function(el) { el.classList.remove('sopt-ok'); });
            document.querySelectorAll('#quizContainer .sopt-wrong').forEach(function(el) { el.classList.remove('sopt-wrong'); });
            document.querySelectorAll('#quizContainer .ans-compare').forEach(function(el) { el.remove(); });
            document.querySelectorAll('#quizContainer .qref-wrap').forEach(function(el) { el.remove(); });
            lastGradeRes = null;
            var btn = document.getElementById('studySubmit');
            if (btn) { btn.innerText = tr("checkBtn"); btn.classList.remove('bg-emerald-600', 'hover:bg-emerald-700'); btn.classList.add('bg-slate-800', 'hover:bg-slate-900'); }
            updateStudyBar();
            updateQReport();
        }

        /* 分 Tab 课件：页签切换 / 问答参考答案开关 / 成绩报告 */
        /* 题型页签懒加载：打开课件只渲染导读，点页签才渲染题目，大幅提速 */
        var curTypeTabs = [];
        var curHasSections = false;
        var renderedQTypes = {};
        function qCardWrapHTML(q, i, n) {
            return '<div class="bg-white rounded-xl p-5 shadow-sm border border-slate-200/80 text-slate-700 leading-relaxed">' + renderQ(q, i, n) + '</div>';
        }
        function buildTypeSecHTML(mt, ti) {
            var secHtml = '';
            var qnum = 0;
            if (curHasSections) {
                var secs = [], secMap = {};
                activeQuizzes.forEach(function (q) { var s = (q.s || '').trim() || tr("secDefault"); if (!secMap[s]) { secMap[s] = true; secs.push(s); } });
                secs.forEach(function (s, si) {
                    var inner = '';
                    activeQuizzes.forEach(function (q, i) {
                        if (q.type !== mt.t) return;
                        if (((q.s || '').trim() || tr("secDefault")) !== s) return;
                        if (q.type !== 'verse') { qnum++; }
                        inner += qCardWrapHTML(q, i, qnum);
                    });
                    if (inner) {
                        var badge = ('0' + (si + 1)).slice(-2);
                        secHtml += '<div class="mb-6"><h3 class="text-base font-bold text-slate-800 mb-3 flex items-center"><span class="bg-blue-600 text-white w-7 h-7 rounded-lg flex items-center justify-center mr-2 text-xs shrink-0">' + badge + '</span><span>' + esc(s) + '</span></h3><div class="space-y-4">' + inner + '</div></div>';
                    }
                });
            } else {
                var flat = '';
                activeQuizzes.forEach(function (q, i) {
                    if (q.type !== mt.t) return;
                    if (q.type !== 'verse') { qnum++; }
                    flat += qCardWrapHTML(q, i, qnum);
                });
                secHtml = '<div class="space-y-4">' + flat + '</div>';
            }
            var prevBtn = ti > 0
                ? '<button onclick="switchQTab(\\'' + curTypeTabs[ti - 1].t + '\\')" class="bg-white hover:bg-indigo-50 text-indigo-700 border border-indigo-200 px-4 py-2.5 rounded-xl text-sm font-bold transition active:scale-95">' + tr("prevType") + curTypeTabs[ti - 1].label + '</button>'
                : '<span></span>';
            var nextBtn = ti < curTypeTabs.length - 1
                ? '<button onclick="switchQTab(\\'' + curTypeTabs[ti + 1].t + '\\')" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl text-sm font-bold transition active:scale-95 shadow">' + tr("nextType") + curTypeTabs[ti + 1].label + ' →</button>'
                : '<button onclick="switchQTab(\\'report\\')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-xl text-sm font-bold transition active:scale-95 shadow">' + tr("viewReport") + '</button>';
            return '<div class="flex items-center gap-2 mb-4"><span class="w-2 h-6 bg-indigo-600 rounded-full"></span>'
                + '<h2 class="text-xl font-bold text-slate-900">' + mt.icon + ' ' + (mt.num ? mt.num + '、' : '') + mt.label + ' <span class="text-sm font-normal text-slate-400">(' + tf("nQuestions", { n: mt.count }) + ')</span></h2></div>'
                + secHtml
                + '<div class="flex items-center justify-between gap-3 mt-8 pt-5 border-t border-slate-200 mb-24">' + prevBtn + nextBtn + '</div>';
        }
        function renderedUnits() {
            var total = 0;
            activeQuizzes.forEach(function (q) {
                if (!renderedQTypes[q.type]) return;
                if (q.type === 'single' || q.type === 'judge' || q.type === 'multiple') total++;
                else if (q.type === 'essay') total++;
                else {
                    var mm = String(q.q || '').match(/_{4,}|＿{2,}/g);
                    total += mm ? mm.length : 1;
                }
            });
            return total;
        }
        function updateFillHint() {
            var el = document.getElementById('studyHint');
            if (el) el.innerHTML = tf("fillActive", { n: renderedUnits() });
        }
        function renderQTypeTab(t) {
            var sec = document.getElementById('qsec-' + t);
            if (!sec || renderedQTypes[t]) return;
            var idx = -1;
            for (var i = 0; i < curTypeTabs.length; i++) { if (curTypeTabs[i].t === t) { idx = i; break; } }
            if (idx < 0) return;
            sec.innerHTML = buildTypeSecHTML(curTypeTabs[idx], idx);
            renderedQTypes[t] = true;
            try { sec.querySelectorAll('[data-bible-ref]').forEach(function(el) { loadBibleRef(el); }); } catch (e) {}
            updateFillHint();
            if (typeof updateStudyBar === 'function') updateStudyBar();
        }
        function renderAllQTypeTabs() {
            for (var i = 0; i < curTypeTabs.length; i++) renderQTypeTab(curTypeTabs[i].t);
        }
        function switchQTab(tab) {
            if (tab !== 'overview' && !requireNameForQuiz(tab)) return;
            if (tab === 'report') renderAllQTypeTabs();
            else if (tab !== 'overview') renderQTypeTab(tab);
            document.querySelectorAll('#quizContainer .qsec').forEach(function (el) { el.classList.add('hidden'); });
            document.querySelectorAll('.qtab-btn').forEach(function (el) { el.classList.remove('qtab-active'); });
            var sec = document.getElementById('qsec-' + tab);
            if (sec) sec.classList.remove('hidden');
            var btn = document.getElementById('qtab-' + tab);
            if (btn) btn.classList.add('qtab-active');
            if (tab === 'report') updateQReport();
            var lm = document.getElementById('lessonModal');
            if (lm) lm.scrollTop = 0;
        }
        function toggleQRef(i) {
            var el = document.getElementById('qref-' + i);
            if (el) el.classList.toggle('hidden');
        }
        function updateQReport() {
            var p = document.getElementById('qr-progress');
            if (!p) return;
            var s = document.getElementById('qr-score'), r = document.getElementById('qr-rating'),
                h = document.getElementById('qr-hint'), act = document.getElementById('qr-action');
            var ans = 0, tot = 0;
            activeQuizzes.forEach(function (q, i) {
                if (q.type === 'single' || q.type === 'judge' || q.type === 'multiple') {
                    tot++;
                    if (document.querySelector('input[name="u-' + i + '"]:checked')) ans++;
                }
            });
            p.innerText = ans + ' / ' + tot;
            if (!lastGradeRes) {
                if (s) s.innerText = '--';
                if (r) { r.innerText = tr("repWait"); r.className = 'text-xl md:text-2xl font-bold text-slate-400'; }
                if (h) h.innerText = tr("repHint");
                if (act) { act.innerText = tr("checkBtn"); act.className = 'bg-slate-800 hover:bg-slate-900 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition'; }
                return;
            }
            var sc = lastGradeRes.score, gr = lastGradeRes.gradable;
            if (s) s.innerText = sc + ' / ' + gr;
            var pct = gr > 0 ? sc / gr * 100 : 0, rating = tr("rateGo"), cls = 'text-xl md:text-2xl font-bold text-slate-400';
            if (pct >= 80) { rating = tr("rateTop"); cls = 'text-xl md:text-2xl font-bold text-emerald-600'; }
            else if (pct >= 60) { rating = tr("rateGood"); cls = 'text-xl md:text-2xl font-bold text-indigo-600'; }
            else if (ans > 0) { rating = tr("rateRetry"); cls = 'text-xl md:text-2xl font-bold text-amber-500'; }
            if (r) { r.innerText = rating; r.className = cls; }
            if (h) h.innerText = tr("repDone");
            if (act) { act.innerText = tr("backEdit"); act.className = 'bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition'; }
        }

        /* 课程预取：手指悬停/触摸时提前拉取，下次点击直接命中缓存 */
        var _prefetching = {};
        function prefetchCourse(id) {
            if (!id || _prefetching[id]) return;
            var i, hit = false;
            var pools = [allData, (typeof BOOT !== "undefined" && BOOT.list) || []];
            for (var p = 0; p < pools.length && !hit; p++) {
                var arr = pools[p] || [];
                for (i = 0; i < arr.length; i++) { if (arr[i].id === id && arr[i].quizzes_json !== undefined) { hit = true; break; } }
            }
            if (hit) return;
            _prefetching[id] = true;
            fetch('/api/course?id=' + encodeURIComponent(id)).then(function (fr) {
                if (!fr.ok) return null;
                return fr.json();
            }).then(function (full) {
                if (!full || !full.id) return;
                for (var k = 0; k < allData.length; k++) { if (allData[k].id === id) { allData[k] = full; break; } }
            }).catch(function () {}).finally(function () { delete _prefetching[id]; });
        }
        async function startLesson(id) {
            /* 即时反馈：先弹骨架屏，数据就绪后再填充 */
            var _bodyEl0 = document.getElementById('lessonBody');
            if (_bodyEl0) _bodyEl0.innerHTML = '<div class="flex flex-col items-center justify-center py-24 text-slate-400"><div class="text-4xl mb-4 animate-bounce">📖</div><div class="text-sm">' + tr("loading") + '</div></div>';
            toggleModal('lessonModal');
            var _lms0 = document.getElementById('lessonModal'); if (_lms0) _lms0.scrollTop = 0;
            var item = null, k, p;
            /* 优先找已含完整题库的条目（分享页注入的单课 / 已按需拉取过的） */
            var pools = [allData, (typeof BOOT !== "undefined" && BOOT.list) || []];
            for (p = 0; p < pools.length && !item; p++) {
                var arr = pools[p] || [];
                for (k = 0; k < arr.length; k++) { if (arr[k].id === id && arr[k].quizzes_json !== undefined) { item = arr[k]; break; } }
            }
            if (!item) {
                for (k = 0; k < allData.length; k++) { if (allData[k].id === id) { item = allData[k]; break; } }
                /* 精简条目：按需拉取完整课程（题库/导读），成功后写回缓存 */
                if (item && item.quizzes_json === undefined) {
                    try {
                        var fr = await fetch('/api/course?id=' + encodeURIComponent(id));
                        if (fr.ok) {
                            var full = await fr.json();
                            item = full;
                            for (k = 0; k < allData.length; k++) { if (allData[k].id === id) { allData[k] = full; break; } }
                        }
                    } catch (e) {}
                }
            }
            if (!item || item.quizzes_json === undefined) return;
            if (curLang() === 'tw') item = twCourse(item);
            item = i18nCourse(item);
            activeLessonId = id;
            activeCourseTitle = item.title;
            activeCategory = item.category || "";
            activeSubcategory = item.subcategory || "";
            teacherMode = false;
            /* 不阻塞：后台刷新学员管理员状态，完成后更新教师按钮 */
            refreshStudentAdmin().then(function() {
                var tb = document.getElementById('teacherBtn');
                if (tb) tb.style.display = canViewAnswers() ? '' : 'none';
            });
            var prog = getMyProg();
            if (!prog[id] || !prog[id].completed) { prog[id] = { started: true, completed: false }; setMyProg(prog); }
            activeQuizzes = JSON.parse(item.quizzes_json || "[]");

            var videoHtml = "";
            var vids = parseVideoUrls(item.video_url);
            if (vids.length === 1 && /\\\.(mp4|webm|m4v|ogg)(\\\?|#|$)/i.test(vids[0].url)) {
                videoHtml = '<div id="lessonVideoWrap" class="rounded-3xl overflow-hidden bg-black mb-8"><video src="' + esc(vids[0].url) + '" controls playsinline preload="metadata" class="w-full max-h-[60vh]"></video></div>';
            } else if (vids.length >= 1) {
                window._curVids = vids;
                var sub = vids.length > 1 ? tf("videoMulti", { n: vids.length }) : esc(vids[0].label);
                videoHtml = '<div id="lessonVideoWrap"><a href="javascript:void(0)" onclick="openVideoChoice(window._curVids)" class="block rounded-3xl mb-8 p-8 text-center bg-gradient-to-br from-slate-900 to-indigo-950 text-white no-underline">'
                    + '<div class="text-5xl mb-3">▶️</div>'
                    + '<div class="font-black text-lg mb-1">' + tr("watchVideo") + '</div>'
                    + '<div class="text-slate-400 text-xs">' + sub + '</div></a></div>';
            }
            studyRevealed = false;
            var info0 = catInfo[item.category] || { description: "", subDesc: {} };
            var subDesc0 = item.subcategory ? (info0.subDesc[item.subcategory] || "") : "";
            /* 统一智能页头：有章节→分章课件版，无章节→互动答题版，均带实时进度 */
            var hasSections = activeQuizzes.some(function(q) { return (q.s || "").trim() !== ""; });
            var totalUnits = countUnits();
            var subTitle = hasSections ? tr("modeChapters") : tr("modeQuiz");
            var shareBar = '';
            if (BOOT.shareMode) {
                shareBar = '<div class="mb-6 flex flex-wrap items-center justify-between gap-3 bg-violet-50 border border-violet-100 rounded-2xl px-4 py-3 text-left">'
                    + '<a href="/" class="text-sm font-bold text-violet-700 hover:underline">' + tr("backHome") + '</a>'
                    + '<div id="shareNameBox" class="flex items-center gap-2 text-sm">' + shareNameHTML() + '</div></div>';
            } else {
                shareBar = '<div class="mb-6 flex flex-wrap items-center justify-between gap-3 bg-violet-50 border border-violet-100 rounded-2xl px-4 py-3 text-left">'
                    + '<a href="javascript:void(0)" onclick="closeLessonModal()" class="text-sm font-bold text-violet-700 hover:underline">' + tr("backList") + '</a>'
                    + '<div class="flex items-center gap-2 text-sm"><button onclick="openLangPanel()" class="text-xs bg-white border border-violet-200 px-3 py-1.5 rounded-xl font-medium text-violet-700 hover:bg-violet-50 transition">🌐 ' + langShort(curLang()) + '</button>' + shareNameHTML() + '</div></div>';
            }
            /* ===== 分 Tab 互动课件：导读 / 按题型分页 / 成绩报告（参考互动课件 UI） ===== */
            lastGradeRes = null;
            var typeTabs = [
                { t: 'verse', label: tr('tyVerse'), icon: '📜' },
                { t: 'fill', label: tr('tyFill'), icon: '✏️' },
                { t: 'single', label: tr('tySingle'), icon: '🔘' },
                { t: 'multiple', label: tr('tyMulti'), icon: '☑️' },
                { t: 'judge', label: tr('tyJudge'), icon: '⚖️' },
                { t: 'essay', label: tr('tyEssay'), icon: '💬' }
            ].filter(function (mt) { return activeQuizzes.some(function (q) { return q.type === mt.t; }); });
            var CN_NUM = (curLang() === 'zh' || curLang() === 'tw') ? ['一', '二', '三', '四', '五', '六'] : ['1', '2', '3', '4', '5', '6'];
            typeTabs.forEach(function (mt, ti) {
                mt.num = CN_NUM[ti] || '';
                mt.count = activeQuizzes.filter(function (q) { return q.type === mt.t; }).length;
            });
            var tabBtns = '<button id="qtab-overview" onclick="switchQTab(\\'overview\\')" class="qtab-btn qtab-active">' + tr("tabGuide") + '</button>'
                + typeTabs.map(function (mt) {
                    return '<button id="qtab-' + mt.t + '" onclick="switchQTab(\\'' + mt.t + '\\')" class="qtab-btn">' + mt.icon + ' ' + (mt.num ? mt.num + '、' : '') + mt.label + '<span class="qtab-count">' + tf("nQuestions", { n: mt.count }) + '</span></button>';
                }).join('')
                + '<button id="qtab-report" onclick="switchQTab(\\'report\\')" class="qtab-btn qtab-report">' + tr("tabReport") + '</button>';
            var teacherTopBtn = '<button id="teacherBtn" onclick="teacherUnlock()" class="shrink-0 text-xs px-3 py-2 rounded-lg font-bold bg-slate-800 hover:bg-slate-700 text-amber-200 border border-amber-500/30 transition">' + tr("teacherBtn") + '</button>';
            document.getElementById('lessonHeader').innerHTML = shareBar
                + '<div class="sticky top-0 z-40 -mx-3 md:-mx-6 px-3 md:px-6 pt-4 pb-2 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 shadow-md">'
                + '<div class="w-full max-w-7xl mx-auto"><div class="flex items-start justify-between gap-3">'
                + '<div class="min-w-0"><div class="flex items-center gap-2 text-[11px] font-semibold text-indigo-300 uppercase tracking-wider mb-1">'
                + '<span class="bg-indigo-900/80 px-2.5 py-0.5 rounded-full border border-indigo-700/50 truncate">' + esc(catNameL(item.category) || tr("courseWord")) + '</span>'
                + (item.subcategory ? subBadgeDark(subNameL(item.category, item.subcategory)) : '')
                + '<span class="shrink-0">' + tr("onlineLesson") + '</span></div>'
                + '<h1 class="text-xl md:text-2xl font-bold text-indigo-50 leading-snug">' + esc(item.title) + '</h1>'
                + '<p class="text-indigo-300/80 text-xs mt-1">' + subTitle + '</p></div>'
                + (canViewAnswers() ? teacherTopBtn : '<button onclick="openWrongBook(activeLessonId)" class="shrink-0 text-xs px-3 py-2 rounded-lg font-bold bg-indigo-900/80 hover:bg-indigo-800 text-indigo-100 border border-indigo-700/50 transition">' + tr("wrongBook") + '</button>')
                + '</div>'
                + '<div id="progress-bar" class="text-xs mt-2 text-indigo-200 font-medium">' + tf("progFill", { a: 0, b: totalUnits }) + '</div>'
                + '<nav class="flex gap-1 overflow-x-auto mt-1.5">' + tabBtns + '</nav>'
                + '</div></div>';
            /* 导读页：视频 / 课程内容 / 答题说明 / 开始答题 */
            var typeSummary = typeTabs.map(function (mt) { return (mt.num ? mt.num + '、' : '') + mt.label + tf("nQuestions", { n: mt.count }); }).join('、');
            var firstTab = typeTabs.length ? typeTabs[0].t : 'report';
            /* 课程导览卡片（思维导图式）：管理端按章节一条条录入的小结 */
            var guideCards = '';
            try {
                var _gdc = JSON.parse(item.guide_json || '[]');
                if (_gdc && _gdc.length) {
                    guideCards = '<div class="space-y-4">' + _gdc.map(function(ch, ci) {
                        var pts = (ch.points || []).filter(function(p) { return String(p).trim(); });
                        if (!String(ch.title || '').trim() && !pts.length) return '';
                        return '<div class="bg-slate-50 border border-slate-200/80 rounded-2xl p-5">'
                            + '<h3 class="font-bold text-indigo-950 text-sm mb-3 flex items-center gap-2.5">'
                            + '<span class="w-6 h-6 rounded-lg bg-indigo-600 text-white flex items-center justify-center text-xs font-black shrink-0">' + (ci + 1) + '</span>'
                            + '<span>' + esc(ch.title) + '</span></h3>'
                            + (pts.length ? '<ul class="space-y-2">' + pts.map(function(p) {
                                return '<li class="flex gap-2 text-sm text-slate-600 leading-relaxed"><span class="text-indigo-400 shrink-0 font-black">•</span><span>' + hlVerse(esc(p)) + '</span></li>';
                            }).join('') + '</ul>' : '')
                            + '</div>';
                    }).join('') + '</div>';
                }
            } catch (e) {}
            var overviewSec = '<section id="qsec-overview" class="qsec"><div class="bg-white rounded-2xl p-6 md:p-8 shadow-sm border border-slate-200/80 space-y-5">'
                + videoHtml
                + (item.content ? '<div class="prose text-slate-600 bg-slate-50 p-6 rounded-2xl text-sm leading-relaxed max-w-none">' + hlVerse(typeof marked !== 'undefined' ? marked.parse(item.content) : esc(item.content).replace(/\\n/g, '<br>')) + '</div>' : '')
                + guideCards
                + '<div class="bg-amber-50 p-4 rounded-xl border border-amber-200/80 flex items-start gap-3"><div class="shrink-0">💡</div>'
                + '<div class="text-xs text-amber-900 leading-relaxed whitespace-pre-line"><b>' + tr("quizGuideT") + '</b>' + (item.instructions ? esc(item.instructions) : (tf("defaultGuide", { summary: typeSummary || tr("multiTypes") }))) + '</div></div>'
                + '<div class="flex justify-end"><button onclick="switchQTab(\\'' + firstTab + '\\')" class="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition">' + tr("startQuiz") + '</button></div>'
                + '</div></section>';
            /* 按题型分页：懒加载，打开课件只放占位符，点页签时才渲染题目 */
            curTypeTabs = typeTabs;
            curHasSections = hasSections;
            renderedQTypes = {};
            var typeSecs = typeTabs.map(function (mt) {
                return '<section id="qsec-' + mt.t + '" class="qsec hidden"><div class="flex items-center justify-center py-20 text-slate-400 text-sm"><span>⏳</span></div></section>';
            }).join('');
            /* 成绩报告页 */
            var reportSec = '<section id="qsec-report" class="qsec hidden"><div class="bg-white rounded-2xl p-6 md:p-8 shadow-sm border border-slate-200/80 text-center space-y-6">'
                + '<div class="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto text-3xl">🎓</div>'
                + '<div><h2 class="text-2xl font-bold text-slate-900">' + tr("reportT") + '</h2><p class="text-xs text-slate-500 mt-1">' + esc(item.title) + tr("reportSub") + '</p></div>'
                + '<div class="grid grid-cols-3 gap-3 max-w-3xl mx-auto">'
                + '<div class="bg-slate-50 p-4 rounded-xl border border-slate-200"><div class="text-xs text-slate-500 mb-1">' + tr("repAnswered") + '</div><div class="text-xl md:text-2xl font-bold text-indigo-600" id="qr-progress">0 / 0</div></div>'
                + '<div class="bg-slate-50 p-4 rounded-xl border border-slate-200"><div class="text-xs text-slate-500 mb-1">' + tr("repObjScore") + '</div><div class="text-xl md:text-2xl font-bold text-emerald-600" id="qr-score">--</div></div>'
                + '<div class="bg-slate-50 p-4 rounded-xl border border-slate-200"><div class="text-xs text-slate-500 mb-1">' + tr("repRating") + '</div><div class="text-xl md:text-2xl font-bold text-slate-400" id="qr-rating">' + tr("repWait") + '</div></div>'
                + '</div>'
                + '<p id="qr-hint" class="text-xs text-slate-500 max-w-3xl mx-auto leading-relaxed"></p>'
                + '<div class="flex flex-wrap justify-center gap-3">'
                + '<button id="qr-action" onclick="studySubmitBtn()" class="bg-slate-800 hover:bg-slate-900 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition">' + tr("checkBtn") + '</button>'
                + '<button onclick="toggleStudyEdit();switchQTab(\\'overview\\')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 px-5 py-2.5 rounded-xl text-xs font-bold transition">' + tr("redoBtn") + '</button>'
                + (canViewAnswers() ? '<button onclick="teacherUnlock()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition">' + tr("allAnswers") + '</button>' : '')
                + '</div></div></section>';
            var bodyHtml = '<div id="quizContainer" class="space-y-6">' + overviewSec + typeSecs + reportSec + '</div>'
                + '<div class="sticky bottom-0 z-40 mt-6 -mx-3 md:-mx-6 px-3 md:px-6 pb-4 pt-3 bg-gradient-to-t from-white via-white to-transparent">'
                + '<div class="w-full max-w-7xl mx-auto bg-white/95 backdrop-blur border border-slate-200 rounded-2xl shadow-lg px-4 py-3 flex items-center justify-between gap-3">'
                + '<p id="studyHint" class="text-rose-500 text-xs italic">' + tf("fillActive", { n: totalUnits }) + '</p>'
                + '<button id="studySubmit" disabled onclick="studySubmitBtn()" class="shrink-0 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white font-bold py-2.5 px-6 rounded-xl shadow transition active:scale-95 text-sm">' + tr("checkBtn") + '</button>'
                + '</div></div>'
                + '<footer class="text-center mt-6 text-slate-400 text-xs">' + tr("srcFrom") + esc(catNameL(item.category)) + (item.subcategory ? ' · ' + esc(subNameL(item.category, item.subcategory)) : '') + ' · ' + esc(item.title) + '</footer>';
            var bodyEl = document.getElementById('lessonBody');
            bodyEl.innerHTML = bodyHtml;

            updateStudyBar();
            bodyEl.oninput = updateStudyBar;
            bodyEl.onchange = updateStudyBar;

            var bb = document.getElementById('backListBtn');
            if (bb) {
                if (BOOT.shareMode) { bb.innerText = tr("backHome"); bb.onclick = function() { location.href = '/'; }; }
                else { bb.innerText = tr("backList"); bb.onclick = function() { location.reload(); }; }
            }
            document.getElementById('resultArea').classList.add('hidden');
            /* 弹窗已在开头打开，这里只确保可见并回到顶部 */
            var lms = document.getElementById('lessonModal');
            if (lms) { lms.classList.remove('hidden'); try { document.body.style.overflow = 'hidden'; } catch (e) {} lms.scrollTop = 0; }
            switchQTab('overview');
        }

        /* 按姓名查询成绩（管理端） */
        async function queryScores() {
            var nameInput = document.getElementById('scoreQueryName');
            var name = (nameInput.value || "").trim() || progName();
            if (!name) { alert("请输入学员姓名"); return; }
            nameInput.value = name;
            var list = document.getElementById('scoreList');
            var empty = document.getElementById('scoreEmpty');
            var summary = document.getElementById('scoreSummary');
            list.innerHTML = '<li class="text-slate-400 text-sm">查询中…</li>';
            empty.classList.add('hidden');
            summary.classList.add('hidden');
            try {
                var r = await fetch('/api/scores?username=' + encodeURIComponent(name));
                var j = await r.json();
                var rows = j.scores || [];
                var delAllBtn = document.getElementById('delAllScoresBtn');
                var viewWrongsBtn = document.getElementById('viewAllWrongsBtn');
                if (!rows.length) {
                    list.innerHTML = '';
                    empty.classList.remove('hidden');
                    if (delAllBtn) delAllBtn.classList.add('hidden');
                    if (viewWrongsBtn) viewWrongsBtn.classList.add('hidden');
                    return;
                }
                if (delAllBtn) delAllBtn.classList.remove('hidden');
                if (viewWrongsBtn) viewWrongsBtn.classList.remove('hidden');
                var pctSum = 0, pctCnt = 0;
                list.innerHTML = rows.map(function(s) {
                    var mm = String(s.score || "").match(/(\\\d+)\\\s*\\\/\\\s*(\\\d+)/);
                    if (mm && +mm[2] > 0) { pctSum += (+mm[1]) / (+mm[2]); pctCnt++; }
                    return '<li class="flex items-center justify-between gap-2">'
                        + '<span class="text-slate-600 text-sm flex-1">' + esc(s.course_title || s.course_id) + '</span>'
                        + '<span class="text-slate-400 text-xs">' + esc(fmtTime(s.submitted_at)) + '</span>'
                        + '<span class="text-indigo-600 font-bold text-sm">' + esc(s.score) + '</span>'
                        + '<button data-cid="' + esc(s.course_id || '') + '" onclick="adminViewWrongs(this)" class="text-xs text-violet-600 border border-violet-200 rounded-lg px-2 py-1 shrink-0">📝 错题</button>'
                        + '<button onclick="deleteOneScore(' + (s.rowid || 0) + ')" class="text-xs text-red-400 border border-red-100 rounded-lg px-2 py-1 shrink-0">删除</button></li>';
                }).join('');
                if (pctCnt > 0) {
                    summary.innerText = '共 ' + rows.length + ' 条记录，平均 ' + Math.round(pctSum / pctCnt * 100) + ' 分';
                    summary.classList.remove('hidden');
                }
            } catch (e) {
                list.innerHTML = '<li class="text-red-400 text-sm">查询失败，请稍后重试</li>';
                var dab = document.getElementById('delAllScoresBtn');
                if (dab) dab.classList.add('hidden');
                var vwb = document.getElementById('viewAllWrongsBtn');
                if (vwb) vwb.classList.add('hidden');
            }
        }

        /* 管理端查看学员错题 */
        function closeAdminWrongModal() { var m = document.getElementById('adminWrongModal'); if (m) m.style.display = 'none'; }
        function ensureAdminWrongModal() {
            var m = document.getElementById('adminWrongModal');
            if (m) return m;
            m = document.createElement('div');
            m.id = 'adminWrongModal';
            m.style.cssText = 'position:fixed;inset:0;z-index:130;display:none;align-items:center;justify-content:center;padding:16px;';
            m.innerHTML = '<div style="position:absolute;inset:0;background:rgba(15,23,42,.6)" onclick="closeAdminWrongModal()"></div>'
                + '<div style="position:relative;background:#fff;border-radius:24px;width:100%;max-width:560px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 25px 50px rgba(0,0,0,.25)">'
                + '<div style="padding:18px 20px 12px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">'
                + '<h3 id="adminWrongTitle" style="font-weight:800;color:#1e293b;margin:0;font-size:16px">📝 学员错题</h3>'
                + '<button onclick="closeAdminWrongModal()" style="background:none;border:none;font-size:18px;color:#94a3b8;cursor:pointer">✕</button>'
                + '</div>'
                + '<div id="adminWrongList" style="padding:16px 20px;overflow-y:auto"></div>'
                + '</div>';
            document.body.appendChild(m);
            return m;
        }
        function renderAdminWrongs(arr) {
            var groups = {}, order = [];
            arr.forEach(function(x) {
                var k = x.course_title || x.course_id || '未知课件';
                if (!groups[k]) { groups[k] = []; order.push(k); }
                groups[k].push(x);
            });
            return order.map(function(k) {
                var items = groups[k].map(function(x) {
                    var tl = WRONG_TYPE_LABEL[x.qtype] || x.qtype || '';
                    var typeLine = [tl, x.qnum ? ('第' + x.qnum + '题') : ''].filter(function(s) { return s; }).join(' · ');
                    return '<div class="border border-slate-100 rounded-2xl p-4 mb-3">'
                        + '<div class="text-[11px] text-violet-500 font-bold mb-1">' + esc([x.series, x.sub].filter(function(s) { return s; }).join(' · ')) + '</div>'
                        + (typeLine ? '<div class="text-[11px] text-indigo-500 font-bold mb-1">' + esc(typeLine) + '</div>' : '')
                        + '<div class="text-sm text-slate-800 font-medium mb-2">' + esc(x.question) + '</div>'
                        + '<div class="text-xs mb-1"><span class="text-red-500 font-bold">学员答案：</span><span class="text-slate-600">' + esc(x.user_answer) + '</span></div>'
                        + '<div class="text-xs"><span class="text-emerald-600 font-bold">' + tr("rightAns") + '</span><span class="text-slate-600">' + esc(x.correct_answer) + '</span></div>'
                        + '</div>';
                }).join('');
                return '<div class="font-bold text-slate-700 text-sm mt-4 mb-2">📖 ' + esc(k) + '（' + groups[k].length + '题）</div>' + items;
            }).join('');
        }
        async function adminViewWrongs(btn) {
            var cid = btn ? (btn.getAttribute('data-cid') || '') : '';
            var nameEl = document.getElementById('scoreQueryName');
            var name = nameEl ? nameEl.value.trim() : '';
            if (!name) { alert('请先输入学员姓名并查询'); return; }
            var m = ensureAdminWrongModal();
            document.getElementById('adminWrongTitle').innerText = '📝 ' + name + ' 的错题';
            var list = document.getElementById('adminWrongList');
            list.innerHTML = '<div class="text-center text-slate-400 text-sm py-8">加载中…</div>';
            m.style.display = 'flex';
            try {
                var url = '/api/wrongs?username=' + encodeURIComponent(name) + (cid ? '&course_id=' + encodeURIComponent(cid) : '');
                var r = await fetch(url);
                if (!r.ok) throw 0;
                var j = await r.json();
                var arr = j.wrongs || [];
                if (!arr.length) { list.innerHTML = '<div class="text-center text-slate-400 text-sm py-8">该学员暂无错题记录</div>'; return; }
                list.innerHTML = renderAdminWrongs(arr);
            } catch (e) {
                list.innerHTML = '<div class="text-center text-red-400 text-sm py-8">加载失败，请稍后重试</div>';
            }
        }
        function adminViewAllWrongs() { adminViewWrongs(null); }

        /* 学员名单 / 删除成绩（管理端） */
        async function loadStudents() {
            var sel = document.getElementById('studentSelect');
            if (!sel) return;
            try {
                var r = await fetch('/api/students');
                if (r.status === 403) { sel.innerHTML = '<option value="">请先登录管理端</option>'; return; }
                var j = await r.json();
                var st = j.students || [];
                sel.innerHTML = '<option value="">📋 全部学员（' + st.length + '）…</option>' + st.map(function(x) {
                    return '<option value="' + esc(x.username) + '">' + esc(x.username) + '（' + x.n + ' 条）</option>';
                }).join('');
            } catch (e) {
                sel.innerHTML = '<option value="">名单加载失败，点刷新重试</option>';
            }
        }
        async function loadAdminStudents() {
            var ul = document.getElementById('adminStudentList');
            if (!ul) return;
            try {
                var r = await fetch('/api/students/registered');
                if (r.status === 403) { ul.innerHTML = '<li class="text-sm text-slate-400">请先登录管理端</li>'; return; }
                var j = await r.json();
                var st = j.students || [];
                if (!st.length) { ul.innerHTML = '<li class="text-sm text-slate-400">暂无注册学员</li>'; return; }
                ul.innerHTML = st.map(function(s) {
                    var admin = !!s.is_admin;
                    return '<li class="flex items-center justify-between gap-2 border border-slate-100 rounded-2xl px-4 py-2.5">'
                        + '<span class="text-sm font-bold text-slate-700">' + esc(s.username) + (admin ? ' <span class="text-[10px] bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">👑 管理员</span>' : '') + '</span>'
                        + '<div class="flex gap-2">'
                        + '<button data-un="' + esc(s.username) + '" onclick="resetStudentPw(this.dataset.un)" class="text-xs font-bold px-3 py-1.5 rounded-xl bg-slate-100 text-slate-600">重置密码</button>'
                        + '<button data-un="' + esc(s.username) + '" data-to="' + (admin ? '0' : '1') + '" onclick="toggleStudentAdmin(this.dataset.un, this.dataset.to)" class="text-xs font-bold px-3 py-1.5 rounded-xl ' + (admin ? 'bg-slate-100 text-slate-500' : 'bg-violet-600 text-white') + '">'
                        + (admin ? '取消管理员' : '设为管理员') + '</button></div></li>';
                }).join('');
            } catch (e) {
                ul.innerHTML = '<li class="text-sm text-slate-400">加载失败，点刷新重试</li>';
            }
        }
        async function toggleStudentAdmin(username, to) {
            if (!confirm((to ? '设「' : '取消「') + username + '」为学员管理员？')) return;
            try {
                var r = await fetch('/api/student/set-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username, is_admin: !!to }) });
                if (r.status === 403) { alert('请先登录管理端'); return; }
                var j = await r.json();
                if (j.success) loadAdminStudents();
                else alert('设置失败：' + (j.error || '未知错误'));
            } catch (e) { alert('设置失败，请稍后重试'); }
        }
        function pickStudent(v) {
            if (!v) return;
            document.getElementById('scoreQueryName').value = v;
            queryScores();
        }
        async function deleteOneScore(rowid) {
            var name = (document.getElementById('scoreQueryName').value || "").trim();
            if (!name) { alert("请先查询一位学员"); return; }
            if (!rowid) { alert("记录标识缺失，无法删除"); return; }
            if (!confirm("确定删除这条成绩记录吗？")) return;
            try {
                var r = await fetch('/api/score/delete', { method: 'POST', body: JSON.stringify({ username: name, rowid: rowid }) });
                if (r.status === 403) { alert("请先登录管理端"); return; }
                var j = await r.json();
                if (j.success) { queryScores(); loadStudents(); }
                else alert("删除失败：" + (j.error || "未知错误"));
            } catch (e) { alert("删除失败，请稍后重试"); }
        }
        async function deleteAllScores() {
            var name = (document.getElementById('scoreQueryName').value || "").trim();
            if (!name) { alert("请先查询一位学员"); return; }
            if (!confirm("确定删除「" + name + "」的全部成绩记录吗？此操作不可恢复！")) return;
            try {
                var r = await fetch('/api/score/delete', { method: 'POST', body: JSON.stringify({ username: name }) });
                if (r.status === 403) { alert("请先登录管理端"); return; }
                var j = await r.json();
                if (j.success) { alert("已删除 " + (j.deleted || 0) + " 条记录"); queryScores(); loadStudents(); }
                else alert("删除失败：" + (j.error || "未知错误"));
            } catch (e) { alert("删除失败，请稍后重试"); }
        }

        /* 导出成绩 CSV（管理端） */
        async function exportCSV() {
            try {
                var r = await fetch('/api/scores-all');
                if (r.status === 403) { alert("请先登录管理端"); return; }
                var j = await r.json();
                var rows = j.scores || [];
                var csv = "﻿姓名,课程,成绩,提交时间\\n" + rows.map(function(s) {
                    var cell = function(x) { return '"' + String(x == null ? "" : x).replace(/"/g, '""') + '"'; };
                    return [cell(s.username), cell(s.course_title || s.course_id), cell(s.score), cell(fmtTime(s.submitted_at))].join(",");
                }).join("\\n");
                var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = "团契智学成绩_" + new Date().toISOString().slice(0, 10) + ".csv";
                a.click();
            } catch (e) { alert("导出失败，请稍后重试"); }
        }

        /* ===== 课件导出：生成独立 HTML（手机/电脑浏览器直接打开，答案默认折叠） ===== */
        var EXP_TYPE_LABEL = { fill: '✏️ 填空题', single: '🔘 单项选择题', multiple: '☑️ 多项选择题', judge: '⚖️ 判断题', essay: '💬 问答与思辨', verse: '📖 经文诵读' };
        var EXP_CSS = 'body{margin:0;background:#f6f7fb;color:#1e293b;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.75;font-size:16px;}'
            + '.wrap{max-width:800px;margin:0 auto;padding:20px 16px 60px;}'
            + '.hero{background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;border-radius:20px;padding:28px 24px;margin-bottom:18px;}'
            + '.hero .meta{font-size:12px;opacity:.85;margin-bottom:6px;}'
            + '.hero h1{margin:0 0 8px;font-size:24px;line-height:1.4;}'
            + '.hero .date{font-size:12px;opacity:.75;}'
            + '.card{background:#fff;border-radius:18px;padding:22px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.05);}'
            + '.card h2{margin:0 0 14px;font-size:18px;}'
            + '.md p{margin:0 0 10px;} .md h2{font-size:17px;} .md h3{font-size:16px;} .md h4{font-size:15px;}'
            + '.md ul{margin:0 0 10px;padding-left:22px;} .md li{margin-bottom:4px;}'
            + '.md a{color:#4f46e5;}'
            + '.chapter{border-left:3px solid #a78bfa;padding:4px 0 4px 14px;margin-bottom:14px;}'
            + '.ch-title{font-weight:700;margin-bottom:6px;}'
            + '.ch-num{display:inline-block;min-width:24px;height:24px;line-height:24px;text-align:center;background:#4f46e5;color:#fff;font-size:13px;font-weight:800;border-radius:7px;margin-right:8px;}'
            + '.chapter ul{margin:6px 0 0;padding-left:20px;color:#475569;} .chapter li{margin-bottom:4px;}'
            + '.q{border-top:1px solid #f1f5f9;padding:14px 0;} .q:first-of-type{border-top:none;}'
            + '.q-verse{background:#eff6ff;border:1px solid #bfdbfe;border-left:4px solid #3b82f6;border-radius:12px;padding:12px 14px;margin:12px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
            + '.verse-ref-line{margin:2px 0 8px;}'
            + '.q-text{font-weight:600;margin-bottom:8px;}'
            + '.blank{display:inline-block;min-width:70px;border-bottom:2px solid #94a3b8;margin:0 2px;}'
            + '.opts{margin:8px 0;} .opt{padding:6px 0;color:#475569;}'
            + 'details.ans{margin-top:8px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:10px 14px;}'
            + 'details.ans summary{cursor:pointer;font-weight:700;color:#047857;font-size:14px;}'
            + 'details.ans div{margin-top:6px;color:#334155;}'
            + 'footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px;}'
            + '.empty{color:#94a3b8;text-align:center;padding:20px;}'
            + '.ws{margin:10px 0 4px;}.ws-line{border-bottom:1px solid #cbd5e1;height:1.8em;}'
            + '.verse-ref{display:inline-block;background:#7c3aed;color:#fff;font-weight:700;font-size:12px;padding:1px 8px;border-radius:9999px;white-space:nowrap;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.verse-ref-icon{display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;font-weight:700;font-size:12px;padding:1px 7px;border-radius:9999px;white-space:nowrap;margin-right:4px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.verse-ref-book{display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;font-weight:700;font-size:12px;padding:1px 8px;border-radius:9999px;white-space:nowrap;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.verse-ref-num{display:inline-block;background:#eff6ff;color:#1d4ed8;font-weight:700;font-size:12px;padding:1px 8px;border-radius:9999px;white-space:nowrap;border:1.5px solid #60a5fa;margin-left:4px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.verse-text{background:#fef3c7;color:#92400e;font-weight:700;border-radius:3px;padding:0 3px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
            + '@media print{body{background:#fff;}.wrap{max-width:none;padding:0;}.card{box-shadow:none;border:1px solid #e2e8f0;break-inside:avoid;}details.ans{break-inside:avoid;}.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}';
        function expInline(t) {
            return String(t).replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
                .replace(/\\*([^\\*]+?)\\*/g, '<em>$1</em>')
                .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>')
                .replace(/_{2,}/g, '<span class="blank">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>');
        }
        function expMd(src) {
            var lines = esc(String(src || '')).split('\\n'), html = '', inList = false, i, ln, m;
            for (i = 0; i < lines.length; i++) {
                ln = lines[i];
                m = ln.match(/^(#{1,4})\\s+(.*)$/);
                if (m) {
                    if (inList) { html += '</ul>'; inList = false; }
                    var lv = m[1].length + 1;
                    html += '<h' + lv + '>' + expInline(m[2]) + '</h' + lv + '>';
                } else if (/^(-|\\*)\\s+/.test(ln)) {
                    if (!inList) { html += '<ul>'; inList = true; }
                    html += '<li>' + expInline(ln.replace(/^(-|\\*)\\s+/, '')) + '</li>';
                } else if (/^\\s*$/.test(ln)) {
                    if (inList) { html += '</ul>'; inList = false; }
                } else {
                    if (inList) { html += '</ul>'; inList = false; }
                    html += '<p>' + expInline(ln) + '</p>';
                }
            }
            if (inList) html += '</ul>';
            return html;
        }
        function expAnswer(q) {
            var a = String(q.a == null ? '' : q.a).trim();
            if (!a) return '';
            var t = q.type || 'fill', i;
            if (t === 'single' || t === 'multiple') {
                var opts = {};
                String(q.o || '').split(',').forEach(function(p) {
                    var mm = String(p).trim().match(/^([A-Z])[.、．\\s]+(.*)$/);
                    if (mm) opts[mm[1]] = mm[2];
                });
                return a.split(/[|｜]/).map(function(x) {
                    var ch = String(x).trim().charAt(0);
                    return opts[ch] ? ch + '. ' + opts[ch] : ch;
                }).join('；');
            }
            if (t === 'fill') {
                var gs = a.split(/[|｜；]/).map(function(g) {
                    return String(g).split(/[/／或、，,;]/).map(function(x) { return String(x).trim(); }).filter(function(x) { return x; });
                }).filter(function(g) { return g.length; });
                if (!gs.length) return a;
                return gs.map(function(g) { return g.join(' / '); }).join('；');
            }
            return a;
        }
        /* 单个课件导出内层（含标题横幅）：多课件合并打印时复用 */
        function courseExportInner(c) {
            var qs = [], guide = [];
            try { qs = JSON.parse(c.quizzes_json || '[]'); } catch (e) {}
            try { guide = JSON.parse(c.guide_json || '[]'); } catch (e) {}
            var title = c.title || '未命名课件';
            var meta = [c.category, c.subcategory].filter(function(x) { return x; }).join(' · ');
            var now = new Date(), ds = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
            var body = '<header class="hero"><div class="meta">' + esc(meta) + '</div>'
                + '<h1>' + esc(title) + '</h1><div class="date">导出日期：' + ds + ' · 团契智学</div></header>', i;
            if (c.content) body += '<section class="card"><h2>📚 课程导读</h2><div class="md">' + expMd(c.content) + '</div></section>';
            if (c.video_url) body += '<section class="card"><h2>🎬 课程视频</h2><p class="md"><a href="' + esc(c.video_url) + '">观看课程视频</a></p></section>';
            var realGuide = guide.filter(function(g) { return g && (g.title || (g.points || []).length); });
            if (realGuide.length) {
                body += '<section class="card"><h2>🗺️ 课程导览</h2>' + realGuide.map(function(g, gi) {
                    var pts = (g.points || []).filter(function(x) { return String(x).trim(); });
                    return '<div class="chapter"><div class="ch-title"><span class="ch-num">' + (gi + 1) + '</span>' + esc(g.title || ('第' + (gi + 1) + '章')) + '</div>'
                        + (pts.length ? '<ul>' + pts.map(function(x) { return '<li>' + hlVerse(esc(x)) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
                }).join('') + '</section>';
            }
            if (c.instructions) body += '<section class="card"><h2>📝 答题说明</h2><div class="md">' + expMd(c.instructions) + '</div></section>';
            var order = ['verse', 'fill', 'single', 'multiple', 'judge', 'essay'], groups = {};
            qs.forEach(function(q) { var t = q.type || 'fill'; (groups[t] = groups[t] || []).push(q); });
            var hasQ = false;
            order.forEach(function(t) {
                var list = groups[t] || [];
                if (!list.length) return;
                hasQ = true;
                body += '<section class="card"><h2>' + (EXP_TYPE_LABEL[t] || t) + '（共' + list.length + '题）</h2>';
                list.forEach(function(q, qi) {
                    var rawQ = q.q || '';
                    var vref = '';
                    if (t === 'verse') {
                        /* 去掉题干开头的"【经文填空】"字样 */
                        if (rawQ.charAt(0) === '【') {
                            var ce = rawQ.indexOf('】');
                            if (ce > 0 && ce < 12) rawQ = rawQ.slice(ce + 1);
                        }
                        /* 经文出处徽章（与网页端一致，q.o 如"《约翰福音》3章16节"） */
                        vref = (q.h || q.o) ? '<div class="verse-ref-line">' + hlVerse(esc(stripEmoji(q.h || q.o))) + '</div>' : '';
                    }
                    var qtext = expInline(hlVerse(esc(rawQ)));
                    var bracket = (t === 'single' || t === 'multiple' || t === 'judge') ? '（ ）' : '';
                    var opts = '';
                    if ((t === 'single' || t === 'multiple') && q.o) {
                        opts = '<div class="opts">' + String(q.o).split(',').map(function(p) {
                            return '<div class="opt">' + esc(String(p).trim()) + '</div>';
                        }).join('') + '</div>';
                    }
                    var ws = '';
                    if (t === 'essay') {
                        var ansLen = 0;
                        try { ansLen = String(expAnswer(q) || '').length; } catch (e) {}
                        var wsLines = Math.max(3, Math.min(15, Math.ceil(ansLen / 30)));
                        ws = '<div class="ws">';
                        for (var wi = 0; wi < wsLines; wi++) ws += '<div class="ws-line"></div>';
                        ws += '</div>';
                    }
                    var qtextHtml = (t === 'verse') ? '<span class="verse-text">' + qtext + '</span>' : qtext;
                    body += '<div class="q' + (t === 'verse' ? ' q-verse' : '') + '"><div class="q-text">' + (qi + 1) + '. ' + bracket + vref + qtextHtml + '</div>' + opts + ws + '</div>';
                });
                body += '</section>';
            });
            /* 参考答案统一附在所有题型之后，不再每题单独出现 */
            body += buildAnswerKey(c);
            if (!hasQ && !c.content && !realGuide.length) body += '<section class="card"><p class="empty">本课件暂无内容</p></section>';
            return { title: title, body: body };
        }
        function buildExportHTML(c) {
            var inner = courseExportInner(c);
            return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
                + '<meta name="viewport" content="width=device-width,initial-scale=1">'
                + '<title>' + esc(inner.title) + ' - 团契智学</title><style>' + EXP_CSS + '</style></head>'
                + '<body><div class="wrap">' + inner.body + '<footer>由团契智学学习平台导出</footer></div></body></html>';
        }
        /* 多课件合并为一份打印文档（每课件另起一页） */
        function buildMultiCourseHTML(courses, docTitle) {
            var parts = courses.map(function(c, i) {
                var inner = courseExportInner(c);
                return (i > 0 ? '<div style="page-break-before:always"></div>' : '') + inner.body;
            }).join('');
            return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
                + '<meta name="viewport" content="width=device-width,initial-scale=1">'
                + '<title>' + esc(docTitle || '课件合集') + ' - 团契智学</title><style>' + EXP_CSS + '</style></head>'
                + '<body><div class="wrap">' + parts + '<footer>由团契智学学习平台导出</footer></div></body></html>';
        }
        function printCourses(courses, docTitle) {
            var w = window.open('', '_blank');
            if (!w) { alert('浏览器阻止了新窗口，请允许弹窗后重试'); return; }
            w.document.write(buildMultiCourseHTML(courses, docTitle));
            w.document.close();
            w.focus();
            setTimeout(function() { w.print(); }, 600);
        }
        function safeFileName(s) {
            var t = String(s || '课件'), bad = ['\\\\', '/', ':', '*', '?', '"', '<', '>', '|'], i;
            for (i = 0; i < bad.length; i++) t = t.split(bad[i]).join('_');
            t = t.slice(0, 60).trim();
            return t || '课件';
        }
        function downloadHTML(filename, html) {
            var blob = new Blob(['\\ufeff' + html], { type: 'text/html;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(function() { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 1500);
        }
        function findCourse(id) {
            var list = allData || [], i;
            for (i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
            return null;
        }
        function exportCourse(id) {
            openExportMenu([id]);
        }
        function exportSelected() {
            var nodes = document.querySelectorAll('.exp-check:checked'), ids = [], i;
            for (i = 0; i < nodes.length; i++) ids.push(nodes[i].getAttribute('data-id'));
            if (!ids.length) { alert('请先勾选要导出的课件（卡片左上角复选框）'); return; }
            openExportMenu(ids);
        }
        /* ===== Office 导出：Word / Excel / PPTX / 打印存PDF ===== */
        var EXP_TYPE_PLAIN = { fill: '填空题', single: '单项选择题', multiple: '多项选择题', judge: '判断题', essay: '问答与思辨', verse: '经文诵读' };
        var exportIds = [];
        var exportLabel = '';
        function openExportMenu(ids, label) {
            exportIds = ids || [];
            exportLabel = label || '';
            var m = document.getElementById('exportModal');
            if (!m) {
                m = document.createElement('div');
                m.id = 'exportModal';
                m.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:16px;';
                m.innerHTML = '<div style="position:absolute;inset:0;background:rgba(15,23,42,.5)" onclick="closeExportMenu()"></div>'
                    + '<div style="position:relative;background:#fff;border-radius:24px;padding:24px;width:100%;max-width:340px;box-shadow:0 25px 50px rgba(0,0,0,.25)">'
                    + '<h3 style="font-weight:800;color:#1e293b;margin:0 0 4px">📥 导出课件</h3>'
                    + '<p id="exportMenuSub" style="font-size:12px;color:#94a3b8;margin:0 0 16px"></p>'
                    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
                    + '<button data-fmt="html" onclick="doExport(this.dataset.fmt)" style="border:1px solid #e2e8f0;border-radius:16px;padding:12px;font-size:14px;font-weight:700;color:#334155;background:#fff">📄<br>网页 HTML</button>'
                    + '<button data-fmt="word" onclick="doExport(this.dataset.fmt)" style="border:1px solid #e2e8f0;border-radius:16px;padding:12px;font-size:14px;font-weight:700;color:#334155;background:#fff">📝<br>Word 文档</button>'
                    + '<button data-fmt="excel" onclick="doExport(this.dataset.fmt)" style="border:1px solid #e2e8f0;border-radius:16px;padding:12px;font-size:14px;font-weight:700;color:#334155;background:#fff">📊<br>Excel 表格</button>'
                    + '<button data-fmt="pptx1" onclick="doExport(this.dataset.fmt)" style="border:1px solid #e2e8f0;border-radius:16px;padding:12px;font-size:14px;font-weight:700;color:#334155;background:#fff">📽️<br>PPT 单页版<br><span style="font-size:11px;font-weight:400;color:#94a3b8">自设动画</span></button>'
                    + '<button data-fmt="pptx2" onclick="doExport(this.dataset.fmt)" style="border:1px solid #e2e8f0;border-radius:16px;padding:12px;font-size:14px;font-weight:700;color:#334155;background:#fff">📽️<br>PPT 两页版<br><span style="font-size:11px;font-weight:400;color:#94a3b8">翻页揭示</span></button>'
                    + '</div>'
                    + '<button data-fmt="print" onclick="doExport(this.dataset.fmt)" style="margin-top:8px;width:100%;border:1px solid #e2e8f0;border-radius:16px;padding:12px;font-size:14px;font-weight:700;color:#334155;background:#fff">🖨️ 打印 / 存为 PDF</button>'
                    + '<button onclick="closeExportMenu()" style="margin-top:4px;width:100%;font-size:12px;color:#94a3b8;padding:8px;background:none;border:none">取消</button>'
                    + '</div>';
                document.body.appendChild(m);
            }
            var sub = document.getElementById('exportMenuSub');
            if (exportLabel) {
                sub.innerText = exportLabel + '，批量导出（逐个下载）';
            } else if (exportIds.length === 1) {
                var c0 = findCourse(exportIds[0]);
                sub.innerText = '单个课件：' + (c0 ? c0.title : '');
            } else {
                sub.innerText = '批量导出 ' + exportIds.length + ' 个课件（逐个下载）';
            }
            m.style.display = 'flex';
        }
        function closeExportMenu() {
            var m = document.getElementById('exportModal');
            if (m) m.style.display = 'none';
        }
        function doExport(fmt) {
            var ids = exportIds.slice();
            closeExportMenu();
            if (!ids.length) return;
            if (fmt === 'print') {
                var pcs = ids.map(function(id) { return findCourse(id); }).filter(function(c) { return c; });
                if (pcs.length === 1) printCourse(pcs[0]);
                else if (pcs.length > 1) printCourses(pcs, exportLabel || ('批量课件（' + pcs.length + '个）'));
                return;
            }
            ids.forEach(function(id, i) { setTimeout(function() { exportOne(id, fmt); }, i * 900); });
        }
        function exportOne(id, fmt) {
            var c = findCourse(id);
            if (!c) return;
            var fn = safeFileName(c.title);
            if (fmt === 'html') downloadHTML(fn + '.html', buildExportHTML(c));
            else if (fmt === 'word') downloadBytes(fn + '.docx', buildDocx(c), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            else if (fmt === 'excel') downloadBytes(fn + '.xlsx', buildXlsx(c), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            else if (fmt === 'pptx1') downloadBytes(fn + '-单页版.pptx', buildPptx(c, 'single'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
            else if (fmt === 'pptx2') downloadBytes(fn + '-两页版.pptx', buildPptx(c, 'dual'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
        }
        function downloadText(filename, text, mime) {
            var blob = new Blob([String.fromCharCode(65279) + text], { type: mime || 'text/plain;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(function() { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 1500);
        }
        function downloadBytes(filename, bytes, mime) {
            var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(function() { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 1500);
        }
        var WORD_CSS = 'body{font-family:"Microsoft YaHei",sans-serif;font-size:14px;color:#000;}'
            + 'h1{font-size:22px;}h2{font-size:18px;}'
            + '.q{margin:10px 0;}.q-text{font-weight:bold;}'
            + '.blank{text-decoration:underline;}'
            + '.ans{background:#f0f0f0;padding:8px;margin-top:6px;}'
            + '.verse-text{background:#fef3c7;}'
            + '.verse-ref-book{background:#7c3aed;color:#fff;padding:2px 6px;}'
            + '.verse-ref-num{color:#1d4ed8;}'
            + '.ws-line{border-bottom:1px solid #999;height:28px;}';
        function buildAnswerKey(c) {
            var qs = [];
            try { qs = JSON.parse(c.quizzes_json || '[]'); } catch (e) {}
            if (!qs.length) return '';
            var order = ['verse', 'fill', 'single', 'multiple', 'judge', 'essay'];
            var groups = {};
            qs.forEach(function(q) { var t = q.type || 'fill'; (groups[t] = groups[t] || []).push(q); });
            var html = '<div class="card answer-key"><h2>📋 参考答案</h2>';
            order.forEach(function(t) {
                var list = groups[t] || [];
                if (!list.length) return;
                html += '<p><b>' + (EXP_TYPE_LABEL[t] || t) + '</b></p><ol>';
                list.forEach(function(q) {
                    var ans = expAnswer(q);
                    html += '<li>' + esc(ans || '（开放作答）') + '</li>';
                });
                html += '</ol>';
            });
            html += '<p style="color:#94a3b8;font-size:12px;">提示：打印试卷时可删除本节，或不打印最后几页。</p></div>';
            return html;
        }
        function buildWordHTML(c) {
            var h = buildExportHTML(c);
            h = h.split('<!DOCTYPE html>').join('');
            h = h.split('<meta name="viewport" content="width=device-width,initial-scale=1">').join('');
            h = h.split('<html lang="zh-CN">').join('<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">');
            var p1 = h.split('<style>');
            var p2 = p1[1].split('</style>');
            h = p1[0] + '<style>' + WORD_CSS + '</style>' + p2[1];
            h = h.split('<span class="blank">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>').join('<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>');
            return h;
        }
        function buildExcelHTML(c) {
            var qs = [];
            try { qs = JSON.parse(c.quizzes_json || '[]'); } catch (e) {}
            var guide = [];
            try { guide = JSON.parse(c.guide_json || '[]'); } catch (e) {}
            var guideHtml = '';
            var realGuide = guide.filter(function(g) { return g && (g.title || (g.points || []).length); });
            if (realGuide.length) {
                var grows = realGuide.map(function(g, gi) {
                    var pts = (g.points || []).filter(function(x) { return String(x).trim(); });
                    return '<tr><td>' + (gi + 1) + '</td><td>' + esc(g.title || '') + '</td><td>' + hlVerse(esc(pts.join('；'))) + '</td></tr>';
                }).join('');
                guideHtml = '<h3>课程导览</h3><table border="1" cellpadding="6" cellspacing="0"><tr><th>序号</th><th>章节</th><th>要点</th></tr>' + grows + '</table><br><br>';
            }
            var trs = qs.map(function(q, i) {
                var t = q.type || 'fill';
                var bracket = (t === 'single' || t === 'multiple' || t === 'judge') ? '（ ）' : '';
                return '<tr><td>' + (i + 1) + '</td><td>' + esc(EXP_TYPE_PLAIN[t] || t) + '</td><td>' + hlVerse(esc(bracket + (q.q || ''))) + '</td><td>' + esc(q.o || '') + '</td><td>' + esc(expAnswer(q)) + '</td></tr>';
            }).join('');
            return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">'
                + '<head><meta charset="utf-8"><style>.verse-ref{display:inline-block;background:#7c3aed;color:#fff;font-weight:700;font-size:12px;padding:1px 8px;border-radius:9999px;white-space:nowrap;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.verse-ref-icon{display:inline-block;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;font-weight:700;font-size:12px;padding:1px 7px;border-radius:9999px;white-space:nowrap;margin-right:4px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.verse-ref-book{display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;font-weight:700;font-size:12px;padding:1px 8px;border-radius:9999px;white-space:nowrap;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.verse-ref-num{display:inline-block;background:#eff6ff;color:#1d4ed8;font-weight:700;font-size:12px;padding:1px 8px;border-radius:9999px;white-space:nowrap;border:1.5px solid #60a5fa;margin-left:4px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.verse-text{background:#fef3c7;color:#92400e;font-weight:700;border-radius:3px;padding:0 3px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}</style>'
                + '<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>题库</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->'
                + '</head><body>'
                + guideHtml
                + '<h3>题库</h3><table border="1" cellpadding="6" cellspacing="0"><tr><th>序号</th><th>题型</th><th>题目</th><th>选项</th><th>答案</th></tr>'
                + trs + '</table></body></html>';
        }
        function printCourse(c) {
            var w = window.open('', '_blank');
            if (!w) { alert('浏览器阻止了新窗口，请允许弹窗后重试'); return; }
            w.document.write(buildExportHTML(c));
            w.document.close();
            w.focus();
            setTimeout(function() { w.print(); }, 600);
        }
        /* ---- 错题本导出：与课件导出相同的全部格式（HTML / Word / Excel / PPT单页 / PPT两页 / 打印） ---- */
        var WRONG_TYPE_LABEL = { fill: '填空题', single: '单项选择题', multiple: '多项选择题', judge: '判断题', essay: '问答与思辨', verse: '经文诵读' };
        function wrongTypeNum(x) {
            var parts = [];
            var tl = WRONG_TYPE_LABEL[x.type] || x.type || '';
            if (tl) parts.push(tl);
            if (x.n) parts.push('第' + x.n + '题');
            return parts.join(' · ');
        }
        function wrongMeta(x) {
            return [x.series, x.sub, x.title].filter(function(s) { return s; }).join(' · ');
        }
        function wrongDateStr() {
            var now = new Date();
            return now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
        }
        function wrongBookName() {
            var nm = "";
            try { nm = progName(); } catch (e) {}
            return nm || tr("wbAnon");
        }
        function openWrongExportMenu() {
            var m = document.getElementById('wrongExportModal');
            if (!m) {
                m = document.createElement('div');
                m.id = 'wrongExportModal';
                m.style.cssText = 'position:fixed;inset:0;z-index:130;display:none;align-items:center;justify-content:center;padding:16px;';
                var btn = 'style="border:1px solid #e2e8f0;border-radius:16px;padding:12px;font-size:14px;font-weight:700;color:#334155;background:#fff"';
                m.innerHTML = '<div style="position:absolute;inset:0;background:rgba(15,23,42,.5)" onclick="closeWrongExportMenu()"></div>'
                    + '<div style="position:relative;background:#fff;border-radius:24px;padding:24px;width:100%;max-width:340px;box-shadow:0 25px 50px rgba(0,0,0,.25)">'
                    + '<h3 id="wrongExportTitle" style="font-weight:800;color:#1e293b;margin:0 0 4px">📥 导出错题本</h3>'
                    + '<p id="wrongExportSub" style="font-size:12px;color:#94a3b8;margin:0 0 16px"></p>'
                    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
                    + '<button data-fmt="html" onclick="doWrongExport(this.dataset.fmt)" ' + btn + '>📄<br>网页 HTML</button>'
                    + '<button data-fmt="word" onclick="doWrongExport(this.dataset.fmt)" ' + btn + '>📝<br>Word 文档</button>'
                    + '<button data-fmt="excel" onclick="doWrongExport(this.dataset.fmt)" ' + btn + '>📊<br>Excel 表格</button>'
                    + '<button data-fmt="pptx1" onclick="doWrongExport(this.dataset.fmt)" ' + btn + '>📽️<br>PPT 单页版<br><span style="font-size:11px;font-weight:400;color:#94a3b8">自设动画</span></button>'
                    + '<button data-fmt="pptx2" onclick="doWrongExport(this.dataset.fmt)" ' + btn + '>📽️<br>PPT 两页版<br><span style="font-size:11px;font-weight:400;color:#94a3b8">翻页揭示</span></button>'
                    + '</div>'
                    + '<button data-fmt="print" onclick="doWrongExport(this.dataset.fmt)" style="margin-top:8px;width:100%;border:1px solid #e2e8f0;border-radius:16px;padding:12px;font-size:14px;font-weight:700;color:#334155;background:#fff">🖨️ 打印 / 存为 PDF</button>'
                    + '<button id="wrongExportCancel" onclick="closeWrongExportMenu()" style="margin-top:4px;width:100%;font-size:12px;color:#94a3b8;padding:8px;background:none;border:none">取消</button>'
                    + '</div>';
                document.body.appendChild(m);
            }
            var fc = window._wrongCourseId || null;
            var arr = getWrong()[wrongBookName()] || [];
            if (fc) arr = arr.filter(function(x) { return x.cid === fc; });
            document.getElementById('wrongExportTitle').innerText = tr("expWrongT");
            document.getElementById('wrongExportCancel').innerText = tr("cancel");
            document.getElementById('wrongExportSub').innerText = tf("wbExpSub", { name: wrongBookName(), n: arr.length }) + (fc ? tr("wbScopeOne") : tr("wbScopeAll"));
            m.style.display = 'flex';
        }
        function closeWrongExportMenu() {
            var m = document.getElementById('wrongExportModal');
            if (m) m.style.display = 'none';
        }
        function doWrongExport(fmt) {
            closeWrongExportMenu();
            var name = wrongBookName();
            var arr = getWrong()[name] || [];
            var fc = window._wrongCourseId || null;
            if (fc) arr = arr.filter(function(x) { return x.cid === fc; });
            if (!arr.length) { alert(tr("wbEmptyAlert")); return; }
            var fn = safeFileName(name + '的错题本');
            var pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
            if (fmt === 'html') downloadHTML(fn + '.html', buildWrongHTML(name, arr));
            else if (fmt === 'word') downloadBytes(fn + '.docx', buildWrongDocx(name, arr), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            else if (fmt === 'excel') downloadBytes(fn + '.xlsx', buildWrongXlsx(name, arr), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            else if (fmt === 'pptx1') downloadBytes(fn + '-单页版.pptx', buildWrongPptx(name, arr, 'single'), pptxMime);
            else if (fmt === 'pptx2') downloadBytes(fn + '-两页版.pptx', buildWrongPptx(name, arr, 'dual'), pptxMime);
            else if (fmt === 'print') printWrongs(name, arr);
        }
        function buildWrongHTML(name, arr) {
            var ds = wrongDateStr();
            var body = arr.map(function(x, i) {
                return '<section class="card"><h2>第' + (i + 1) + '题 <span style="font-size:13px;color:#6366f1;">' + esc(wrongTypeNum(x)) + '</span></h2>'
                    + (wrongMeta(x) ? '<p style="font-size:12px;color:#94a3b8;margin:-8px 0 10px;">' + esc(wrongMeta(x)) + '</p>' : '')
                    + '<div class="md"><p>' + (x.type === 'verse' ? '<span class="verse-text">' + esc(stripVerseTag(x.q)) + '</span>' : esc(x.q || '')) + '</p>'
                    + '<p>' + tr("wbU") + '<b style="color:#dc2626;">' + esc(x.u || tr("wbNA")) + '</b></p>'
                    + '<p>' + tr("rightAns") + '<b style="color:#059669;">' + esc(x.expected || '') + '</b></p></div></section>';
            }).join('');
            return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
                + '<meta name="viewport" content="width=device-width,initial-scale=1">'
                + '<title>' + esc(name) + '的错题本 - 团契智学</title><style>' + EXP_CSS + '</style></head>'
                + '<body><div class="wrap"><header class="hero"><div class="meta">团契智学 · 错题本</div>'
                + '<h1>' + esc(name) + '的错题本</h1><div class="date">共' + arr.length + '题 · 导出日期：' + ds + '</div></header>'
                + body + '<footer>由团契智学学习平台导出</footer></div></body></html>';
        }
        function buildWrongWordHTML(name, arr) {
            var h = buildWrongHTML(name, arr);
            h = h.split('<!DOCTYPE html>').join('');
            h = h.split('<meta name="viewport" content="width=device-width,initial-scale=1">').join('');
            h = h.split('<html lang="zh-CN">').join('<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">');
            var p1 = h.split('<style>');
            var p2 = p1[1].split('</style>');
            h = p1[0] + '<style>' + WORD_CSS + '</style>' + p2[1];
            return h;
        }
        function buildWrongXlsx(name, arr) {
            var te = new TextEncoder();
            var rows = [], rn = 1;
            rows.push('<row r="' + (rn++) + '">' + xlsxCell('A1', name + '的错题本（共' + arr.length + '题）', 1) + '</row>');
            rows.push('<row r="' + rn + '">'
                + xlsxCell(xlsxCol(1)+rn, '序号', 3) + xlsxCell(xlsxCol(2)+rn, '系列', 3)
                + xlsxCell(xlsxCol(3)+rn, '子栏目', 3) + xlsxCell(xlsxCol(4)+rn, '课件', 3)
                + xlsxCell(xlsxCol(5)+rn, '题型', 3) + xlsxCell(xlsxCol(6)+rn, '题目', 3)
                + xlsxCell(xlsxCol(7)+rn, '你的答案', 3) + xlsxCell(xlsxCol(8)+rn, '正确答案', 3) + '</row>'); rn++;
            arr.forEach(function(x, i) {
                var qtext = x.type === 'verse' ? stripVerseTag(x.q) : (x.q || '');
                rows.push('<row r="' + rn + '">'
                    + xlsxCell(xlsxCol(1)+rn, String(i+1), 0)
                    + xlsxCell(xlsxCol(2)+rn, x.series || '', 0)
                    + xlsxCell(xlsxCol(3)+rn, x.sub || '', 0)
                    + xlsxCell(xlsxCol(4)+rn, x.title || '', 0)
                    + xlsxCell(xlsxCol(5)+rn, WRONG_TYPE_LABEL[x.type] || x.type || '', 0)
                    + xlsxRichCell(xlsxCol(6)+rn, verseSegs(docxStrip(qtext)), 0)
                    + xlsxCell(xlsxCol(7)+rn, x.u || '', 0)
                    + xlsxCell(xlsxCol(8)+rn, x.expected || '', 0)
                    + '</row>'); rn++;
            });
            var HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
            var contentTypes = HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                + '<Default Extension="xml" ContentType="application/xml"/>'
                + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                + '</Types>';
            var rels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                + '</Relationships>';
            var wbRels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
                + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                + '</Relationships>';
            var workbook = HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                + '<sheets><sheet name="错题本" sheetId="1" r:id="rId1"/></sheets></workbook>';
            var styles = HEAD + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + '<fonts><font><sz val="11"/></font><font><b/><sz val="14"/><color rgb="FF1F4E79"/></font><font><sz val="11"/><color rgb="FF6D28D9"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><fill><patternFill><bgColor rgb="FF4F46E5"/></bgColor></patternFill></font></fonts>'
                + '<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
                + '<borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
                + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
                + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>'
                + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/>'
                + '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>';
            var sheet = HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + '<cols><col min="1" max="1" width="8"/><col min="2" max="4" width="16"/><col min="5" max="5" width="14"/><col min="6" max="6" width="50"/><col min="7" max="8" width="24"/></cols>'
                + '<sheetData>' + rows.join('') + '</sheetData></worksheet>';
            var files = [
                {name: '[Content_Types].xml', data: te.encode(contentTypes)},
                {name: '_rels/.rels', data: te.encode(rels)},
                {name: 'xl/_rels/workbook.xml.rels', data: te.encode(wbRels)},
                {name: 'xl/workbook.xml', data: te.encode(workbook)},
                {name: 'xl/styles.xml', data: te.encode(styles)},
                {name: 'xl/worksheets/sheet1.xml', data: te.encode(sheet)},
            ];
            return zipStored(files);
        }
        function buildWrongExcelHTML(name, arr) {
            var trs = arr.map(function(x, i) {
                return '<tr><td>' + (i + 1) + '</td><td>' + esc(x.series || '') + '</td><td>' + esc(x.sub || '') + '</td><td>' + esc(x.title || '') + '</td>'
                    + '<td>' + esc(WRONG_TYPE_LABEL[x.type] || x.type || '') + '</td><td>' + esc(x.n || '') + '</td>'
                    + '<td>' + esc(x.type === 'verse' ? stripVerseTag(x.q) : (x.q || '')) + '</td><td>' + esc(x.u || '') + '</td><td>' + esc(x.expected || '') + '</td></tr>';
            }).join('');
            return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">'
                + '<head><meta charset="utf-8"></head><body>'
                + '<h3>' + esc(name) + '的错题本（共' + arr.length + '题）</h3>'
                + '<table border="1" cellpadding="6" cellspacing="0"><tr><th>序号</th><th>系列</th><th>子栏目</th><th>课件</th><th>题型</th><th>题号</th><th>题目</th><th>你的答案</th><th>正确答案</th></tr>'
                + trs + '</table></body></html>';
        }
        function printWrongs(name, arr) {
            var w = window.open('', '_blank');
            if (!w) { alert(tr("popupBlocked")); return; }
            w.document.write(buildWrongHTML(name, arr));
            w.document.close();
            w.focus();
            setTimeout(function() { w.print(); }, 600);
        }
        function buildWrongPptx(name, arr, mode) {
            var te = new TextEncoder();
            var single = (mode === 'single');
            var slides = [{ t: [pptxPara(name + '的错题本', 4000, true)], b: [pptxPara('共' + arr.length + '题', 2000, false), pptxPara('团契智学', 1800, false)] }];
            arr.forEach(function(x, i) {
                var qParas = [pptxPara('【' + (WRONG_TYPE_LABEL[x.type] || x.type || '') + (x.n ? ' · 第' + x.n + '题' : '') + '】', 1800, true, '4F81BD')];
                if (wrongMeta(x)) qParas.push(pptxPara(wrongMeta(x), 1600, false, '64748B'));
                qParas.push(pptxPara(String(x.type === 'verse' ? stripVerseTag(x.q) : (x.q || '')), 1800, false));
                qParas.push(pptxPara(tr("wbU") + (x.u || tr("wbNA")), 1800, false, 'C0504D'));
                var ansParas = [pptxPara('【正确答案】', 1800, true, '047857'), pptxPara(String(x.expected || ''), 2000, false, '047857')];
                if (single) {
                    slides.push({ t: [pptxPara('第 ' + (i + 1) + ' 题', 3200, true)], b: qParas, a: ansParas });
                } else {
                    slides.push({ t: [pptxPara('第 ' + (i + 1) + ' 题', 3200, true)], b: qParas });
                    slides.push({ t: [pptxPara('第 ' + (i + 1) + ' 题 · 参考答案', 3200, true)], b: ansParas });
                }
            });
            var files = [];
            var addXml = function(nm, xml) { files.push({ name: nm, data: te.encode(xml) }); };
            var slideOverrides = slides.map(function(s, i) {
                return '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
            }).join('');
            addXml('[Content_Types].xml', PPTX_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' + slideOverrides + '</Types>');
            addXml('_rels/.rels', PPTX_ROOT_RELS);
            var sldIds = slides.map(function(s, i) { return '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>'; }).join('');
            addXml('ppt/presentation.xml', PPTX_HEAD + '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' + sldIds + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>');
            var presRels = slides.map(function(s, i) { return '<Relationship Id="rId' + (i + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>'; }).join('');
            addXml('ppt/_rels/presentation.xml.rels', PPTX_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' + presRels + '</Relationships>');
            addXml('ppt/slideMasters/slideMaster1.xml', PPTX_MASTER);
            addXml('ppt/slideMasters/_rels/slideMaster1.xml.rels', PPTX_MASTER_RELS);
            addXml('ppt/slideLayouts/slideLayout1.xml', PPTX_LAYOUT);
            addXml('ppt/slideLayouts/_rels/slideLayout1.xml.rels', PPTX_LAYOUT_RELS);
            addXml('ppt/theme/theme1.xml', PPTX_THEME);
            slides.forEach(function(s, i) {
                addXml('ppt/slides/slide' + (i + 1) + '.xml', pptxSlideXml(s.t, s.b, s.a));
                addXml('ppt/slides/_rels/slide' + (i + 1) + '.xml.rels', PPTX_SLIDE_RELS);
            });
            return zipStored(files);
        }
        /* ---- PPTX 生成（无压缩 zip + 最小 Office Open XML） ---- */
        function xmlEsc(s) {
            return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
        var CRC_T = null;
        function crc32Bytes(bytes) {
            if (!CRC_T) {
                CRC_T = new Int32Array(256);
                var n, k, cc;
                for (n = 0; n < 256; n++) {
                    cc = n;
                    for (k = 0; k < 8; k++) cc = (cc & 1) ? (0xEDB88320 ^ (cc >>> 1)) : (cc >>> 1);
                    CRC_T[n] = cc;
                }
            }
            var crc = 0xFFFFFFFF, i;
            for (i = 0; i < bytes.length; i++) crc = CRC_T[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
            return (crc ^ 0xFFFFFFFF) >>> 0;
        }
        function zipStored(files) {
            var te = new TextEncoder();
            var le16 = function(v) { return [v & 255, (v >> 8) & 255]; };
            var le32 = function(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255]; };
            var chunks = [], central = [], offset = 0;
            files.forEach(function(f) {
                var nb = te.encode(f.name), data = f.data, crc = crc32Bytes(data);
                var lh = [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
                    .concat(le32(crc), le32(data.length), le32(data.length), le16(nb.length), le16(0));
                var lhb = new Uint8Array(lh);
                chunks.push(lhb, nb, data);
                var ch = [0x50, 0x4B, 0x01, 0x02, 0x14, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
                    .concat(le32(crc), le32(data.length), le32(data.length), le16(nb.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset));
                central.push({ h: new Uint8Array(ch), n: nb });
                offset += lhb.length + nb.length + data.length;
            });
            var cs = offset, csize = 0;
            central.forEach(function(e) { chunks.push(e.h, e.n); csize += e.h.length + e.n.length; });
            var nf = files.length;
            var end = [0x50, 0x4B, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00].concat(le16(nf), le16(nf), le32(csize), le32(cs), le16(0));
            chunks.push(new Uint8Array(end));
            var total = 0;
            chunks.forEach(function(x) { total += x.length; });
            var out = new Uint8Array(total), p = 0;
            chunks.forEach(function(x) { out.set(x, p); p += x.length; });
            return out;
        }
        var PPTX_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
        var PPTX_SLIDE_RELS = PPTX_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>';
        var PPTX_MASTER = PPTX_HEAD + '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400" b="1"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';
        var PPTX_MASTER_RELS = PPTX_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>';
        var PPTX_LAYOUT = PPTX_HEAD + '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="titleAndContent" preserve="1"><p:cSld name="标题和内容"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>标题</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="内容"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>内容</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
        var PPTX_LAYOUT_RELS = PPTX_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>';
        var PPTX_THEME = PPTX_HEAD + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>';
        var PPTX_ROOT_RELS = PPTX_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>';
        function pptxRun(text, sz, bold, color) {
            var rpr = '<a:rPr lang="zh-CN" sz="' + sz + '"' + (bold ? ' b="1"' : '') + ' dirty="0"';
            if (color) rpr += '><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill></a:rPr>';
            else rpr += '/>';
            return '<a:r>' + rpr + '<a:t xml:space="preserve">' + text + '</a:t></a:r>';
        }
        function pptxPara(text, sz, bold, color) {
            return '<a:p>' + pptxRun(xmlEsc(text), sz, bold, color) + '</a:p>';
        }
        /* 经文分段着色：引用紫色加粗，经文正文深琥珀色 */
        function pptxRichPara(text, sz) {
            var segs = verseSegs(esc(text));
            var runs = segs.map(function(sg) {
                // k:0普通|1书名|2经文|3章节|4图标
                var color = null, hl = null, bold = false;
                if (sg.k === 1) { color = 'FFFFFF'; hl = '7C3AED'; bold = true; }
                else if (sg.k === 2) { color = '92400E'; hl = 'FEF3C7'; bold = true; }
                else if (sg.k === 3) { color = '1D4ED8'; hl = 'EFF6FF'; bold = true; }
                else if (sg.k === 4) { color = 'FFFFFF'; hl = 'D97706'; bold = true; }
                return pptxRun(sg.t, sz, bold, color, hl);
            });
            return '<a:p>' + runs.join('') + '</a:p>';
        }
        function pptxAnswerParas(q) {
            var t = q.type || 'fill';
            var ans = expAnswer(q);
            if (!ans) return null;
            var GREEN = '047857', label = '答案', text = ans;
            if (t === 'single' || t === 'multiple') { label = '正确答案'; text = '✓ ' + ans; }
            else if (t === 'judge') { label = '判断结果'; }
            else if (t === 'fill') { label = '填空答案'; }
            else if (t === 'essay') { label = '参考答案'; }
            else if (t === 'verse') { label = '经文答案'; }
            return [pptxPara('【' + label + '】', 1800, true, GREEN), pptxPara(text, 2000, false, GREEN)];
        }
        function pptxShape(id, name, ph, x, y, cx, cy, paras) {
            return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + name + '"/><p:cNvSpPr/><p:nvPr>' + ph + '</p:nvPr></p:nvSpPr>'
                + '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
                + '<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>' + paras.join('') + '</p:txBody></p:sp>';
        }
        function pptxSlideXml(titleParas, bodyParas, answerParas) {
            var hasAns = answerParas && answerParas.length;
            var bodyCy = hasAns ? 3000000 : 4521200;
            var shapes = pptxShape(2, '标题', '<p:ph type="title"/>', 685800, 342900, 10820400, 1143000, titleParas)
                + pptxShape(3, '内容', '<p:ph type="body" idx="1"/>', 685800, 1600200, 10820400, bodyCy, bodyParas);
            if (hasAns) {
                shapes += pptxShape(4, '答案', '', 685800, 4800200, 10820400, 1700000, answerParas);
            }
            return PPTX_HEAD + '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
                + '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
                + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
                + shapes + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
        }
        /* ---- 真正的 .docx 生成（ZIP+WordprocessingML，兼容移动Word） ---- */
        function docxEsc(s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
        function docxStrip(s) {
            // 去markdown但保留下划线填空线
            return String(s || "").replace(/[#>*~]/g, "").replace(/\\s+/g, " ").trim();
        }
        function docxRun(text, opts) {
            opts = opts || {};
            var rPr = '';
            if (opts.bold) rPr += '<w:b/>';
            if (opts.italic) rPr += '<w:i/>';
            if (opts.color) rPr += '<w:color w:val="' + opts.color + '"/>';
            if (opts.size) rPr += '<w:sz w:val="' + opts.size + '"/>';
            if (opts.highlight) rPr += '<w:highlight w:val="' + opts.highlight + '"/>';
            if (opts.shd) rPr += '<w:shd w:fill="' + opts.shd + '" w:val="clear"/>';
            if (opts.underline) rPr += '<w:u w:val="single"/>';
            if (rPr) rPr = '<w:rPr>' + rPr + '</w:rPr>';
            return '<w:r>' + rPr + '<w:t xml:space="preserve">' + docxEsc(text) + '</w:t></w:r>';
        }
        function docxPara(text, opts) {
            opts = opts || {};
            var pPr = '';
            if (opts.style) pPr += '<w:pStyle w:val="' + opts.style + '"/>';
            if (opts.align) pPr += '<w:jc w:val="' + opts.align + '"/>';
            if (opts.pShd) pPr += '<w:shd w:fill="' + opts.pShd + '" w:val="clear"/>';
            if (opts.spacing) pPr += '<w:spacing w:after="' + opts.spacing + '"/>';
            if (opts.border) pPr += '<w:pBdr><w:left w:val="single" w:sz="12" w:color="' + opts.border + '"/></w:pBdr>';
            if (pPr) pPr = '<w:pPr>' + pPr + '</w:pPr>';
            var rPr = '';
            if (opts.bold) rPr += '<w:b/>';
            if (opts.color) rPr += '<w:color w:val="' + opts.color + '"/>';
            if (opts.size) rPr += '<w:sz w:val="' + opts.size + '"/>';
            if (opts.highlight) rPr += '<w:highlight w:val="' + opts.highlight + '"/>';
            if (rPr) rPr = '<w:rPr>' + rPr + '</w:rPr>';
            // 处理换行
            var runs = String(text).split('\\n').map(function(line, i, arr) {
                var t = '<w:t xml:space="preserve">' + docxEsc(line) + '</w:t>';
                if (i < arr.length - 1) t += '<w:br/>';
                return '<w:r>' + rPr + t + '</w:r>';
            }).join('');
            return '<w:p>' + pPr + runs + '</w:p>';
        }
        function buildDocx(c) {
            var te = new TextEncoder();
            var qs = [], guide = [];
            try { qs = JSON.parse(c.quizzes_json || '[]'); } catch (e) {}
            try { guide = JSON.parse(c.guide_json || '[]'); } catch (e) {}
            var title = c.title || '未命名课件';
            var meta = [c.category, c.subcategory].filter(function(x) { return x; }).join(' · ');
            var now = new Date(), ds = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
            var body = '';
            // 标题
            body += docxPara(title, {style: 'Heading1', align: 'center', pShd: 'EDE9FE'});
            body += docxPara(meta, {align: 'center', color: '6D28D9', size: '20', bold: true});
            body += docxPara('导出日期：' + ds + ' · 团契智学', {align: 'center', color: '808080', size: '18'});
            body += docxPara('', {});
            // 导读
            if (c.content) {
                body += docxPara('课程导读', {style: 'Heading2'});
                body += docxPara(stripMd(c.content || ''), {});
            }
            // 导览
            var realGuide = guide.filter(function(g) { return g && (g.title || (g.points || []).length); });
            if (realGuide.length) {
                body += docxPara('课程导览', {style: 'Heading2'});
                realGuide.forEach(function(g, gi) {
                    body += '<w:p><w:pPr><w:spacing w:before="80" w:after="40"/></w:pPr>'
                        + docxRun((gi + 1) + ' ', {bold: true, color: 'FFFFFF', shd: '4F46E5', size: '22'})
                        + docxRun(' ' + (g.title || ''), {bold: true, color: '4C1D95', size: '24'})
                        + '</w:p>';
                    (g.points || []).forEach(function(pt) {
                        if (String(pt).trim()) body += docxPara('  •  ' + stripMd(String(pt)), {color: '475569'});
                    });
                });
            }
            // 题目
            var order = ['verse', 'fill', 'single', 'multiple', 'judge', 'essay'], groups = {};
            qs.forEach(function(q) { var t = q.type || 'fill'; (groups[t] = groups[t] || []).push(q); });
            var TYPE_LABEL = {verse: '经文诵读', fill: '填空题', single: '单项选择题', multiple: '多项选择题', judge: '判断题', essay: '问答与思辨'};
            order.forEach(function(t) {
                var list = groups[t] || [];
                if (!list.length) return;
                body += docxPara((TYPE_LABEL[t] || t) + '（共' + list.length + '题）', {style: 'Heading2'});
                list.forEach(function(q, qi) {
                    var rawQ = q.q || '';
                    if (t === 'verse' && rawQ.charAt(0) === '【') {
                        var ce = rawQ.indexOf('】');
                        if (ce > 0 && ce < 12) rawQ = rawQ.slice(ce + 1);
                    }
                    // 经文出处徽章行
                    var ref = q.o || q.h || '';
                    if (t === 'verse' && ref) {
                        var refText = stripEmoji(ref);
                        var badgeHtml = '<w:p><w:pPr><w:spacing w:after="40"/></w:pPr>'
                            + docxRun('📜 ', {})
                            + docxRun(refText, {bold: true, color: 'FFFFFF', shd: '7C3AED', size: '20'})
                            + '</w:p>';
                        body += badgeHtml;
                    }
                    var qtext = docxStrip(stripVerseTag(rawQ));
                    var bracket = (t === 'single' || t === 'multiple' || t === 'judge') ? '（ ）' : '';
                    // 题号+题干，多个run组合
                    var qp = '<w:p>';
                    if (t === 'verse') qp += '<w:pPr><w:shd w:fill="EFF6FF" w:val="clear"/><w:pBdr><w:left w:val="single" w:sz="18" w:color="3B82F6"/></w:pBdr><w:spacing w:after="80"/></w:pPr>';
                    else qp += '<w:pPr><w:spacing w:after="80"/></w:pPr>';
                    qp += docxRun((qi + 1) + '. ', {bold: true});
                    if (t === 'verse') {
                        qp += docxRun(qtext, {highlight: 'yellow', bold: true});
                    } else {
                        qp += docxRun(bracket + qtext, {bold: true});
                    }
                    qp += '</w:p>';
                    body += qp;
                    if (t === 'judge') {
                        body += docxPara('   √. 对', {color: '475569'});
                        body += docxPara('   ×. 错', {color: '475569'});
                    } else if ((t === 'single' || t === 'multiple') && q.o) {
                        var letters = ['A', 'B', 'C', 'D', 'E', 'F'];
                        String(q.o).split(',').forEach(function(opt, oi) {
                            body += docxPara('   ' + (letters[oi] || '') + '. ' + String(opt).trim(), {color: '475569'});
                        });
                    }
                    // 问答题：按答案长度留白
                    if (t === 'essay') {
                        var ansLen = 0;
                        try { ansLen = String(expAnswer(q) || '').length; } catch (e) {}
                        var wsLines = Math.max(3, Math.min(15, Math.ceil(ansLen / 30)));
                        for (var wli = 0; wli < wsLines; wli++) {
                            body += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="999999"/></w:pBdr><w:spacing w:after="40"/></w:pPr><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>';
                        }
                    }
                });
            });
            // 参考答案
            if (qs.length) {
                body += docxPara('参考答案', {style: 'Heading1'});
                order.forEach(function(t) {
                    var list = groups[t] || [];
                    if (!list.length) return;
                    body += docxPara(TYPE_LABEL[t] || t, {bold: true});
                    list.forEach(function(q, qi) {
                        var ans = '';
                        try { ans = expAnswer(q) || ''; } catch (e) {}
                        body += docxPara((qi + 1) + '. ' + ans, {color: '047857'});
                    });
                });
            }
            var HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
            var contentTypes = HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                + '<Default Extension="xml" ContentType="application/xml"/>'
                + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                + '</Types>';
            var rels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                + '</Relationships>';
            var docRels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
            var styles = HEAD + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="1F4E79"/></w:rPr></w:style>'
                + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="120" w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="4C1D95"/></w:rPr></w:style>'
                + '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>'
                + '</w:styles>';
            var document = HEAD + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                + '<w:body>' + body
                + '<w:sectPr><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
                + '</w:body></w:document>';
            var files = [
                {name: '[Content_Types].xml', data: te.encode(contentTypes)},
                {name: '_rels/.rels', data: te.encode(rels)},
                {name: 'word/_rels/document.xml.rels', data: te.encode(docRels)},
                {name: 'word/styles.xml', data: te.encode(styles)},
                {name: 'word/document.xml', data: te.encode(document)},
            ];
            return zipStored(files);
        }
        function buildWrongDocx(name, arr) {
            var te = new TextEncoder();
            var ds = wrongDateStr();
            var body = docxPara(name + '的错题本', {style: 'Heading1', align: 'center'});
            body += docxPara('共' + arr.length + '题 · ' + ds, {align: 'center', color: '808080', size: '20'});
            arr.forEach(function(x, i) {
                body += docxPara('第' + (i + 1) + '题 · ' + (WRONG_TYPE_LABEL[x.type] || x.type || ''), {style: 'Heading2'});
                if (wrongMeta(x)) body += docxPara(wrongMeta(x), {color: '808080', size: '20'});
                var qtext = x.type === 'verse' ? stripVerseTag(x.q) : (x.q || '');
                body += docxPara(stripMd(qtext), x.type === 'verse' ? {highlight: 'yellow'} : {});
                body += docxPara('你的答案：' + (x.u || '未作答'), {color: 'C0504D'});
                body += docxPara('正确答案：' + (x.expected || ''), {color: '047857'});
            });
            var HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
            var contentTypes = HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                + '<Default Extension="xml" ContentType="application/xml"/>'
                + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                + '</Types>';
            var rels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                + '</Relationships>';
            var docRels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
            var styles = HEAD + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="1F4E79"/></w:rPr></w:style>'
                + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="4C1D95"/></w:rPr></w:style>'
                + '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>'
                + '</w:styles>';
            var document = HEAD + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                + '<w:body>' + body
                + '<w:sectPr><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
                + '</w:body></w:document>';
            var files = [
                {name: '[Content_Types].xml', data: te.encode(contentTypes)},
                {name: '_rels/.rels', data: te.encode(rels)},
                {name: 'word/_rels/document.xml.rels', data: te.encode(docRels)},
                {name: 'word/styles.xml', data: te.encode(styles)},
                {name: 'word/document.xml', data: te.encode(document)},
            ];
            return zipStored(files);
        }
        /* ---- 真正的 .xlsx 生成 ---- */
        function xlsxEsc(s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        function xlsxCell(ref, text, style) {
            var s = style ? ' s="' + style + '"' : '';
            return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xlsxEsc(text) + '</t></is></c>';
        }
        function xlsxRichCell(ref, segs, style) {
            var s = style ? ' s="' + style + '"' : '';
            var runs = segs.map(function(sg) {
                var rpr = '';
                if (sg.k === 1) rpr = '<rPr><b/><color rgb="FFFFFFFF"/><sz val="11"/></rPr>';
                else if (sg.k === 2) rpr = '<rPr><b/><color rgb="FF92400E"/><sz val="11"/></rPr>';
                else if (sg.k === 3) rpr = '<rPr><b/><color rgb="FF1D4ED8"/><sz val="11"/></rPr>';
                else if (sg.k === 4) rpr = '<rPr><b/><color rgb="FFFFFFFF"/><sz val="11"/></rPr>';
                else rpr = '<rPr><sz val="11"/></rPr>';
                return '<r>' + rpr + '<t xml:space="preserve">' + xlsxEsc(sg.t) + '</t></r>';
            }).join('');
            return '<c r="' + ref + '"' + s + ' t="inlineStr"><is>' + runs + '</is></c>';
        }
        function xlsxCol(n) {
            var s = '';
            while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
            return s;
        }
        function buildXlsx(c) {
            var te = new TextEncoder();
            var qs = [], guide = [];
            try { qs = JSON.parse(c.quizzes_json || '[]'); } catch (e) {}
            try { guide = JSON.parse(c.guide_json || '[]'); } catch (e) {}
            var rows = [];
            var rn = 1;
            // 标题行
            rows.push('<row r="' + (rn++) + '">' + xlsxCell('A1', c.title || '', 1) + '</row>');
            rows.push('<row r="' + (rn++) + '">' + xlsxCell('A2', [c.category, c.subcategory].filter(function(x){return x;}).join(' · '), 2) + '</row>');
            rows.push('<row r="' + (rn++) + '"></row>');
            // 导览
            var realGuide = guide.filter(function(g) { return g && (g.title || (g.points || []).length); });
            if (realGuide.length) {
                rows.push('<row r="' + rn + '">' + xlsxCell(xlsxCol(1)+rn, '课程导览', 1) + '</row>'); rn++;
                rows.push('<row r="' + rn + '">' + xlsxCell(xlsxCol(1)+rn, '序号', 3) + xlsxCell(xlsxCol(2)+rn, '章节', 3) + xlsxCell(xlsxCol(3)+rn, '要点', 3) + '</row>'); rn++;
                realGuide.forEach(function(g, gi) {
                    var pts = (g.points || []).filter(function(x){return String(x).trim();}).join('；');
                    rows.push('<row r="' + rn + '">' + xlsxCell(xlsxCol(1)+rn, String(gi+1), 0) + xlsxCell(xlsxCol(2)+rn, stripMd(g.title||''), 0) + xlsxRichCell(xlsxCol(3)+rn, verseSegs(stripMd(pts)), 0) + '</row>'); rn++;
                });
                rows.push('<row r="' + (rn++) + '"></row>');
            }
            // 题库表头
            var TYPE_PLAIN = {verse: '经文诵读', fill: '填空题', single: '单选题', multiple: '多选题', judge: '判断题', essay: '问答题'};
            rows.push('<row r="' + rn + '">' + xlsxCell(xlsxCol(1)+rn, '题库', 1) + '</row>'); rn++;
            rows.push('<row r="' + rn + '">'
                + xlsxCell(xlsxCol(1)+rn, '序号', 3) + xlsxCell(xlsxCol(2)+rn, '题型', 3)
                + xlsxCell(xlsxCol(3)+rn, '题目', 3) + xlsxCell(xlsxCol(4)+rn, '经文出处', 3)
                + xlsxCell(xlsxCol(5)+rn, '答案', 3) + '</row>'); rn++;
            qs.forEach(function(q, i) {
                var t = q.type || 'fill';
                var qq = q.q || '';
                if (t === 'verse' && qq.charAt(0) === '【') {
                    var ce = qq.indexOf('】');
                    if (ce > 0 && ce < 12) qq = qq.slice(ce + 1);
                }
                var ans = '';
                try { ans = expAnswer(q) || ''; } catch (e) {}
                var bracket = (t === 'single' || t === 'multiple' || t === 'judge') ? '（ ）' : '';
                rows.push('<row r="' + rn + '">'
                    + xlsxCell(xlsxCol(1)+rn, String(i+1), 0)
                    + xlsxCell(xlsxCol(2)+rn, TYPE_PLAIN[t] || t, 0)
                    + xlsxRichCell(xlsxCol(3)+rn, verseSegs(docxStrip(stripVerseTag(bracket + qq))), 0)
                    + xlsxRichCell(xlsxCol(4)+rn, verseSegs(stripEmoji(q.o || q.h || '')), 0)
                    + xlsxCell(xlsxCol(5)+rn, ans, 0)
                    + '</row>'); rn++;
            });
            var HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
            var contentTypes = HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                + '<Default Extension="xml" ContentType="application/xml"/>'
                + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                + '</Types>';
            var rels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                + '</Relationships>';
            var wbRels = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
                + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                + '</Relationships>';
            var workbook = HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                + '<sheets><sheet name="题库" sheetId="1" r:id="rId1"/></sheets></workbook>';
            var styles = HEAD + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + '<fonts><font><sz val="11"/></font><font><b/><sz val="14"/><color rgb="FF1F4E79"/></font><font><sz val="11"/><color rgb="FF6D28D9"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><fill><patternFill><bgColor rgb="FF4F46E5"/></bgColor></patternFill></font></fonts>'
                + '<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
                + '<borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
                + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                + '<cellXfs count="4">'
                + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
                + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>'
                + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/>'
                + '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0"/>'
                + '</cellXfs></styleSheet>';
            var sheet = HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
                + '<cols><col min="1" max="1" width="8"/><col min="2" max="2" width="14"/><col min="3" max="3" width="60"/><col min="4" max="4" width="22"/><col min="5" max="5" width="30"/></cols>'
                + '<sheetData>' + rows.join('') + '</sheetData></worksheet>';
            var files = [
                {name: '[Content_Types].xml', data: te.encode(contentTypes)},
                {name: '_rels/.rels', data: te.encode(rels)},
                {name: 'xl/_rels/workbook.xml.rels', data: te.encode(wbRels)},
                {name: 'xl/workbook.xml', data: te.encode(workbook)},
                {name: 'xl/styles.xml', data: te.encode(styles)},
                {name: 'xl/worksheets/sheet1.xml', data: te.encode(sheet)},
            ];
            return zipStored(files);
        }
        function buildPptx(c, mode) {
            var qs = [];
            try { qs = JSON.parse(c.quizzes_json || '[]'); } catch (e) {}
            var te = new TextEncoder();
            var meta = [c.category, c.subcategory].filter(function(x) { return x; }).join(' · ');
            var slides = [{ t: [pptxPara(c.title || '未命名课件', 4000, true)], b: [pptxPara(meta, 2000, false), pptxPara('团契智学', 1800, false)] }];
            if (c.content) {
                var plain = stripMd(c.content);
                slides.push({ t: [pptxPara('课程导读', 3200, true)], b: [pptxPara(plain.slice(0, 1500), 1800, false)] });
            }
            var pGuide = [];
            try { pGuide = JSON.parse(c.guide_json || '[]'); } catch (e) {}
            pGuide.forEach(function(g, gi) {
                if (!g) return;
                var pts = (g.points || []).filter(function(x) { return String(x).trim(); });
                if (!g.title && !pts.length) return;
                slides.push({
                    t: [pptxPara('课程导览 · ' + (g.title || ('第' + (gi + 1) + '章')), 3200, true)],
                    b: pts.map(function(x) { return pptxRichPara('• ' + String(x).trim(), 1800); })
                });
            });
            var single = (mode === 'single');
            qs.forEach(function(q, i) {
                var t = q.type || 'fill';
                var bracket = (t === 'single' || t === 'multiple' || t === 'judge') ? '（ ）' : '';
                var lines = ['【' + (EXP_TYPE_PLAIN[t] || '') + '】' + bracket + (q.q || '')];
                if (t === 'judge') {
                    lines.push('√. 对'); lines.push('×. 错');
                } else if ((t === 'single' || t === 'multiple') && q.o) {
                    var letters = ['A', 'B', 'C', 'D', 'E', 'F'];
                    String(q.o).split(',').forEach(function(o, oi) { lines.push((letters[oi] || '') + '. ' + String(o).trim()); });
                }
                var qParas = lines.map(function(ln) { return pptxRichPara(ln, 1800); });
                var ansParas = pptxAnswerParas(q);
                if (single) {
                    slides.push({
                        t: [pptxPara('第 ' + (i + 1) + ' 题', 3200, true)],
                        b: qParas,
                        a: ansParas
                    });
                } else {
                    slides.push({
                        t: [pptxPara('第 ' + (i + 1) + ' 题', 3200, true)],
                        b: qParas
                    });
                    if (ansParas) {
                        slides.push({
                            t: [pptxPara('第 ' + (i + 1) + ' 题 · 参考答案', 3200, true)],
                            b: ansParas
                        });
                    }
                }
            });
            var files = [];
            var addXml = function(name, xml) { files.push({ name: name, data: te.encode(xml) }); };
            var slideOverrides = slides.map(function(s, i) {
                return '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
            }).join('');
            addXml('[Content_Types].xml', PPTX_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' + slideOverrides + '</Types>');
            addXml('_rels/.rels', PPTX_ROOT_RELS);
            var sldIds = slides.map(function(s, i) { return '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>'; }).join('');
            addXml('ppt/presentation.xml', PPTX_HEAD + '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' + sldIds + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>');
            var presRels = slides.map(function(s, i) { return '<Relationship Id="rId' + (i + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>'; }).join('');
            addXml('ppt/_rels/presentation.xml.rels', PPTX_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' + presRels + '</Relationships>');
            addXml('ppt/slideMasters/slideMaster1.xml', PPTX_MASTER);
            addXml('ppt/slideMasters/_rels/slideMaster1.xml.rels', PPTX_MASTER_RELS);
            addXml('ppt/slideLayouts/slideLayout1.xml', PPTX_LAYOUT);
            addXml('ppt/slideLayouts/_rels/slideLayout1.xml.rels', PPTX_LAYOUT_RELS);
            addXml('ppt/theme/theme1.xml', PPTX_THEME);
            slides.forEach(function(s, i) {
                addXml('ppt/slides/slide' + (i + 1) + '.xml', pptxSlideXml(s.t, s.b, s.a));
                addXml('ppt/slides/_rels/slide' + (i + 1) + '.xml.rels', PPTX_SLIDE_RELS);
            });
            return zipStored(files);
        }

        /* 教师管理密码门（服务端会话） */
        function hideAdminErr() { var e = document.getElementById('adminErr'); if (e) e.classList.add('hidden'); }
        function showAdminErr(msg) { var e = document.getElementById('adminErr'); if (e) { e.innerText = msg; e.classList.remove('hidden'); } }
        async function adminLogin() {
            var p = document.getElementById('adminPwd').value;
            hideAdminErr();
            if (!p) { showAdminErr('请输入管理密码'); return; }
            var r = await fetch('/api/verify', { method: 'POST', body: JSON.stringify({ password: p }) });
            var j = await r.json();
            if (j.ok) { sessionStorage.setItem('TQ_ADMIN_OK', '1'); location.reload(); }
            else showAdminErr('密码错误，请重试');
        }

        /* 教师版：查看本课全部正确答案（需管理会话） */
        async function teacherUnlock() {
            if (!document.getElementById('teacherBtn')) return;
            renderAllQTypeTabs();
            if (teacherMode) {
                teacherMode = false;
                document.querySelectorAll('.tch-box').forEach(function(el) { el.remove(); });
                document.getElementById('teacherBtn').innerText = tr("teacherBtn");
                return;
            }
            var ansUrl = '/api/answers?course_id=' + encodeURIComponent(activeLessonId || "") + '&lang=' + encodeURIComponent(curLang());
            var isStuAdmin = !BOOT.isAdmin && studentIsAdmin();
            if (isStuAdmin) ansUrl += '&username=' + encodeURIComponent(progName()) + '&token=' + encodeURIComponent(studentToken());
            var r = await fetch(ansUrl);
            if (r.status === 403) {
                if (isStuAdmin) { alert(tr("tchExpired")); return; }
                var p = prompt(tr("tchPwPrompt"));
                if (!p) return;
                var v = await fetch('/api/verify', { method: 'POST', body: JSON.stringify({ password: p }) });
                var j = await v.json();
                if (!j.ok) { alert(tr("tchPwWrong")); return; }
                r = await fetch(ansUrl);
            }
            if (!r.ok) { alert(tr("tchAnsFail")); return; }
            var qs = (await r.json()).quizzes || [];
            teacherMode = true;
            activeQuizzes.forEach(function(q, i) {
                var card = document.getElementById('qcard-' + i);
                if (!card || card.querySelector('.tch-box')) return;
                var div = document.createElement('div');
                div.className = 'tch-box mt-4 pt-4 border-t border-dashed border-amber-300 text-sm';
                div.innerHTML = '<span class="font-bold text-amber-700">' + tr("tchAnsT") + '</span>'
                    + '<span class="text-slate-700 font-bold">' + (esc((qs[i] || {}).a) || tr("tchOpenAns")) + '</span>';
                card.appendChild(div);
            });
            document.getElementById('teacherBtn').innerText = tr("teacherExit");
        }

        /* 管理端：智能解析 / 题目行 / 保存 */
        function smartParse() {
            var raw = document.getElementById('importText').value;
            var lines = raw.split('\\n');
            var type = 'essay', section = "";
            lines.forEach(function(line) {
                line = line.trim();
                if (!line) return;
                if (/^##\\\s*/.test(line)) { section = line.replace(/^##\\\s*/, '').trim(); return; }
                if (line.length < 30) {
                    if (line.indexOf('填空') >= 0) type = 'fill';
                    else if (line.indexOf('多选') >= 0) type = 'multiple';
                    else if (line.indexOf('选择') >= 0) type = 'single';
                    else if (line.indexOf('判断') >= 0) type = 'judge';
                    else if (line.indexOf('问答') >= 0 || line.indexOf('简答') >= 0 || line.indexOf('讨论') >= 0) type = 'essay';
                }
                if (/^\\\d+[\\\.、]/.test(line)) {
                    var pq = line.replace(/^\\\d+[\\\.、]/, '').trim();
                    var ptype = /_{4,}|＿{2,}/.test(pq) ? 'fill' : type;
                    addQuizRow({ type: ptype, q: pq, o: '', a: '', s: section });
                } else if (/^[A-D][\\\.、]/.test(line)) {
                    var items = document.querySelectorAll('.quiz-item');
                    if (items.length > 0) {
                        var oIn = items[items.length - 1].querySelector('.q-o');
                        oIn.classList.remove('hidden');
                        oIn.value += (oIn.value ? ',' : '') + line;
                    }
                }
            });
        }
        function addQuizRow(d) {
            d = d || { type: 'single', q: '', o: '', a: '', s: '' };
            var div = document.createElement('div');
            div.className = 'quiz-item p-4 bg-slate-50 rounded-2xl border relative';
            div.innerHTML = '<button onclick="this.parentElement.remove()" class="absolute top-1 right-2 text-slate-300">✕</button>'
                + '<select class="q-type bg-white border rounded text-[10px] mb-2" onchange="this.parentElement.querySelector(\\'.q-o\\').classList.toggle(\\'hidden\\', !(this.value===\\'single\\'||this.value===\\'multiple\\'||this.value===\\'verse\\'))">'
                + '<option value="single"' + (d.type === 'single' ? ' selected' : '') + '>选择</option>'
                + '<option value="multiple"' + (d.type === 'multiple' ? ' selected' : '') + '>多选</option>'
                + '<option value="fill"' + (d.type === 'fill' ? ' selected' : '') + '>填空</option>'
                + '<option value="judge"' + (d.type === 'judge' ? ' selected' : '') + '>判断</option>'
                + '<option value="essay"' + (d.type === 'essay' ? ' selected' : '') + '>问答</option>'
                + '<option value="verse"' + (d.type === 'verse' ? ' selected' : '') + '>经文框</option></select>'
                + '<input class="q-s w-full border-b bg-transparent text-[10px] p-1 mb-2" value="' + esc(d.s) + '" placeholder="章节名（有章节自动分组，可空）">'
                + '<input class="q-q w-full border-b bg-transparent text-xs p-1 mb-2" value="' + esc(d.q) + '" placeholder="题目内容（填空用 ____ 占位，下划线越多空格越宽）">'
                + '<input class="q-o w-full border-b bg-transparent text-[10px] p-1 mb-2' + (d.type === 'single' || d.type === 'multiple' || d.type === 'verse' ? '' : ' hidden') + '" value="' + esc(d.o) + '" placeholder="选项 A.xxx, B.xxx（经文框时填框标题，如 📖 罗马书 1:20）">'
                + '<input class="q-a w-full bg-indigo-100/50 border-none rounded p-1 text-xs font-bold text-indigo-700" value="' + esc(d.a) + '" placeholder="正确答案（填空：|/；分空，/或“或”分同空多答案，如 失败/软弱；互动关系；多选如 A|C）">';
            document.getElementById('quizList').appendChild(div);
        }
        /* 课程导览（思维导图式）结构化编辑器 */
        var guideData = [];
        function renderGuideEditor() {
            var box = document.getElementById('guideEditor');
            if (!box) return;
            var h = '';
            guideData.forEach(function(ch, ci) {
                h += '<div class="bg-white border border-slate-200 rounded-xl p-3">'
                    + '<div class="flex items-center gap-2 mb-2">'
                    + '<span class="w-6 h-6 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center text-xs font-black shrink-0">' + (ci + 1) + '</span>'
                    + '<input class="g-title flex-1 min-w-0 border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm font-bold" data-ch="' + ci + '" placeholder="章节标题，如：1. 苦难的起源与分类" value="' + esc(ch.title) + '">'
                    + '<button class="g-up text-[11px] px-2 py-1 rounded-lg bg-slate-100 text-slate-500 font-bold" data-ch="' + ci + '" title="上移">↑</button>'
                    + '<button class="g-down text-[11px] px-2 py-1 rounded-lg bg-slate-100 text-slate-500 font-bold" data-ch="' + ci + '" title="下移">↓</button>'
                    + '<button class="g-delch text-[11px] px-2 py-1 rounded-lg bg-red-50 text-red-500 font-bold" data-ch="' + ci + '">删除</button>'
                    + '</div><div class="space-y-1.5 ml-8">'
                    + (ch.points || []).map(function(p, pi) {
                        return '<div class="flex items-center gap-2">'
                            + '<span class="text-slate-300 text-xs shrink-0">•</span>'
                            + '<input class="g-point flex-1 min-w-0 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs" data-ch="' + ci + '" data-pt="' + pi + '" placeholder="要点小结…" value="' + esc(p) + '">'
                            + '<button class="g-delpt text-[11px] px-2 py-1 rounded-lg bg-slate-50 text-slate-400 font-bold" data-ch="' + ci + '" data-pt="' + pi + '">✕</button>'
                            + '</div>';
                    }).join('')
                    + '<button class="g-addpt text-[11px] text-indigo-600 font-bold mt-1" data-ch="' + ci + '">+ 添加要点</button>'
                    + '</div></div>';
            });
            if (!guideData.length) h = '<div class="text-xs text-slate-400 text-center py-3">暂无章节，点击右上角"+ 添加章节"开始。</div>';
            box.innerHTML = h;
        }
        function initGuideEditor() {
            var addBtn = document.getElementById('guideAddCh');
            var box = document.getElementById('guideEditor');
            if (!addBtn || !box || addBtn.dataset.wired) return;
            addBtn.dataset.wired = '1';
            addBtn.addEventListener('click', function() { guideData.push({ title: '', points: [''] }); renderGuideEditor(); });
            box.addEventListener('click', function(e) {
                var t = e.target.closest ? e.target.closest('button') : null;
                if (!t) return;
                var ci = parseInt(t.getAttribute('data-ch'), 10);
                if (isNaN(ci) || !guideData[ci]) return;
                if (t.classList.contains('g-addpt')) guideData[ci].points.push('');
                else if (t.classList.contains('g-delpt')) guideData[ci].points.splice(parseInt(t.getAttribute('data-pt'), 10), 1);
                else if (t.classList.contains('g-delch')) { if (!confirm('删除该章节？')) return; guideData.splice(ci, 1); }
                else if (t.classList.contains('g-up')) { if (ci > 0) { var au = guideData[ci - 1]; guideData[ci - 1] = guideData[ci]; guideData[ci] = au; } }
                else if (t.classList.contains('g-down')) { if (ci < guideData.length - 1) { var ad = guideData[ci + 1]; guideData[ci + 1] = guideData[ci]; guideData[ci] = ad; } }
                else return;
                renderGuideEditor();
            });
            box.addEventListener('input', function(e) {
                var t = e.target;
                if (!t.getAttribute) return;
                var ci = parseInt(t.getAttribute('data-ch'), 10);
                if (isNaN(ci) || !guideData[ci]) return;
                if (t.classList.contains('g-title')) guideData[ci].title = t.value;
                else if (t.classList.contains('g-point')) { var pi = parseInt(t.getAttribute('data-pt'), 10); guideData[ci].points[pi] = t.value; }
            });
        }
        /* 课程导览：可视化 / JSON 代码双模式 */
        var guideEditMode = 'visual';
        function setGuideMode(m) {
            var toJson = (m === 'json');
            if (toJson) {
                try { document.getElementById('guideJson').value = JSON.stringify(guideData, null, 2); }
                catch (e) { alert('序列化失败'); return; }
            } else {
                var raw = document.getElementById('guideJson').value.trim();
                if (raw) {
                    var arr;
                    try { arr = JSON.parse(raw); } catch (e) { alert('JSON 格式错误：' + e.message); return; }
                    if (!Array.isArray(arr)) { alert('JSON 顶层必须是数组'); return; }
                    guideData = arr.map(function(g) { return { title: (g && g.title) || '', points: Array.isArray(g && g.points) ? g.points.slice() : [] }; });
                    renderGuideEditor();
                }
            }
            guideEditMode = m;
            document.getElementById('guideEditor').classList.toggle('hidden', toJson);
            document.getElementById('guideJson').classList.toggle('hidden', !toJson);
            document.getElementById('guideAddCh').classList.toggle('hidden', toJson);
            document.getElementById('gModeVisual').className = 'px-2.5 py-1 rounded-md' + (toJson ? ' text-slate-500' : ' bg-indigo-600 text-white shadow');
            document.getElementById('gModeJson').className = 'px-2.5 py-1 rounded-md' + (toJson ? ' bg-indigo-600 text-white shadow' : ' text-slate-500');
        }
        function initGuideMode() {
            var bv = document.getElementById('gModeVisual');
            if (!bv || bv.dataset.wired) return;
            bv.dataset.wired = '1';
            bv.addEventListener('click', function() { setGuideMode('visual'); });
            document.getElementById('gModeJson').addEventListener('click', function() { setGuideMode('json'); });
        }
        /* 题目编辑：可视化 / JSON 代码双模式 */
        var quizEditMode = 'visual';
        function collectQuizRows() {
            var rows = document.querySelectorAll('.quiz-item');
            return Array.prototype.map.call(rows, function(r) {
                return {
                    type: r.querySelector('.q-type').value,
                    s: r.querySelector('.q-s').value,
                    q: r.querySelector('.q-q').value,
                    o: r.querySelector('.q-o').value,
                    a: r.querySelector('.q-a').value
                };
            });
        }
        function setQuizMode(m) {
            var toJson = (m === 'json');
            if (toJson) {
                try { document.getElementById('quizJson').value = JSON.stringify(collectQuizRows(), null, 2); }
                catch (e) { alert('序列化失败'); return; }
            } else {
                var raw = document.getElementById('quizJson').value.trim();
                if (raw) {
                    var arr;
                    try { arr = JSON.parse(raw); } catch (e) { alert('JSON 格式错误：' + e.message); return; }
                    if (!Array.isArray(arr)) { alert('JSON 顶层必须是数组'); return; }
                    document.getElementById('quizList').innerHTML = '';
                    arr.forEach(function(q) { addQuizRow(q); });
                }
            }
            quizEditMode = m;
            document.getElementById('quizList').classList.toggle('hidden', toJson);
            document.getElementById('quizJson').classList.toggle('hidden', !toJson);
            document.getElementById('qJsonFormat').classList.toggle('hidden', !toJson);
            document.getElementById('qModeVisual').className = 'px-3 py-1.5 rounded-md' + (toJson ? ' text-slate-500' : ' bg-white shadow text-indigo-700');
            document.getElementById('qModeJson').className = 'px-3 py-1.5 rounded-md' + (toJson ? ' bg-white shadow text-indigo-700' : ' text-slate-500');
        }
        function initQuizMode() {
            var bv = document.getElementById('qModeVisual');
            if (!bv || bv.dataset.wired) return;
            bv.dataset.wired = '1';
            bv.addEventListener('click', function() { setQuizMode('visual'); });
            document.getElementById('qModeJson').addEventListener('click', function() { setQuizMode('json'); });
            document.getElementById('qJsonFormat').addEventListener('click', function() {
                try { document.getElementById('quizJson').value = JSON.stringify(JSON.parse(document.getElementById('quizJson').value), null, 2); }
                catch (e) { alert('JSON 格式错误：' + e.message); }
            });
        }
        async function saveAll() {
            var quizzes;
            if (quizEditMode === 'json') {
                try {
                    quizzes = JSON.parse(document.getElementById('quizJson').value.trim() || '[]');
                    if (!Array.isArray(quizzes)) { alert('题目 JSON 顶层必须是数组'); return; }
                } catch (e) { alert('题目 JSON 格式错误：' + e.message); return; }
            } else {
                quizzes = collectQuizRows();
            }
            var guideVal;
            if (guideEditMode === 'json') {
                try {
                    guideVal = JSON.parse(document.getElementById('guideJson').value.trim() || '[]');
                    if (!Array.isArray(guideVal)) { alert('课程导览 JSON 顶层必须是数组'); return; }
                } catch (e) { alert('课程导览 JSON 格式错误：' + e.message); return; }
            } else {
                guideVal = guideData;
            }
            var sv = document.getElementById('f_series').value;
            var series = sv === '__new__' ? document.getElementById('f_series_new').value.trim() : sv;
            var uv = document.getElementById('f_sub').value;
            var sub = uv === '__new__' ? document.getElementById('f_sub_new').value.trim().split('+').join('•') : (uv || "");
            if (!series) { alert("请选择或新建一个系列"); return; }
            var b = { id: document.getElementById('f_id').value, category: series, subcategory: sub, title: document.getElementById('f_title').value, content: document.getElementById('f_content').value, video_url: document.getElementById('f_video').value, guide: guideVal, instructions: document.getElementById('f_instructions').value, quizzes: quizzes };
            var r = await fetch('/api/save', { method: 'POST', body: JSON.stringify(b) });
            if (r.status === 403) { alert("请先登录管理端后再发布"); return; }
            if (r.ok) location.reload(); else alert("保存失败");
        }
        function openEditModal() { if (window.innerWidth < 768) switchEmTab('info');
            document.getElementById('f_id').value = ""; document.getElementById('f_video').value = ""; document.getElementById('f_instructions').value = ""; document.getElementById('f_series_new').value = ""; document.getElementById('f_sub_new').value = ""; document.getElementById('quizList').innerHTML = ""; guideData = []; initGuideEditor(); renderGuideEditor(); renderCatForm(); addQuizRow(); document.getElementById('quizJson').value = ""; initQuizMode(); setQuizMode('visual'); document.getElementById('guideJson').value = ""; initGuideMode(); setGuideMode('visual'); toggleModal('editModal'); }
        async function editCourse(id) {
            var item = null;
            for (var k = 0; k < allData.length; k++) { if (allData[k].id === id) { item = allData[k]; break; } }
            if (!item) return;
            document.getElementById('f_id').value = item.id; document.getElementById('f_title').value = item.title; document.getElementById('f_content').value = item.content; document.getElementById('f_video').value = item.video_url || ""; document.getElementById('f_instructions').value = item.instructions || "";
            document.getElementById('f_series_new').value = ""; document.getElementById('f_sub_new').value = "";
            renderCatForm();
            var ss = document.getElementById('f_series'), hasSeries = false, si;
            for (si = 0; si < ss.options.length; si++) { if (ss.options[si].value === item.category) { hasSeries = true; break; } }
            if (!hasSeries && item.category) {
                var op0 = document.createElement('option'); op0.value = item.category; op0.text = item.category;
                ss.insertBefore(op0, ss.lastChild);
            }
            ss.value = item.category || "";
            onSeriesChange();
            var sel = document.getElementById('f_sub'), hasSub = false, sj;
            for (sj = 0; sj < sel.options.length; sj++) { if (sel.options[sj].value === (item.subcategory || "")) { hasSub = true; break; } }
            if (!hasSub && item.subcategory) {
                var op1 = document.createElement('option'); op1.value = item.subcategory; op1.text = item.subcategory;
                sel.insertBefore(op1, sel.lastChild);
            }
            sel.value = item.subcategory || "";
            sel.onchange();
            document.getElementById('quizList').innerHTML = ""; var qz = []; try { qz = JSON.parse(item.quizzes_json || "[]"); } catch (e) { alert("题库数据损坏，已用空题库打开"); } qz.forEach(function(q) { addQuizRow(q); });
            try { var _gd = JSON.parse(item.guide_json || "[]"); guideData = (Array.isArray(_gd) ? _gd : []).map(function(g) { return { title: g.title || "", points: Array.isArray(g.points) ? g.points.slice() : [] }; }); } catch (e) { guideData = []; }
            initGuideEditor(); renderGuideEditor(); document.getElementById('quizJson').value = ""; initQuizMode(); setQuizMode('visual'); document.getElementById('guideJson').value = ""; initGuideMode(); setGuideMode('visual'); toggleModal('editModal');
        }
        async function deleteCourse(id) {
            if (!confirm("确定删除？")) return;
            var r = await fetch('/api/delete', { method: 'POST', body: JSON.stringify({ id: id }) });
            if (r.status === 403) { alert("请先登录管理端"); return; }
            if (r.ok) location.reload(); else alert("删除失败");
        }
        async function moveCourse(id, dir) {
            var r = await fetch('/api/reorder', { method: 'POST', body: JSON.stringify({ id: id, dir: dir }) });
            if (r.status === 403) { alert("请先登录管理端"); return; }
            if (r.ok) location.reload();
        }
        function openImportModal() { document.getElementById('importJson').value = ""; toggleModal('importModal'); }
        async function doImport() {
            var raw = document.getElementById('importJson').value.trim();
            if (!raw) { alert("请先粘贴 JSON"); return; }
            var obj;
            try { obj = JSON.parse(raw); } catch (e) { alert("JSON 格式错误：" + e.message); return; }
            var r = await fetch('/api/import', { method: 'POST', body: JSON.stringify(obj) });
            if (r.status === 403) { alert("请先登录管理端"); return; }
            var j = await r.json();
            if (j.success) { alert("成功导入 " + j.imported + " 门课程"); location.reload(); }
            else alert("导入失败");
        }
        /* 管理端：系列 / 子栏目增删改（两级） */
        function findSeries(nm) {
            for (var i = 0; i < catRows.length; i++) if (catRows[i].name === nm) return catRows[i];
            return null;
        }
        var CAT_TREE_KEY = "TQ_CAT_TREE_V1";
        function getCatTreeState() { try { return JSON.parse(localStorage.getItem(CAT_TREE_KEY) || "{}"); } catch(e) { return {}; } }
        function setCatTreeState(s) { try { localStorage.setItem(CAT_TREE_KEY, JSON.stringify(s)); } catch(e) {} }
        function toggleCat(btn) {
            var key = btn.getAttribute("data-ckey");
            var body = document.getElementById(btn.getAttribute("data-cbody"));
            var chev = btn.querySelector(".cat-chev");
            if (!body) return;
            var hidden = body.classList.toggle("hidden");
            if (chev) chev.innerText = hidden ? "\u25B6" : "\u25BC";
            var st = getCatTreeState();
            if (hidden) st[key] = 1; else delete st[key];
            setCatTreeState(st);
        }
        function renderCatList() {
            var box = document.getElementById('catList');
            if (!box) return;
            if (!catRows.length) {
                box.innerHTML = '<div class="text-sm text-slate-400">暂无系列。点击右上角"＋ 新增系列"创建；保存课程时填写的系列也会自动出现在这里补简介。</div>';
                return;
            }
            var cst = getCatTreeState();
            var si = 0;
            box.innerHTML = catRows.map(function(s) {
                si++;
                var sKey = 's:' + s.name;
                var sCollapsed = !!cst[sKey];
                var sBodyId = 'catBody' + si;
                var subs = (s.subs || []).map(function(x, xi) {
                    var xKey = 'x:' + s.name + '/' + x.name;
                    var xCollapsed = !!cst[xKey];
                    var xBodyId = sBodyId + 'x' + xi;
                    var xChev = xCollapsed ? '\u25B6' : '\u25BC';
                    return '<div class="ml-2 sm:ml-5 mt-2 border-l-2 border-violet-100 pl-2 sm:pl-3 py-1.5">'
                        + '<div class="flex items-center gap-1.5">'
                        + '<button data-ckey="' + esc(xKey) + '" data-cbody="' + xBodyId + '" onclick="toggleCat(this)" class="shrink-0 w-5 h-5 flex items-center justify-center text-violet-400 hover:bg-violet-50 rounded"><span class="cat-chev text-xs">' + xChev + '</span></button>'
                        + '<div class="text-sm font-bold text-slate-700 flex-1 min-w-0 truncate">📁 ' + esc(x.name)
                        + ' <span class="text-xs font-normal text-slate-400">' + x.count + ' 门课程</span></div>'
                        + '<div class="flex gap-1 shrink-0">'
                        + '<button data-p="' + esc(s.name) + '" data-n="' + esc(x.name) + '" onclick="openCatModal(this.dataset.p, this.dataset.n)" class="text-xs bg-indigo-50 text-indigo-600 px-2 py-1 rounded-lg font-bold">编辑</button>'
                        + '<button data-p="' + esc(s.name) + '" data-n="' + esc(x.name) + '" onclick="deleteCat(this.dataset.p, this.dataset.n)" class="text-xs bg-red-50 text-red-500 px-2 py-1 rounded-lg font-bold">删除</button>'
                        + '</div></div>'
                        + '<div id="' + xBodyId + '" class="' + (xCollapsed ? 'hidden' : '') + '"><div class="text-xs text-slate-500 mt-1 leading-relaxed">' + (x.description ? esc(x.description) : '<span class="text-slate-300">（暂无简介）</span>') + '</div></div></div>';
                }).join('');
                var sChev = sCollapsed ? '\u25B6' : '\u25BC';
                return '<div class="border border-slate-100 rounded-2xl p-3 sm:p-4">'
                    + '<div class="flex items-center gap-2">'
                    + '<button data-ckey="' + esc(sKey) + '" data-cbody="' + sBodyId + '" onclick="toggleCat(this)" class="shrink-0 w-6 h-6 flex items-center justify-center text-violet-500 hover:bg-violet-50 rounded-lg"><span class="cat-chev text-xs">' + sChev + '</span></button>'
                    + '<div class="font-bold text-slate-800 text-sm flex-1 min-w-0 truncate">📚 ' + esc(s.name)
                    + ' <span class="text-xs font-normal text-slate-400">' + s.totalCount + ' 门课程</span></div>'
                    + '<div class="flex gap-1 shrink-0">'
                    + '<button data-p="' + esc(s.name) + '" onclick="openCatModal(this.dataset.p, null)" class="text-xs bg-violet-50 text-violet-600 px-2 py-1 rounded-lg font-bold whitespace-nowrap">＋子栏目</button>'
                    + '<button data-p="" data-n="' + esc(s.name) + '" onclick="openCatModal(this.dataset.p, this.dataset.n)" class="text-xs bg-indigo-50 text-indigo-600 px-2 py-1 rounded-lg font-bold">编辑</button>'
                    + '<button data-p="" data-n="' + esc(s.name) + '" onclick="deleteCat(this.dataset.p, this.dataset.n)" class="text-xs bg-red-50 text-red-500 px-2 py-1 rounded-lg font-bold">删除</button>'
                    + '</div></div>'
                    + '<div id="' + sBodyId + '" class="' + (sCollapsed ? 'hidden' : '') + '">'
                    + '<div class="text-xs text-slate-500 mt-2 leading-relaxed">' + (s.description ? esc(s.description) : '<span class="text-slate-300">（暂无简介，点击编辑添加）</span>') + '</div>'
                    + subs + '</div></div>';
            }).join('');
        }
        /* parent 为空 => 系列；非空 => parent 系列下的子栏目 */
        function openCatModal(parent, name) {
            var row = null;
            if (parent) {
                var s = findSeries(parent);
                var subs = s ? (s.subs || []) : [];
                for (var j = 0; j < subs.length; j++) if (subs[j].name === name) { row = subs[j]; break; }
            } else if (name) {
                row = findSeries(name);
            }
            document.getElementById('cat_parent').value = parent || "";
            document.getElementById('cat_old').value = row ? row.name : "";
            document.getElementById('cat_desc').value = row ? (row.description || "") : "";
            var abWrap = document.getElementById('cat_ab_wrap');
            var nameInput = document.getElementById('cat_name');
            if (parent) {
                // 子栏目：显示A/B两个框
                abWrap.classList.remove('hidden');
                nameInput.classList.add('hidden');
                var fullName = row ? row.name : "";
                var pi = fullName.indexOf('•');
                if (pi < 0) pi = fullName.indexOf('+');
                document.getElementById('cat_name_a').value = pi > 0 ? fullName.slice(0, pi).trim() : fullName;
                document.getElementById('cat_name_b').value = pi > 0 ? fullName.slice(pi + 1).trim() : "";
            } else {
                // 系列：单个框
                abWrap.classList.add('hidden');
                nameInput.classList.remove('hidden');
                nameInput.value = row ? row.name : "";
            }
            document.getElementById('catModalTitle').innerText = parent
                ? (row ? "编辑子栏目（" + parent + "）" : "＋ 新增子栏目（" + parent + "）")
                : (row ? "编辑系列" : "＋ 新增系列");
            toggleModal('catModal');
        }
        async function saveCat() {
            var parent = document.getElementById('cat_parent').value;
            var desc = document.getElementById('cat_desc').value.trim();
            var oldName = document.getElementById('cat_old').value;
            var name;
            if (parent) {
                var a = document.getElementById('cat_name_a').value.trim();
                var b = document.getElementById('cat_name_b').value.trim();
                if (!a) { alert("请填写A名称"); return; }
                name = b ? a + '•' + b : a;
            } else {
                name = document.getElementById('cat_name').value.trim();
                if (!name) { alert("请填写名称"); return; }
            }
            var r = await fetch('/api/category/save', { method: 'POST', body: JSON.stringify({ name: name, description: desc, parent: parent, oldName: oldName }) });
            if (r.status === 403) { alert("请先登录管理端"); return; }
            var j = await r.json().catch(function() { return {}; });
            if (j.success) location.reload(); else alert("保存失败：" + (j.error || "未知错误"));
        }
        async function deleteCat(parent, name) {
            var label = parent ? "子栏目「" + name + "」（" + parent + "）" : "系列「" + name + "」";
            if (!confirm("确定删除" + label + "吗？\\n旗下有课程或子栏目时不可删除。")) return;
            var r = await fetch('/api/category/delete', { method: 'POST', body: JSON.stringify({ name: name, parent: parent || "" }) });
            if (r.status === 403) { alert("请先登录管理端"); return; }
            var j = await r.json().catch(function() { return {}; });
            if (j.success) location.reload(); else alert("删除失败：" + (j.error || "未知错误"));
        }
        /* 课程表单：系列 / 子栏目下拉（选择已有或新建；编辑时可把课程移到任意子栏目） */
        function renderCatForm() {
            var ss = document.getElementById('f_series');
            if (!ss) return;
            ss.innerHTML = catRows.map(function(s) { return '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>'; }).join('')
                + '<option value="__new__">＋ 新建系列…</option>';
            onSeriesChange();
        }
        function onSeriesChange() {
            var ss = document.getElementById('f_series');
            var sv = ss.value;
            document.getElementById('f_series_new').classList.toggle('hidden', sv !== '__new__');
            var subs = [];
            if (sv && sv !== '__new__') {
                var s = findSeries(sv);
                subs = s ? (s.subs || []) : [];
            }
            var sel = document.getElementById('f_sub');
            sel.innerHTML = '<option value="">（无子栏目，直接归属系列）</option>'
                + subs.map(function(x) { return '<option value="' + esc(x.name) + '">' + esc(x.name) + '</option>'; }).join('')
                + '<option value="__new__">＋ 新建子栏目…</option>';
            sel.onchange = function() {
                document.getElementById('f_sub_new').classList.toggle('hidden', sel.value !== '__new__');
            };
            sel.onchange();
        }
        async function saveNotice() {
            var t = document.getElementById('noticeText').value;
            var r = await fetch('/api/notice', { method: 'POST', body: JSON.stringify({ notice: t }) });
            if (r.status === 403) { alert("请先登录管理端"); return; }
            if (r.ok) alert("公告已保存");
        }
        function openPwModal() { document.getElementById('pw_old').value = ""; document.getElementById('pw_new').value = ""; toggleModal('pwModal'); }
        async function adminLogout() { if (!confirm("确定退出管理端登录？")) return; await fetch('/api/admin/logout', { method: 'POST' }); location.reload(); }
        async function doChangePassword() {
            var o = document.getElementById('pw_old').value, n = document.getElementById('pw_new').value;
            var r = await fetch('/api/change-password', { method: 'POST', body: JSON.stringify({ oldPassword: o, newPassword: n }) });
            var j = await r.json().catch(function(){ return {}; });
            if (j.ok) { alert("密码修改成功"); toggleModal('pwModal'); }
            else alert("修改失败：" + (j.error || "未知错误"));
        }
        /* 管理密码恢复码 */
        async function setRecoveryCode() {
            var c = (document.getElementById('rc_set').value || "").trim();
            if (c.length < 6) { alert("恢复码至少 6 位"); return; }
            var r = await fetch('/api/admin/set-recovery', { method: 'POST', body: JSON.stringify({ recoveryCode: c }) });
            var j = await r.json().catch(function(){ return {}; });
            if (j.ok) { alert("恢复码已设置，请妥善保管"); document.getElementById('rc_set').value = ""; }
            else alert("设置失败：" + (j.error || "未知错误"));
        }
        function openRecoverModal() {
            document.getElementById('rc_code').value = "";
            document.getElementById('rc_new').value = "";
            toggleModal('recoverModal');
        }
        function hideRcErr() { var e = document.getElementById('rcErr'); if (e) e.classList.add('hidden'); }
        function showRcErr(msg) { var e = document.getElementById('rcErr'); if (e) { e.innerText = msg; e.classList.remove('hidden'); } }
        async function doAdminRecover() {
            var c = (document.getElementById('rc_code').value || "").trim();
            var n = document.getElementById('rc_new').value || "";
            hideRcErr();
            if (!c) { showRcErr("请输入恢复码"); return; }
            if (n.length < 6) { showRcErr("新密码至少 6 位"); return; }
            var r = await fetch('/api/admin/recover-password', { method: 'POST', body: JSON.stringify({ recoveryCode: c, newPassword: n }) });
            var j = await r.json().catch(function(){ return {}; });
            if (j.ok) { sessionStorage.setItem('TQ_ADMIN_OK', '1'); location.reload(); }
            else showRcErr("找回失败：" + (j.error || "未知错误"));
        }
        /* 管理员重置学员密码 */
        function resetStudentPw(username) {
            var np = prompt("为「" + username + "」设置新密码（至少 4 位）：", "");
            if (np === null) return;
            np = (np || "").trim();
            if (np.length < 4) { alert("密码至少 4 位"); return; }
            fetch('/api/student/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username, newPassword: np }) })
                .then(function(r){ return r.json(); })
                .then(function(j){ if (j.ok) alert("已重置，请将新密码告知学员"); else alert("重置失败：" + (j.error || "未知错误")); })
                .catch(function(){ alert("重置失败，请稍后重试"); });
        }
        applyFontScale();
        applyViewMode();
        document.addEventListener("DOMContentLoaded", applyFontScale);
        window.addEventListener("resize", function() { try { if (localStorage.getItem(VIEW_MODE_KEY) === "desktop") applyViewMode(); } catch (e) {} }); /* 浮钮HTML在script之后，等DOM就绪再刷标签 */
        var sn = progName();
        syncNameBtn();
        syncVideoBtn();
        
        var sqn = document.getElementById('scoreQueryName'); if (sqn && sn) sqn.value = sn;
        if (document.getElementById('studentSelect')) loadStudents();
        if (document.getElementById('adminStudentList')) loadAdminStudents();
    </script>

    <!-- 字号调节：全站可见 -->
    <div id="fontFab">
        <div id="fontPanel" class="hidden">
            <button onclick="fontStep(1)" data-i18n-title="fontZoomIn" title="放大字体">A＋</button>
            <div id="fontLevelLabel" class="text-xs font-bold text-slate-600 px-1">标准</div>
            <button onclick="fontStep(-1)" data-i18n-title="fontZoomOut" title="缩小字体">A－</button>
            <button onclick="fontReset()" data-i18n-title="fontResetT" title="恢复标准字号" class="font-reset-btn" data-i18n="resetBtn">重置</button>
        </div>
        <button id="videoToggleBtn" onclick="openNetEnvModal()" data-i18n-title="vidEntryT" title="视频入口设置">🎬</button>
        <button id="fontFabBtn" onclick="toggleFontPanel()" data-i18n-title="fontT" title="调整字体大小" data-i18n="fontT">字体</button>
    </div>
    <div id="netEnvModal" class="hidden fixed inset-0 z-[200] flex items-center justify-center p-6" style="background:rgba(15,23,42,.55);backdrop-filter:blur(4px);">
        <div class="bg-white rounded-3xl shadow-2xl max-w-sm w-full p-6 text-center">
            <div class="text-3xl mb-2">🎬</div>
            <h3 class="text-lg font-black text-slate-900 mb-1" data-i18n="vidEntryT">视频入口设置</h3>
            <p class="text-xs text-slate-500 mb-5" data-i18n="vidSetD">选择视频内容的显示方式，选一次即可记住</p>
            <div class="space-y-3">
                <button data-env="cn" onclick="setVideoNetEnv('cn')" class="netenv-opt w-full p-4 rounded-2xl border-2 text-left transition active:scale-95">
                    <div class="text-base font-black" data-i18n="vidSimple">精简显示</div>
                    <div class="text-xs text-slate-500 mt-1" data-i18n="vidSimpleD">部分视频入口将不显示，页面更简洁</div>
                </button>
                <button data-env="intl" onclick="setVideoNetEnv('intl')" class="netenv-opt w-full p-4 rounded-2xl border-2 text-left transition active:scale-95">
                    <div class="text-base font-black" data-i18n="vidAll">全部显示</div>
                    <div class="text-xs text-slate-500 mt-1" data-i18n="vidAllD">显示全部视频入口</div>
                </button>
            </div>
            <button onclick="setVideoNetEnv('cn', true)" class="mt-4 text-xs text-slate-400 hover:underline" data-i18n="vidLater">稍后再说</button>
        </div>
    </div>
    <div id="videoChoiceModal" class="hidden fixed inset-0 z-[200] flex items-center justify-center p-6" style="background:rgba(15,23,42,.55);backdrop-filter:blur(4px);">
        <div class="bg-white rounded-3xl shadow-2xl max-w-sm w-full p-6">
            <div class="text-center mb-4">
                <div class="text-3xl mb-2">🎬</div>
                <h3 class="text-lg font-black text-slate-900" data-i18n="vidChoose">选择视频源</h3>
                <p class="text-xs text-slate-500 mt-1" data-i18n="vidChooseD">请选择一个视频链接打开观看</p>
            </div>
            <div id="videoChoiceList" class="space-y-3"></div>
            <button onclick="document.getElementById('videoChoiceModal').classList.add('hidden')" data-i18n="cancel" class="mt-4 w-full text-xs text-slate-400 hover:underline text-center">取消</button>
        </div>
    </div>
    <div id="wechatTipModal" class="hidden fixed inset-0 z-[200] flex items-center justify-center p-6" style="background:rgba(15,23,42,.55);backdrop-filter:blur(4px);">
        <div class="bg-white rounded-3xl shadow-2xl max-w-sm w-full p-6 text-center">
            <div class="text-3xl mb-2">📱</div>
            <h3 class="text-lg font-black text-slate-900 mb-1" data-i18n="vidWxT">请在微信中打开</h3>
            <p class="text-xs text-slate-500 mb-5" data-i18n-html="vidWxD1">这个视频需要在微信内观看<br>点击下方按钮复制链接</p>
            <button onclick="copyWecomLink()" class="w-full p-3 rounded-2xl bg-indigo-600 text-white font-bold text-sm active:scale-95 transition" data-i18n="vidCopy">复制视频链接</button>
            <p class="text-xs text-slate-400 mt-3" data-i18n-html="vidWxD2">复制后发送到微信任意聊天<br>点开链接即可观看</p>
            <button onclick="document.getElementById('wechatTipModal').classList.add('hidden')" data-i18n="cancel" class="mt-4 text-xs text-slate-400 hover:underline">取消</button>
        </div>
    </div>
    <div id="viewModeFab">
        <button id="viewModeBtn" onclick="toggleViewMode()" data-i18n-title="toDesk" title="切换到桌面版">🖥️</button>
    </div>
<script>
/* ============================================================================
 * 学习路径 + 证书系统（客户端 UI）
 * ----------------------------------------------------------------------------
 * 外部依赖（由构建/页面组装时提供，本文件不定义）：
 *   tr(k), tf(k, obj), curLang() — src/client/i18n.js + main.js（多语言）
 *   progName()                   — src/client/main.js（学员姓名，localStorage）
 *   startLesson(courseId)        — src/client/main.js（打开课程学习）
 *   fetch                        — 浏览器原生
 * 本文件自带：escP()（HTML 转义，避免与现有 esc() 重名冲突）。
 *
 * I18N-KEYS: 以下 key 需并入 src/client/i18n.js 的 zh/en/ja/ko 四节
 * （主 agent 合并时直接取用；tw 繁体走 toTW 自动转换，无需手写）
 * ----------------------------------------------------------------------------
 * path_title      | 学习路径 | Learning Paths | 学習パス | 학습 경로
 * path_myCerts    | 我的证书 | My Certificates | 私の修了証 | 내 수료증
 * path_continue   | 继续学习 | Continue | 学習を続ける | 계속 학습
 * path_start      | 开始学习 | Start Learning | 学習を始める | 학습 시작
 * path_doneOf     | 已完成 {a}/{b} 门 | {a}/{b} completed | {a}/{b} 修了 | {a}/{b} 완료
 * path_completed  | 已完成 ✓ | Completed ✓ | 修了済み ✓ | 수료 완료 ✓
 * path_empty      | 暂无学习路径 | No learning paths yet | 学習パスはまだありません | 학습 경로가 아직 없습니다
 * path_back       | ← 返回路径列表 | ← Back to Paths | ← パス一覧に戻る | ← 경로 목록으로 돌아가기
 * path_loginFirst | 请先设置学员姓名，进度将记在该姓名下 | Please set your student name first; progress will be saved under it | 学習者名を先に設定してください | 학습자 이름을 먼저 설정해 주세요
 * path_loadFail   | 加载失败，请重试 | Failed to load, please retry | 読み込みに失敗しました。もう一度お試しください | 불러오지 못했습니다. 다시 시도해 주세요
 * path_viewCert   | 查看证书 | View Certificate | 修了証を見る | 수료증 보기
 * path_courseMissing | 课程已下架 | Course unavailable | 削除された課程 | 삭제된 강의
 * cert_title      | 学习证书 | Certificate of Completion | 修了証 | 수료증
 * cert_awarded    | 兹证明 | This is to certify that | ここに証明します | 이에 증명합니다
 * cert_completedPath | 已圆满完成学习路径 | has successfully completed the learning path | 学習パスを修了しました | 학습 경로를 성공적으로 수료했습니다
 * cert_no         | 证书编号 | Certificate No. | 証書番号 | 증서 번호
 * cert_date       | 颁发日期 | Date Issued | 発行日 | 발급일
 * cert_print      | 🖨 打印证书 | 🖨 Print Certificate | 🖨 修了証を印刷 | 🖨 수료증 인쇄
 * cert_empty      | 还没有证书，完成一条学习路径后将自动颁发 | No certificates yet. One will be issued automatically when you complete a path. | まだ修了証がありません。パスを修了すると自動発行されます。 | 아직 수료증이 없습니다. 경로를 수료하면 자동으로 발급됩니다.
 * cert_congrats   | 🎉 恭喜完成整条路径！证书已颁发 | 🎉 Congratulations on completing the path! Your certificate has been issued. | 🎉 パス修了おめでとうございます！修了証を発行しました | 🎉 경로 수료를 축하합니다! 수료증이 발급되었습니다.
 * ========================================================================== */

function escP(s) {
return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* 按当前语言取路径标题/简介（无翻译回退中文；繁体走 toTW 实时转换） */
function pathTitleL(p) {
var L = (typeof curLang === "function") ? curLang() : "zh";
if (L === "en" && p.title_en) return p.title_en;
if (L === "ja" && p.title_ja) return p.title_ja;
if (L === "ko" && p.title_ko) return p.title_ko;
var t = p.title || "";
if (L === "tw" && typeof toTW === "function") return toTW(t);
return t;
}
function pathDescrL(p) {
var L = (typeof curLang === "function") ? curLang() : "zh";
if (L === "en" && p.descr_en) return p.descr_en;
if (L === "ja" && p.descr_ja) return p.descr_ja;
if (L === "ko" && p.descr_ko) return p.descr_ko;
var d = p.descr || "";
if (L === "tw" && typeof toTW === "function") return toTW(d);
return d;
}
/* 路径图标：按名称语义自动匹配（中英日韩关键词），新增路径自动生效 */
function pathIcon(p) {
var t = String((p && p.title) || "") + " " + String((p && p.title_en) || "") + " " + String((p && p.title_ja) || "") + " " + String((p && p.title_ko) || "");
/* 全名精确匹配 */
var fullMap = {
"初信者": "🌱", "门徒成长": "🌳", "服事装备": "🛠", "领袖训练": "⭐"
};
if (p && fullMap[p.title]) return fullMap[p.title];
/* 中文语义匹配 */
if (/初信|新信徒|慕道|决志/.test(t)) return "🌱";
if (/门徒|成长|进深|栽培|造就/.test(t)) return "🌳";
if (/服事|装备|事工|服侍|义工/.test(t)) return "🛠";
if (/领袖|领导|牧养|牧者|组长/.test(t)) return "⭐";
if (/敬拜|赞美|诗歌|音乐/.test(t)) return "🎵";
if (/祷告|祈祷|代祷/.test(t)) return "🙏";
if (/宣教|布道|差传|福音/.test(t)) return "🌍";
if (/婚姻|家庭|亲子|夫妻/.test(t)) return "👨‍👩‍👧‍👦";
if (/青年|青少年|少年/.test(t)) return "🧑‍🎓";
if (/儿童|孩童|少儿/.test(t)) return "🧒";
if (/圣经|读经|经卷/.test(t)) return "📖";
if (/神学|教义|真理/.test(t)) return "💡";
/* 英文语义匹配 */
if (/new believer|seeker/i.test(t)) return "🌱";
if (/disciple|growth|matur/i.test(t)) return "🌳";
if (/ministry|serv|equip/i.test(t)) return "🛠";
if (/leader|pastor|shepherd/i.test(t)) return "⭐";
if (/worship|praise/i.test(t)) return "🎵";
if (/prayer/i.test(t)) return "🙏";
if (/mission|evangel/i.test(t)) return "🌍";
if (/marriage|family|parent/i.test(t)) return "👨‍👩‍👧‍👦";
if (/youth|teen/i.test(t)) return "🧑‍🎓";
if (/child|kid/i.test(t)) return "🧒";
/* 日文语义匹配 */
if (/新信徒|求道/.test(t)) return "🌱";
if (/弟子|成長/.test(t)) return "🌳";
if (/奉仕|備え/.test(t)) return "🛠";
if (/リーダー|牧会/.test(t)) return "⭐";
/* 韩文语义匹配 */
if (/새신자/.test(t)) return "🌱";
if (/제자|성장/.test(t)) return "🌳";
if (/사역|준비/.test(t)) return "🛠";
if (/리더|목양/.test(t)) return "⭐";
return "🗺";
}
function pathUser() {
try { return (typeof progName === "function" ? progName() : "") || ""; } catch (e) { return ""; }
}

/* 渲染容器：复用 #pathsRoot，不存在则创建（由接入方决定在页面中的位置） */
function pathsRoot() {
var el = document.getElementById("pathsRoot");
if (!el) {
el = document.createElement("div");
el.id = "pathsRoot";
el.className = "max-w-4xl mx-auto px-4 py-6";
document.body.appendChild(el);
}
return el;
}
function pathsLoading() {
return '<div class="text-center text-slate-400 py-12">' + escP(tr("loading")) + '</div>';
}
function pathsLoadFail() {
return '<div class="text-center text-red-400 py-12">' + escP(tr("path_loadFail")) + '</div>';
}

/* 路径列表页：标题（当前语言）、简介、进度条（已完成 X/Y 门）、继续学习按钮 */
async function renderPathsPage() {
var root = pathsRoot();
root.innerHTML = pathsLoading();
var username = pathUser();
try {
var url = "/api/paths" + (username ? "?username=" + encodeURIComponent(username) : "");
var r = await fetch(url);
var j = await r.json();
var paths = j.paths || [];
var html = '<div class="flex items-center justify-between mb-5">'
+ '<h2 class="text-xl font-bold text-slate-900">🗺 ' + escP(tr("path_title")) + '</h2>'
+ '<button onclick="renderCertificatesPage()" class="px-4 py-2 text-sm font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl hover:bg-amber-100 transition">🏆 ' + escP(tr("path_myCerts")) + '</button>'
+ '</div>';
if (!paths.length) {
html += '<div class="text-center text-slate-400 py-12">' + escP(tr("path_empty")) + '</div>';
} else {
html += paths.map(function (p) {
var total = p.course_count || 0, done = p.done_count || 0;
var pct = total > 0 ? Math.round(done / total * 100) : 0;
var finished = total > 0 && done >= total;
var btnLabel = done > 0 ? tr("path_continue") : tr("path_start");
return '<div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4">'
+ '<div class="text-lg font-bold text-slate-900">' + pathIcon(p) + ' ' + escP(pathTitleL(p)) + '</div>'
+ (pathDescrL(p) ? '<div class="text-sm text-slate-500 mt-1 leading-relaxed">' + escP(pathDescrL(p)) + '</div>' : '')
+ '<div class="mt-3 h-2 bg-slate-100 rounded-full overflow-hidden"><div class="h-2 rounded-full transition-all ' + (finished ? 'bg-amber-500' : 'bg-emerald-500') + '" style="width:' + pct + '%"></div></div>'
+ '<div class="flex items-center justify-between mt-2 gap-2">'
+ '<span class="flex items-center gap-2"><span class="text-xs text-slate-500">' + escP(tf("path_doneOf", { a: done, b: total })) + '</span>'
+ '<button data-pid="' + escP(p.id) + '" onclick="copyPathLink(this.dataset.pid)" title="' + escP(tr("copyLinkT")) + '" class="text-slate-300 hover:text-violet-600 transition text-sm">🔗</button></span>'
+ (finished
? '<button onclick="renderCertificatesPage()" class="text-xs font-bold text-amber-600 hover:text-amber-700">🏆 ' + escP(tr("path_viewCert")) + '</button>'
: '<button data-pid="' + escP(p.id) + '" onclick="renderPathDetail(this.dataset.pid)" class="px-4 py-1.5 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 transition">' + escP(btnLabel) + '</button>')
+ '</div></div>';
}).join("");
}
root.innerHTML = html;
try { if (typeof applyI18n === "function") applyI18n(); } catch (e) {}
} catch (e) {
root.innerHTML = pathsLoadFail();
}
}

/* 路径详情页：按顺序列课程，每门显示完成状态（✓/○），点击进课程学习 */
async function renderPathDetail(pathId) {
var root = pathsRoot();
root.innerHTML = pathsLoading();
var username = pathUser();
try {
var url = "/api/path?id=" + encodeURIComponent(pathId) + (username ? "&username=" + encodeURIComponent(username) : "");
var r = await fetch(url);
var j = await r.json();
if (!j.path) { root.innerHTML = pathsLoadFail(); return; }
var p = j.path;
var courses = j.courses || [];
/* 用首页已加载的完整课程数据补齐 content/video_url，使卡片与目录展示一致 */
courses = courses.map(function (c) {
var full = null;
try { full = _peCourseById(c.id); } catch (e) {}
return full || c;
});
var doneIds = j.done_ids || [];
function isDone(cid) { return doneIds.indexOf(cid) >= 0; }
var total = courses.length;
var doneCount = courses.filter(function (c) { return isDone(c.id); }).length;
var html = '<button onclick="renderPathsPage()" class="mb-4 text-sm font-bold text-slate-500 hover:text-slate-700 transition">' + escP(tr("path_back")) + '</button>'
+ '<div class="bg-gradient-to-r from-indigo-600 to-violet-600 rounded-2xl p-6 text-white mb-5">'
+ '<div class="flex items-center gap-2"><div class="text-xl font-bold flex-1">' + pathIcon(p) + ' ' + escP(pathTitleL(p)) + '</div>'
+ '<button data-pid="' + escP(p.id) + '" onclick="copyPathLink(this.dataset.pid)" title="' + escP(tr("copyLinkT")) + '" class="text-indigo-200 hover:text-white transition text-lg">🔗</button></div>'
+ (pathDescrL(p) ? '<div class="text-sm text-indigo-100 mt-1 leading-relaxed">' + escP(pathDescrL(p)) + '</div>' : '')
+ '<div class="text-xs text-indigo-100 mt-3">' + escP(tf("path_doneOf", { a: doneCount, b: total })) + '</div>'
+ '</div>';
if (!username) {
html += '<div class="text-center text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-xl py-2.5 mb-4">' + escP(tr("path_loginFirst")) + '</div>';
}
if (!courses.length) {
html += '<div class="text-center text-slate-400 py-10">' + escP(tr("path_empty")) + '</div>';
} else {
html += (function () {
var groups = {}, catOrder = [];
courses.forEach(function (c) { var k = c.category || ""; if (!groups[k]) { groups[k] = []; catOrder.push(k); } groups[k].push(c); });
var st = (typeof getTreeState === "function") ? getTreeState() : {};
return catOrder.map(function (cat, si) {
var info = (typeof catInfo !== "undefined" && catInfo[cat]) || { description: "", subDesc: {} };
var subgroups = {}, subOrder = [];
groups[cat].forEach(function (c) { var sk = c.subcategory || ""; if (!subgroups[sk]) { subgroups[sk] = []; subOrder.push(sk); } subgroups[sk].push(c); });
var sKey = "path:" + p.id + ":ser:" + cat, sBody = "pathTreeB" + si, sChev = "pathTreeC" + si;
var sCollapsed = !!st[sKey];
var bodyHtml = subOrder.map(function (sk, ki) {
var cards = subgroups[sk].map(function (c, idx) { return courseCard(c, idx); }).join("");
var gridHtml = '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-8 course-cards">' + cards + "</div>";
if (!sk) return gridHtml;
var kKey = "path:" + p.id + ":sub:" + cat + "::" + sk, kBody = sBody + "K" + ki, kChev = sChev + "K" + ki;
var kCollapsed = !!st[kKey];
var sd = info.subDesc[sk] || "";
return '<div class="ml-1 md:ml-5 mt-7">'
+ '<div class="flex items-center gap-1 mb-3">'
+ '<button data-tkey="' + escP(kKey) + '" data-tbody="' + kBody + '" data-tchev="' + kChev + '" onclick="toggleTree(this)" class="flex items-center gap-1 group min-w-0">'
+ '<span id="' + kChev + '" class="text-xs text-violet-500 w-4 text-center shrink-0">' + (kCollapsed ? "▶" : "▼") + "</span>"
+ '<span class="text-[15px] font-bold text-slate-700 group-hover:text-violet-700">📁' + hlSubcat(subNameL(cat, sk)) + "</span>"
+ '<span class="text-xs text-slate-400 shrink-0">' + escP(tf("nLessons", { n: subgroups[sk].length })) + "</span></button>"
+ '<button data-cat="' + escP(cat) + '" data-sub="' + escP(sk) + '" onclick="copySubLink(this.dataset.cat,this.dataset.sub)" title="' + escP(tr("copyLinkT")) + '" class="text-slate-300 hover:text-violet-600 transition text-[13px] ml-1">🔗</button>'
+ "</div>"
+ (sd ? '<p class="text-xs text-slate-500 mb-3 ml-6 leading-relaxed">' + escP(sd) + "</p>" : "")
+ '<div id="' + kBody + '" class="' + (kCollapsed ? "hidden" : "") + '">' + gridHtml + "</div></div>";
}).join("");
return '<div class="mb-6">'
+ '<div class="flex items-center gap-1">'
+ '<button data-tkey="' + escP(sKey) + '" data-tbody="' + sBody + '" data-tchev="' + sChev + '" onclick="toggleTree(this)" class="flex items-center gap-3 flex-1 min-w-0 text-left group">'
+ '<span id="' + sChev + '" class="text-sm text-violet-500 w-5 text-center shrink-0">' + (sCollapsed ? "▶" : "▼") + "</span>"
+ '<span class="w-1.5 h-7 bg-violet-500 rounded-full shrink-0"></span>'
+ '<h2 class="text-xl font-black tracking-tight group-hover:text-violet-700">' + catIcon(cat) + " " + escP(catNameL(cat)) + "</h2>"
+ '<span class="text-sm text-slate-400 shrink-0">' + escP(tf("nLessons", { n: groups[cat].length })) + "</span></button>"
+ '<button data-cat="' + escP(cat) + '" onclick="copySeriesLink(this.dataset.cat)" title="' + escP(tr("copyLinkT")) + '" class="text-slate-300 hover:text-violet-600 transition text-[15px] ml-1">🔗</button>'
+ "</div>"
+ (info.description ? '<p class="text-sm text-slate-500 mt-2 mb-1 ml-8 leading-relaxed">' + escP(String(info.description).split("**").join("").split(String.fromCharCode(10)).join(" ").trim()) + "</p>" : "")
+ '<div id="' + sBody + '" class="' + (sCollapsed ? "hidden" : "") + '">' + bodyHtml + "</div></div>";
}).join("");
})();
}
root.innerHTML = html;
try { if (typeof applyI18n === "function") applyI18n(); } catch (e) {}
} catch (e) {
root.innerHTML = pathsLoadFail();
}
}

/* 我的证书列表页 */
async function renderCertificatesPage() {
var root = pathsRoot();
root.innerHTML = pathsLoading();
var username = pathUser();
try {
var url = "/api/certificates" + (username ? "?username=" + encodeURIComponent(username) : "");
var r = await fetch(url);
var j = await r.json();
var certs = j.certificates || [];
var html = '<button onclick="renderPathsPage()" class="mb-4 text-sm font-bold text-slate-500 hover:text-slate-700 transition">' + escP(tr("path_back")) + '</button>'
+ '<h2 class="text-xl font-bold text-slate-900 mb-5">🏆 ' + escP(tr("path_myCerts")) + '</h2>';
if (!certs.length) {
html += '<div class="text-center text-slate-400 py-12 leading-relaxed">' + escP(tr("cert_empty")) + '</div>';
} else {
html += '<div class="grid gap-3">' + certs.map(function (c) {
var d = String(c.issued_at || "").slice(0, 10);
return '<button data-cno="' + escP(c.cert_no) + '" onclick="renderCertificateView(this.dataset.cno)"'
+ ' class="flex items-center gap-4 bg-white rounded-2xl border border-amber-200 shadow-sm p-4 text-left hover:shadow-md transition">'
+ '<span class="text-3xl">🎓</span>'
+ '<span class="flex-1 min-w-0">'
+ '<span class="block font-bold text-slate-900 truncate">' + escP(c.path_title || "") + '</span>'
+ '<span class="block text-xs text-slate-400 mt-0.5">' + escP(tr("cert_no")) + ': ' + escP(c.cert_no) + ' · ' + escP(d) + '</span>'
+ '</span><span class="text-slate-300">→</span></button>';
}).join("") + '</div>';
}
root.innerHTML = html;
try { if (typeof applyI18n === "function") applyI18n(); } catch (e) {}
} catch (e) {
root.innerHTML = pathsLoadFail();
}
}

/* 证书展示页：可打印（A4 横向、金色边框、学员名、路径名、颁发日期、证书编号） */
function pathsPrintStyle() {
if (document.getElementById("pathsPrintStyle")) return;
var st = document.createElement("style");
st.id = "pathsPrintStyle";
st.textContent = "@media print{"
+ "body *{visibility:hidden !important;}"
+ "#pathsCertCard,#pathsCertCard *{visibility:visible !important;}"
+ "#pathsCertCard{position:absolute !important;left:0;top:0;width:100%;margin:0;box-shadow:none !important;}"
+ "#pathsCertActions{display:none !important;}"
+ "@page{size:A4 landscape;margin:12mm;}"
+ "}";
document.head.appendChild(st);
}

async function renderCertificateView(certNo) {
var root = pathsRoot();
root.innerHTML = pathsLoading();
pathsPrintStyle();
try {
var r = await fetch("/api/certificate?no=" + encodeURIComponent(certNo));
var j = await r.json();
if (!j.certificate) { root.innerHTML = pathsLoadFail(); return; }
var c = j.certificate;
var d = String(c.issued_at || "").slice(0, 10);
var html = '<div id="pathsCertActions" class="flex items-center justify-between mb-4 print:hidden">'
+ '<button onclick="renderCertificatesPage()" class="text-sm font-bold text-slate-500 hover:text-slate-700 transition">' + escP(tr("path_back")) + '</button>'
+ '<button onclick="window.print()" class="px-4 py-2 text-sm font-bold text-white bg-amber-600 rounded-xl hover:bg-amber-700 transition">' + escP(tr("cert_print")) + '</button>'
+ '</div>'
+ '<div id="pathsCertCard" class="bg-white rounded-lg p-[6px] shadow-xl" style="border:6px double #b8860b;">'
+ '<div class="px-8 py-10 text-center" style="border:2px solid #d4af37;">'
+ '<div class="text-5xl mb-3">🎓</div>'
+ '<div class="text-2xl font-bold tracking-widest text-amber-800 mb-6">' + escP(tr("cert_title")) + '</div>'
+ '<div class="text-sm text-slate-500 mb-2">' + escP(tr("cert_awarded")) + '</div>'
+ '<div class="text-3xl font-bold text-slate-900 my-3">' + escP(c.username || "") + '</div>'
+ '<div class="text-sm text-slate-500 mb-2">' + escP(tr("cert_completedPath")) + '</div>'
+ '<div class="text-xl font-bold text-indigo-800 my-3">「' + escP(c.path_title || "") + '」</div>'
+ '<div class="flex items-center justify-center gap-8 mt-8 text-xs text-slate-500">'
+ '<span>' + escP(tr("cert_no")) + ': <b class="text-slate-700">' + escP(c.cert_no) + '</b></span>'
+ '<span>' + escP(tr("cert_date")) + ': <b class="text-slate-700">' + escP(d) + '</b></span>'
+ '</div>'
+ '<div class="mt-6 text-sm font-bold text-amber-700 tracking-widest">✦ ' + escP(tr("appName")) + ' ✦</div>'
+ '</div></div>';
root.innerHTML = html;
try { if (typeof applyI18n === "function") applyI18n(); } catch (e) {}
} catch (e) {
root.innerHTML = pathsLoadFail();
}
}

/* 学员完成某课程后上报路径进度（由课程提交成功回调里调用）。
 * 返回服务端结果 {success, done_count, course_count, completed, cert_no}；
 * 若整条路径刚完成且拿到新证书，弹窗祝贺并可直接查看证书。 */
async function markPathCourseDone(pathId, courseId) {
var username = pathUser();
if (!username || !pathId || !courseId) return null;
try {
var r = await fetch("/api/path/progress", {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ path_id: pathId, course_id: courseId, username: username })
});
var j = await r.json().catch(function () { return {}; });
if (j && j.completed && j.cert_no) {
if (confirm(tr("cert_congrats"))) renderCertificateView(j.cert_no);
}
return j;
} catch (e) { return null; }
}

/* ================= 管理端：学习路径编辑器 ================= */
var _peState = null;

function _peParseIds(v) {
try { if (Array.isArray(v)) return v.slice(); var a = JSON.parse(v || "[]"); return Array.isArray(a) ? a : []; }
catch (e) { return []; }
}

function _peCourseById(cid) {
var arr = (typeof allData !== "undefined" && allData) || [];
for (var i = 0; i < arr.length; i++) if (String(arr[i].id) === String(cid)) return arr[i];
return null;
}

async function renderPathAdminList() {
var box = document.getElementById("pathAdminList");
if (!box) return;
box.innerHTML = '<div class="text-sm text-slate-400">加载中…</div>';
try {
var r = await fetch("/api/paths");
var j = await r.json();
var paths = j.paths || [];
if (!paths.length) { box.innerHTML = '<div class="text-sm text-slate-400">暂无路径，点击右上角新增</div>'; return; }
box.innerHTML = paths.map(function (p) {
return '<div class="flex items-center gap-3 border border-slate-100 rounded-2xl px-4 py-3">'
+ '<div class="flex-1 min-w-0"><div class="font-bold text-slate-800 truncate">' + escP(p.title || p.id) + '</div>'
+ '<div class="text-xs text-slate-400">' + (p.course_count || 0) + ' 门课程</div></div>'
+ '<button data-pid="' + escP(p.id) + '" onclick="openPathEditor(this.dataset.pid)" class="text-xs bg-indigo-50 text-indigo-700 px-4 py-2 rounded-xl font-bold hover:bg-indigo-100 shrink-0">编辑</button>'
+ '</div>';
}).join("");
} catch (e) {
box.innerHTML = '<div class="text-sm text-red-400">加载失败，请重试</div>';
}
}

function _peEnsureModal() {
var m = document.getElementById("pathEditorModal");
if (m) return m;
m = document.createElement("div");
m.id = "pathEditorModal";
m.className = "hidden fixed inset-0 z-[90]";
m.innerHTML = '<div class="absolute inset-0 bg-slate-900/90" onclick="closePathEditor()"></div>'
+ '<div class="relative bg-white w-full max-w-4xl mx-auto my-3 rounded-3xl max-h-[95vh] overflow-y-auto p-6 md:p-8">'
+ '<div id="peBody"></div></div>';
document.body.appendChild(m);
return m;
}

function closePathEditor() {
var m = document.getElementById("pathEditorModal");
if (m) m.classList.add("hidden");
try { document.body.style.overflow = ""; } catch (e) {}
_peState = null;
}

async function openPathEditor(pid) {
var m = _peEnsureModal();
document.getElementById("peBody").innerHTML = '<div class="text-sm text-slate-400 py-10 text-center">加载中…</div>';
m.classList.remove("hidden");
try { document.body.style.overflow = "hidden"; } catch (e) {}
var p = null;
if (pid) {
try { var r = await fetch("/api/path?id=" + encodeURIComponent(pid)); var j = await r.json(); p = j.path || null; } catch (e) {}
}
_peState = {
id: pid || "",
title: p ? (p.title || "") : "",
title_en: p ? (p.title_en || "") : "", title_ja: p ? (p.title_ja || "") : "", title_ko: p ? (p.title_ko || "") : "",
descr: p ? (p.descr || "") : "",
descr_en: p ? (p.descr_en || "") : "", descr_ja: p ? (p.descr_ja || "") : "", descr_ko: p ? (p.descr_ko || "") : "",
sort_order: p ? (p.sort_order || 0) : 0,
courseIds: _peParseIds(p && p.course_ids),
filter: "",
treeCollapsed: {}
};
_peRender();
}

/* 已选课程：按系列→子栏目树状展示（与学员端分组规则一致），序号为路径全局顺序 */
function _peSelectedTreeHtml() {
var st = _peState;
if (!st || !st.courseIds.length) return "";
var cats = {}, catOrder = [];
st.courseIds.forEach(function (cid, idx) {
var c = _peCourseById(cid);
var cat = c ? (c.category || "未分类") : "未知";
var sub = c ? (c.subcategory || "") : "";
if (!cats[cat]) { cats[cat] = { subs: {}, subOrder: [], count: 0 }; catOrder.push(cat); }
if (!cats[cat].subs[sub]) { cats[cat].subs[sub] = []; cats[cat].subOrder.push(sub); }
cats[cat].subs[sub].push({ cid: cid, idx: idx, c: c });
cats[cat].count++;
});
if (!st.treeCollapsed) st.treeCollapsed = {};
return catOrder.map(function (cat) {
var g = cats[cat];
var ck = "c:" + cat;
var cCollapsed = !!st.treeCollapsed[ck];
var subHtml = g.subOrder.map(function (sub) {
var items = g.subs[sub];
var rows = items.map(function (it) {
var t = it.c ? (it.c.title || it.cid) : (it.cid + "（已下架）");
return '<div class="flex items-center gap-2 border border-slate-100 rounded-xl px-3 py-2 bg-white mb-1">'
+ '<span class="w-6 h-6 shrink-0 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center">' + (it.idx + 1) + '</span>'
+ '<span class="flex-1 min-w-0 truncate text-sm font-medium text-slate-700">' + escP(t) + '</span>'
+ '<button data-i="' + it.idx + '" onclick="peMove(this.dataset.i,-1)" class="text-slate-400 hover:text-indigo-600 px-1.5 text-xs" title="上移">▲</button>'
+ '<button data-i="' + it.idx + '" onclick="peMove(this.dataset.i,1)" class="text-slate-400 hover:text-indigo-600 px-1.5 text-xs" title="下移">▼</button>'
+ '<button data-i="' + it.idx + '" onclick="peRemove(this.dataset.i)" class="text-slate-400 hover:text-red-500 px-1.5" title="移除">✕</button>'
+ '</div>';
}).join("");
if (!sub) return '<div class="ml-1">' + rows + '</div>';
var sk = "s:" + cat + "||" + sub;
var sCollapsed = !!st.treeCollapsed[sk];
return '<div class="ml-1 md:ml-4 mb-2">'
+ '<div class="flex items-center gap-1.5 mb-1.5">'
+ '<button data-k="' + escP(sk).replace(/"/g, "&quot;") + '" onclick="peToggleTree(this.dataset.k)" class="text-xs text-violet-500 w-4 text-center shrink-0">' + (sCollapsed ? "▶" : "▼") + '</button>'
+ '<span class="text-xs font-bold text-slate-600 flex-1 min-w-0 truncate">📁 ' + escP(sub) + '（' + items.length + '）</span>'
+ '<button data-cat="' + escP(cat).replace(/"/g, "&quot;") + '" data-sub="' + escP(sub).replace(/"/g, "&quot;") + '" onclick="peRemoveSub(this.dataset.cat,this.dataset.sub)" class="text-xs text-red-400 hover:text-red-600 shrink-0">移除本组</button>'
+ '</div>'
+ (sCollapsed ? '' : rows) + '</div>';
}).join("");
return '<div class="mb-3 border border-slate-100 rounded-2xl p-3 bg-white">'
+ '<div class="flex items-center gap-1.5 mb-2">'
+ '<button data-k="' + escP(ck).replace(/"/g, "&quot;") + '" onclick="peToggleTree(this.dataset.k)" class="text-sm text-violet-500 w-5 text-center shrink-0">' + (cCollapsed ? "▶" : "▼") + '</button>'
+ '<span class="text-sm font-bold text-slate-800 flex-1 min-w-0 truncate">' + escP(cat) + '（' + g.count + ' 门）</span>'
+ '<button data-cat="' + escP(cat).replace(/"/g, "&quot;") + '" onclick="peRemoveCat(this.dataset.cat)" class="text-xs text-red-400 hover:text-red-600 shrink-0">移除整系列</button>'
+ '</div>'
+ (cCollapsed ? '' : subHtml) + '</div>';
}).join("");
}

function peToggleTree(k) {
if (!_peState) return;
if (!_peState.treeCollapsed) _peState.treeCollapsed = {};
if (_peState.treeCollapsed[k]) delete _peState.treeCollapsed[k]; else _peState.treeCollapsed[k] = 1;
_peRender();
}

function _peRender() {
var st = _peState;
if (!st) return;
var body = document.getElementById("peBody");
if (!body) return;
var selHtml = _peSelectedTreeHtml();
var kw = (st.filter || "").toLowerCase();
var groups = {}, order = [];
((typeof allData !== "undefined" && allData) || []).forEach(function (c) {
if (st.courseIds.indexOf(String(c.id)) >= 0) return;
if (kw && ((c.title || "") + "|" + (c.category || "") + "|" + (c.subcategory || "")).toLowerCase().indexOf(kw) < 0) return;
var k = c.category || "未分类";
if (!groups[k]) { groups[k] = { list: [], subs: {}, subOrder: [] }; order.push(k); }
groups[k].list.push(c);
var sk = c.subcategory || "";
if (!groups[k].subs[sk]) { groups[k].subs[sk] = []; groups[k].subOrder.push(sk); }
groups[k].subs[sk].push(c);
});
var pickHtml = order.map(function (k) {
var g = groups[k];
var allIds = g.list.map(function (c) { return String(c.id); }).join(",");
var subHtml = g.subOrder.map(function (sk) {
var ids = g.subs[sk].map(function (c) { return String(c.id); }).join(",");
var label = sk || "（无子栏目）";
return '<div class="ml-3 mb-2"><div class="flex items-center gap-2 mb-1">'
+ '<span class="text-xs text-slate-500 flex-1 min-w-0 truncate">📁 ' + escP(label) + '（' + g.subs[sk].length + '）</span>'
+ '<button data-ids="' + escP(ids) + '" onclick="peAddMany(this.dataset.ids)" class="text-xs text-indigo-600 hover:text-indigo-800 font-bold shrink-0">＋ 加入本组</button></div>'
+ '<div class="space-y-1">' + g.subs[sk].map(function (c) {
return '<div class="flex items-center gap-2 text-sm border border-slate-50 rounded-lg px-3 py-1.5">'
+ '<span class="flex-1 min-w-0 truncate text-slate-600">' + escP(c.title || c.id) + '</span>'
+ '<button data-cid="' + escP(c.id) + '" onclick="peAdd(this.dataset.cid)" class="text-indigo-600 hover:text-indigo-800 font-bold px-2" title="加入路径">＋</button>'
+ '</div>';
}).join("") + '</div></div>';
}).join("");
return '<div class="mb-3 border border-slate-100 rounded-2xl p-3"><div class="flex items-center gap-2 mb-2">'
+ '<span class="text-sm font-bold text-slate-700 flex-1 min-w-0 truncate">' + escP(k) + '（' + g.list.length + ' 门未加入）</span>'
+ '<button data-ids="' + escP(allIds) + '" onclick="peAddMany(this.dataset.ids)" class="text-xs bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-lg font-bold hover:bg-indigo-100 shrink-0">＋ 整系列加入</button></div>'
+ subHtml + '</div>';
}).join("") || '<div class="text-sm text-slate-400 py-4 text-center">没有可添加的课程</div>';
body.innerHTML = '<div class="flex items-center justify-between mb-5">'
+ '<h2 class="font-black text-lg">' + (st.id ? "编辑学习路径" : "新增学习路径") + '</h2>'
+ '<button onclick="closePathEditor()" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full text-lg">✕</button></div>'
+ '<label class="text-xs font-bold text-slate-500 mb-1 block">标题（中文）</label>'
+ '<input id="peTitle" value="' + escP(st.title).replace(/"/g, "&quot;") + '" placeholder="如：初信者" class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-3">'
+ '<label class="text-xs font-bold text-slate-500 mb-1 block">简介（中文）</label>'
+ '<textarea id="peDescr" placeholder="一句话介绍这条路径" class="w-full h-20 border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-3">' + escP(st.descr) + '</textarea>'
+ '<details class="mb-4"><summary class="text-xs font-bold text-slate-500 cursor-pointer">多语言标题 / 简介（英日韩，可空，空则显示中文）</summary>'
+ '<div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">'
+ '<div><label class="text-xs text-slate-400 block mb-1">English title</label><input id="peTitleEn" value="' + escP(st.title_en).replace(/"/g, "&quot;") + '" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm mb-2">'
+ '<label class="text-xs text-slate-400 block mb-1">English intro</label><textarea id="peDescrEn" class="w-full h-16 border border-slate-200 rounded-xl px-3 py-2 text-sm">' + escP(st.descr_en) + '</textarea></div>'
+ '<div><label class="text-xs text-slate-400 block mb-1">日本語タイトル</label><input id="peTitleJa" value="' + escP(st.title_ja).replace(/"/g, "&quot;") + '" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm mb-2">'
+ '<label class="text-xs text-slate-400 block mb-1">日本語紹介</label><textarea id="peDescrJa" class="w-full h-16 border border-slate-200 rounded-xl px-3 py-2 text-sm">' + escP(st.descr_ja) + '</textarea></div>'
+ '<div><label class="text-xs text-slate-400 block mb-1">한국어 제목</label><input id="peTitleKo" value="' + escP(st.title_ko).replace(/"/g, "&quot;") + '" class="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm mb-2">'
+ '<label class="text-xs text-slate-400 block mb-1">한국어 소개</label><textarea id="peDescrKo" class="w-full h-16 border border-slate-200 rounded-xl px-3 py-2 text-sm">' + escP(st.descr_ko) + '</textarea></div>'
+ '</div></details>'
+ '<div class="flex items-center justify-between mb-2"><h3 class="font-bold text-slate-800">路径课程（' + st.courseIds.length + ' 门，按顺序学习）</h3></div>' 
+ '<div id="peSelected" class="space-y-1.5 mb-6 max-h-72 overflow-y-auto border border-slate-100 rounded-2xl p-2 bg-slate-50/50">'
+ (selHtml || '<div class="text-sm text-slate-400 py-6 text-center">暂无课程，从下方添加</div>') + '</div>'
+ '<h3 class="font-bold text-slate-800 mb-2">添加课程</h3>'
+ '<input id="peFilter" value="' + escP(st.filter).replace(/"/g, "&quot;") + '" oninput="peFilter(this.value)" placeholder="搜索课程标题…" class="w-full border border-slate-200 rounded-2xl px-4 py-2.5 text-sm outline-none focus:border-indigo-400 mb-3">'
+ '<div class="max-h-72 overflow-y-auto border border-slate-100 rounded-2xl p-3 mb-6">' + pickHtml + '</div>'
+ '<div class="flex gap-3">'
+ '<button id="peSaveBtn" onclick="peSave()" class="flex-1 bg-indigo-900 text-white py-3 rounded-2xl font-bold">保存</button>'
+ (st.id ? '<button onclick="peDelete()" class="bg-red-50 text-red-600 px-6 py-3 rounded-2xl font-bold">删除</button>' : '')
+ '<button onclick="closePathEditor()" class="bg-slate-200 text-slate-600 px-6 py-3 rounded-2xl font-bold">取消</button>'
+ '</div>';
var fi = document.getElementById("peFilter");
}

function peAdd(cid) {
peAddMany(String(cid));
}
function peAddMany(ids) {
if (!_peState) return;
var arr = String(ids || "").split(",").map(function (x) { return x.trim(); }).filter(function (x) { return !!x; });
var added = 0;
arr.forEach(function (cid) {
if (_peState.courseIds.indexOf(cid) < 0) { _peState.courseIds.push(cid); added++; }
});
if (added > 0) _peRender();
var fi = document.getElementById("peFilter");
if (fi) { try { fi.focus(); fi.setSelectionRange(fi.value.length, fi.value.length); } catch (e) {} }
}

function peRemove(i) {
if (!_peState) return;
i = parseInt(i, 10);
_peState.courseIds.splice(i, 1);
_peRender();
}



function peRemoveCat(cat) {
if (!_peState) return;
var keep = [];
_peState.courseIds.forEach(function (cid) {
var c = _peCourseById(cid);
var cc = c ? (c.category || "未分类") : "未知";
if (cc !== cat) keep.push(cid);
});
var n = _peState.courseIds.length - keep.length;
if (n > 0 && confirm("确定从路径中移除系列「" + cat + "」的 " + n + " 门课程吗？")) {
_peState.courseIds = keep;
_peRender();
}
}

function peRemoveSub(cat, sub) {
if (!_peState) return;
var keep = [];
_peState.courseIds.forEach(function (cid) {
var c = _peCourseById(cid);
var cc = c ? (c.category || "未分类") : "未知";
var cs = c ? (c.subcategory || "") : "";
if (!(cc === cat && cs === sub)) keep.push(cid);
});
var n = _peState.courseIds.length - keep.length;
if (n > 0 && confirm("确定从路径中移除子栏目「" + sub + "」的 " + n + " 门课程吗？")) {
_peState.courseIds = keep;
_peRender();
}
}

function peMove(i, dir) {
if (!_peState) return;
i = parseInt(i, 10);
var a = _peState.courseIds, j = i + dir;
if (i < 0 || i >= a.length || j < 0 || j >= a.length) return;
var t = a[i]; a[i] = a[j]; a[j] = t;
_peRender();
}

var _peFilterT = null;
function peFilter(v) {
if (!_peState) return;
_peState.filter = v;
clearTimeout(_peFilterT);
_peFilterT = setTimeout(function () {
var sel = document.getElementById("peSelected");
var selHtml = sel ? sel.innerHTML : "";
_peRender();
}, 200);
}

function _peCollect() {
var st = _peState;
var g = function (id) { var e = document.getElementById(id); return e ? e.value : ""; };
st.title = g("peTitle").trim();
st.title_en = g("peTitleEn").trim(); st.title_ja = g("peTitleJa").trim(); st.title_ko = g("peTitleKo").trim();
st.descr = g("peDescr").trim();
st.descr_en = g("peDescrEn").trim(); st.descr_ja = g("peDescrJa").trim(); st.descr_ko = g("peDescrKo").trim();
return st;
}

async function peSave() {
var st = _peCollect();
if (!st.title) { alert("标题不能为空"); return; }
var btn = document.getElementById("peSaveBtn");
if (btn) { btn.disabled = true; btn.innerText = "保存中…"; }
try {
var r = await fetch("/api/path/save", {
method: "POST", headers: { "Content-Type": "application/json" },
body: JSON.stringify({
id: st.id || undefined,
title: st.title, title_en: st.title_en, title_ja: st.title_ja, title_ko: st.title_ko,
descr: st.descr, descr_en: st.descr_en, descr_ja: st.descr_ja, descr_ko: st.descr_ko,
course_ids: st.courseIds, sort_order: st.sort_order
})
});
var j = await r.json();
if (j && j.success) {
closePathEditor();
renderPathAdminList();
try { if (typeof BOOT === "undefined" || !BOOT.isAdmin) { if (typeof renderPathsPage === "function") renderPathsPage(); } } catch (e) {}
} else {
alert("保存失败：" + ((j && j.error) || "未知错误"));
if (btn) { btn.disabled = false; btn.innerText = "保存"; }
}
} catch (e) {
alert("保存失败：网络错误");
if (btn) { btn.disabled = false; btn.innerText = "保存"; }
}
}

async function peDelete() {
var st = _peState;
if (!st || !st.id) return;
if (!confirm("确定删除路径「" + st.title + "」吗？学员在这条路径上的学习进度将被清除（已颁发的证书保留）。")) return;
try {
var r = await fetch("/api/path/delete", {
method: "POST", headers: { "Content-Type": "application/json" },
body: JSON.stringify({ id: st.id })
});
var j = await r.json();
if (j && j.success) {
closePathEditor();
renderPathAdminList();
try { if (typeof BOOT === "undefined" || !BOOT.isAdmin) { if (typeof renderPathsPage === "function") renderPathsPage(); } } catch (e) {}
} else {
alert("删除失败：" + ((j && j.error) || "未知错误"));
}
} catch (e) { alert("删除失败：网络错误"); }
}
/* ================= 社交页面统一渲染出口 ================= */
function showSocialPage(html) {
var sr = document.getElementById("socialRoot");
if (!sr) return;
var pr = document.getElementById("pathsRoot");
var cw = document.getElementById("catalogWrap");
if (pr) pr.style.display = "none";
if (cw) cw.style.display = "none";
sr.style.display = "";
var backLabel = "← 返回";
try { if (typeof tr === "function") backLabel = tr("social_back") || backLabel; } catch (e) {}
sr.innerHTML = '<div class="mb-4"><button onclick="hideSocialPage()" class="text-sm font-bold text-slate-500 hover:text-slate-700 transition">' + backLabel + '</button></div>' + html;
try { sr.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {}
try { if (typeof applyI18n === "function") applyI18n(); } catch (e) {}
}

function hideSocialPage() {
var sr = document.getElementById("socialRoot");
if (sr) { sr.style.display = "none"; sr.innerHTML = ""; }
var isAdmin = false;
try { isAdmin = !!(typeof BOOT !== "undefined" && BOOT.isAdmin); } catch (e) {}
if (!isAdmin && typeof showHomeView === "function") {
showHomeView("paths");
} else {
var pr = document.getElementById("pathsRoot");
var cw = document.getElementById("catalogWrap");
if (pr) pr.style.display = "";
if (cw) cw.style.display = "none";
}
}

// I18N-KEYS: 新增文案（zh / en / ja / ko），集成时已由本文件自动合并进全局 I18N，无需改 i18n.js
// cls_title: 班级小组 / Classes & Groups / クラス・グループ / 반・그룹
// cls_my: 我的班级 / My Classes / マイクラス / 내 반
// cls_all: 全部班级 / All Classes / すべてのクラス / 모든 반
// cls_join: 加入 / Join / 参加する / 가입하기
// cls_leave: 退出 / Leave / 退会する / 탈퇴하기
// cls_members: 成员 / Members / メンバー / 구성원
// cls_leader: 小组长 / Leader / リーダー / 조장
// cls_count: {n} 人 / {n} members / {n} 人 / {n}명
// cls_noDesc: 暂无简介 / No description / 紹介なし / 소개 없음
// cls_empty: 还没有班级 / No classes yet / クラスはまだありません / 반이 아직 없습니다
// cls_needLogin: 请先设置学员姓名 / Please set your student name first / 学習者名を先に設定してください / 학습자 이름을 먼저 설정해 주세요
// cls_joined: 已加入 / Joined / 参加済み / 가입됨
// cls_joinOk: 加入成功 / Joined successfully / 参加しました / 가입했습니다
// cls_leaveOk: 已退出 / Left successfully / 退会しました / 탈퇴했습니다
// cls_confirmLeave: 确定退出该班级？ / Leave this class? / このクラスを退会しますか？ / 이 반에서 탈퇴하시겠습니까?
// cls_new: 新建班级 / New Class / 新規クラス / 새 반 만들기
// cls_edit: 编辑 / Edit / 編集 / 편집
// cls_delete: 删除 / Delete / 削除 / 삭제
// cls_name: 班级名称 / Class Name / クラス名 / 반 이름
// cls_descr: 简介 / Description / 紹介 / 소개
// cls_leaderPh: 小组长用户名（可选） / Leader username (optional) / リーダーのユーザー名（任意） / 조장 사용자 이름 (선택 사항)
// cls_save: 保存 / Save / 保存 / 저장
// cls_confirmDel: 确定删除该班级？成员关系将一并删除 / Delete this class? All memberships will be removed too / このクラスを削除しますか？メンバーシップも一緒に削除されます / 이 반을 삭제하시겠습니까? 구성원 관계도 함께 삭제됩니다
// cls_viewMembers: 查看成员 / View Members / メンバーを見る / 구성원 보기
// cls_adminTitle: 班级管理 / Class Management / クラス管理 / 반 관리
// cls_noLeader: 暂无 / None / なし / 없음
// cls_opFail: 操作失败，请重试 / Operation failed, please try again / 操作に失敗しました、もう一度お試しください / 작업 실패, 다시 시도해 주세요
// bdg_title: 我的徽章 / My Badges / マイバッジ / 내 배지
// bdg_earned: 已获得 / Earned / 獲得済み / 획득함
// bdg_locked: 未解锁 / Locked / 未解除 / 잠김
// bdg_count: 已获得 {a} / {b} / {a} of {b} earned / {a} / {b} 獲得済み / {a} / {b} 획득
// bdg_first_step: 初涉真理 / First Step / はじめの一歩 / 첫걸음
// bdg_first_step_desc: 完成 1 门课程 / Complete 1 course / コースを1つ修了する / 과정 1개 완료
// bdg_diligent: 勤奋好学 / Diligent Learner / 勤勉な学習者 / 근면한 학습자
// bdg_diligent_desc: 完成 10 门课程 / Complete 10 courses / コースを10個修了する / 과정 10개 완료
// bdg_scholar: 荣誉学员 / Honor Scholar / 優等生 / 우등생
// bdg_scholar_desc: 平均分达到 90 分 / Average score of 90 or above / 平均点90点以上 / 평균 90점 이상
// bdg_persistent: 持之以恒 / Persistent / 継続は力なり / 꾸준함의 힘
// bdg_persistent_desc: 连续 7 天学习 / Study 7 days in a row / 7日間連続で学習する / 7일 연속 학습
// bdg_perfect: 完美答卷 / Perfect Score / 満点 / 만점
// bdg_perfect_desc: 单门课程获得满分 / Score full marks in one course / 1つのコースで満点を取る / 한 과정에서 만점 받기
// bdg_explorer: 真理探索者 / Truth Explorer / 真理の探求者 / 진리 탐험가
// bdg_explorer_desc: 完成 3 个不同系列的课程 / Complete courses from 3 different series / 3つの異なるシリーズのコースを修了する / 서로 다른 3개 시리즈의 과정 완료
// stat_title: 使用统计 / Usage Statistics / 利用統計 / 사용 통계
// stat_students: 学员总数 / Total Students / 学習者総数 / 전체 학습자 수
// stat_courses: 课程总数 / Total Courses / コース総数 / 전체 과정 수
// stat_completions: 完成人次 / Completions / 修了延べ人数 / 완료 횟수
// stat_avgScore: 平均分 / Average Score / 平均点 / 평균 점수
// stat_active7: 近7天活跃 / Active in 7 Days / 直近7日間のアクティブ / 최근 7일 활성
// stat_topCourses: 热门课程 TOP5 / Top 5 Courses / 人気コースTOP5 / 인기 과정 TOP5
// stat_wrongsByType: 错题题型分布 / Wrong Answers by Type / タイプ別ミス分布 / 유형별 오답 분포
// stat_times: {n} 人次 / {n} completions / 延べ {n} 人 / {n}회
// stat_noData: 暂无数据 / No data / データなし / 데이터 없음
// stat_needAdmin: 需要管理员权限 / Admin access required / 管理者権限が必要です / 관리자 권한이 필요합니다

/* 团契智学 · 社交 UI：班级页 + 徽章页 + 管理端统计看板
 *
 * 外部依赖（调用方/宿主页面提供，本文件不定义）：
 *   - tr(k), tf(k, obj)        来自 src/client/main.js + src/client/i18n.js（四语言文案）
 *   - fetch                    浏览器原生
 *   - localStorage             浏览器原生（读学员姓名，key "FELLOW_V12"；优先用宿主的 progName()）
 * 本文件自带 SOCIAL_I18N 并在加载时自动合并进全局 I18N，无需改动 i18n.js。
 *
 * 集成方式：
 *   - 构建时把本文件拼进下发脚本（参考 build.py 处理 client/*.js 的方式），或在页面中用 script 标签引入
 *   - 班级页：  document.getElementById("page").innerHTML = await renderClassesPage({ admin: isAdmin })
 *   - 徽章页：  document.getElementById("page").innerHTML = await renderBadgesPage(username)
 *   - 统计页：  document.getElementById("page").innerHTML = await renderStatsPage()
 *   - 全局动作函数 socialJoin / socialLeave / socialToggleMembers / socialDelClass / socialEditClass / socialSaveClass
 *     需挂在 window 上（本文件末尾已挂载），供 onclick 调用
 */

var SOCIAL_I18N = {
zh: {
cls_title: "班级小组", cls_my: "我的班级", cls_all: "全部班级", cls_join: "加入", cls_leave: "退出",
cls_members: "成员", cls_leader: "小组长", cls_count: "{n} 人", cls_noDesc: "暂无简介", cls_empty: "还没有班级",
cls_needLogin: "请先设置学员姓名", cls_joined: "已加入", cls_joinOk: "加入成功", cls_leaveOk: "已退出",
cls_confirmLeave: "确定退出该班级？", cls_new: "新建班级", cls_edit: "编辑", cls_delete: "删除",
cls_name: "班级名称", cls_descr: "简介", cls_leaderPh: "小组长用户名（可选）", cls_save: "保存",
cls_confirmDel: "确定删除该班级？成员关系将一并删除", cls_viewMembers: "查看成员", cls_adminTitle: "班级管理", cls_noLeader: "暂无", cls_opFail: "操作失败，请重试",
bdg_title: "我的徽章", bdg_earned: "已获得", bdg_locked: "未解锁", bdg_count: "已获得 {a} / {b}",
bdg_first_step: "初涉真理", bdg_first_step_desc: "完成 1 门课程",
bdg_diligent: "勤奋好学", bdg_diligent_desc: "完成 10 门课程",
bdg_scholar: "荣誉学员", bdg_scholar_desc: "平均分达到 90 分",
bdg_persistent: "持之以恒", bdg_persistent_desc: "连续 7 天学习",
bdg_perfect: "完美答卷", bdg_perfect_desc: "单门课程获得满分",
bdg_explorer: "真理探索者", bdg_explorer_desc: "完成 3 个不同系列的课程",
stat_title: "使用统计", stat_students: "学员总数", stat_courses: "课程总数", stat_completions: "完成人次",
stat_avgScore: "平均分", stat_active7: "近7天活跃", stat_topCourses: "热门课程 TOP5",
stat_wrongsByType: "错题题型分布", stat_times: "{n} 人次", stat_noData: "暂无数据", stat_needAdmin: "需要管理员权限"
},
en: {
cls_title: "Classes & Groups", cls_my: "My Classes", cls_all: "All Classes", cls_join: "Join", cls_leave: "Leave",
cls_members: "Members", cls_leader: "Leader", cls_count: "{n} members", cls_noDesc: "No description", cls_empty: "No classes yet",
cls_needLogin: "Please set your student name first", cls_joined: "Joined", cls_joinOk: "Joined successfully", cls_leaveOk: "Left successfully",
cls_confirmLeave: "Leave this class?", cls_new: "New Class", cls_edit: "Edit", cls_delete: "Delete",
cls_name: "Class Name", cls_descr: "Description", cls_leaderPh: "Leader username (optional)", cls_save: "Save",
cls_confirmDel: "Delete this class? All memberships will be removed too", cls_viewMembers: "View Members", cls_adminTitle: "Class Management", cls_noLeader: "None", cls_opFail: "Operation failed, please try again",
bdg_title: "My Badges", bdg_earned: "Earned", bdg_locked: "Locked", bdg_count: "{a} of {b} earned",
bdg_first_step: "First Step", bdg_first_step_desc: "Complete 1 course",
bdg_diligent: "Diligent Learner", bdg_diligent_desc: "Complete 10 courses",
bdg_scholar: "Honor Scholar", bdg_scholar_desc: "Average score of 90 or above",
bdg_persistent: "Persistent", bdg_persistent_desc: "Study 7 days in a row",
bdg_perfect: "Perfect Score", bdg_perfect_desc: "Score full marks in one course",
bdg_explorer: "Truth Explorer", bdg_explorer_desc: "Complete courses from 3 different series",
stat_title: "Usage Statistics", stat_students: "Total Students", stat_courses: "Total Courses", stat_completions: "Completions",
stat_avgScore: "Average Score", stat_active7: "Active in 7 Days", stat_topCourses: "Top 5 Courses",
stat_wrongsByType: "Wrong Answers by Type", stat_times: "{n} completions", stat_noData: "No data", stat_needAdmin: "Admin access required"
},
ja: {
cls_title: "クラス・グループ", cls_my: "マイクラス", cls_all: "すべてのクラス", cls_join: "参加する", cls_leave: "退会する",
cls_members: "メンバー", cls_leader: "リーダー", cls_count: "{n} 人", cls_noDesc: "紹介なし", cls_empty: "クラスはまだありません",
cls_needLogin: "学習者名を先に設定してください", cls_joined: "参加済み", cls_joinOk: "参加しました", cls_leaveOk: "退会しました",
cls_confirmLeave: "このクラスを退会しますか？", cls_new: "新規クラス", cls_edit: "編集", cls_delete: "削除",
cls_name: "クラス名", cls_descr: "紹介", cls_leaderPh: "リーダーのユーザー名（任意）", cls_save: "保存",
cls_confirmDel: "このクラスを削除しますか？メンバーシップも一緒に削除されます", cls_viewMembers: "メンバーを見る", cls_adminTitle: "クラス管理", cls_noLeader: "なし", cls_opFail: "操作に失敗しました、もう一度お試しください",
bdg_title: "マイバッジ", bdg_earned: "獲得済み", bdg_locked: "未解除", bdg_count: "{a} / {b} 獲得済み",
bdg_first_step: "はじめの一歩", bdg_first_step_desc: "コースを1つ修了する",
bdg_diligent: "勤勉な学習者", bdg_diligent_desc: "コースを10個修了する",
bdg_scholar: "優等生", bdg_scholar_desc: "平均点90点以上",
bdg_persistent: "継続は力なり", bdg_persistent_desc: "7日間連続で学習する",
bdg_perfect: "満点", bdg_perfect_desc: "1つのコースで満点を取る",
bdg_explorer: "真理の探求者", bdg_explorer_desc: "3つの異なるシリーズのコースを修了する",
stat_title: "利用統計", stat_students: "学習者総数", stat_courses: "コース総数", stat_completions: "修了延べ人数",
stat_avgScore: "平均点", stat_active7: "直近7日間のアクティブ", stat_topCourses: "人気コースTOP5",
stat_wrongsByType: "タイプ別ミス分布", stat_times: "延べ {n} 人", stat_noData: "データなし", stat_needAdmin: "管理者権限が必要です"
},
ko: {
cls_title: "반・그룹", cls_my: "내 반", cls_all: "모든 반", cls_join: "가입하기", cls_leave: "탈퇴하기",
cls_members: "구성원", cls_leader: "조장", cls_count: "{n}명", cls_noDesc: "소개 없음", cls_empty: "반이 아직 없습니다",
cls_needLogin: "학습자 이름을 먼저 설정해 주세요", cls_joined: "가입됨", cls_joinOk: "가입했습니다", cls_leaveOk: "탈퇴했습니다",
cls_confirmLeave: "이 반에서 탈퇴하시겠습니까?", cls_new: "새 반 만들기", cls_edit: "편집", cls_delete: "삭제",
cls_name: "반 이름", cls_descr: "소개", cls_leaderPh: "조장 사용자 이름 (선택 사항)", cls_save: "저장",
cls_confirmDel: "이 반을 삭제하시겠습니까? 구성원 관계도 함께 삭제됩니다", cls_viewMembers: "구성원 보기", cls_adminTitle: "반 관리", cls_noLeader: "없음", cls_opFail: "작업 실패, 다시 시도해 주세요",
bdg_title: "내 배지", bdg_earned: "획득함", bdg_locked: "잠김", bdg_count: "{a} / {b} 획득",
bdg_first_step: "첫걸음", bdg_first_step_desc: "과정 1개 완료",
bdg_diligent: "근면한 학습자", bdg_diligent_desc: "과정 10개 완료",
bdg_scholar: "우등생", bdg_scholar_desc: "평균 90점 이상",
bdg_persistent: "꾸준함의 힘", bdg_persistent_desc: "7일 연속 학습",
bdg_perfect: "만점", bdg_perfect_desc: "한 과정에서 만점 받기",
bdg_explorer: "진리 탐험가", bdg_explorer_desc: "서로 다른 3개 시리즈의 과정 완료",
stat_title: "사용 통계", stat_students: "전체 학습자 수", stat_courses: "전체 과정 수", stat_completions: "완료 횟수",
stat_avgScore: "평균 점수", stat_active7: "최근 7일 활성", stat_topCourses: "인기 과정 TOP5",
stat_wrongsByType: "유형별 오답 분포", stat_times: "{n}회", stat_noData: "데이터 없음", stat_needAdmin: "관리자 권한이 필요합니다"
}
};

/* 自动合并进全局 I18N（若宿主已定义） */
(function () {
try {
if (typeof I18N === "undefined") return;
var langs = ["zh", "en", "ja", "ko"];
for (var i = 0; i < langs.length; i++) {
var L = langs[i];
I18N[L] = I18N[L] || {};
for (var k in SOCIAL_I18N[L]) {
if (Object.prototype.hasOwnProperty.call(SOCIAL_I18N[L], k)) I18N[L][k] = SOCIAL_I18N[L][k];
}
}
} catch (e) {}
})();

/* ---------- 小工具 ---------- */
function socialUser() {
try {
if (typeof progName === "function") { var n = progName(); if (n) return n; }
return (localStorage.getItem("FELLOW_V12") || "").trim();
} catch (e) { return ""; }
}
/* D1 内容繁体转换（tw 模式下实时转） */
function socialTw(s) {
try {
if (typeof curLang === "function" && curLang() === "tw" && typeof toTW === "function") return toTW(s);
} catch (e) {}
return s;
}
function socialEsc(s) {
return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
async function socialGet(path) {
const r = await fetch(path, { credentials: "same-origin" });
if (!r.ok) { const e = new Error("http " + r.status); e.status = r.status; throw e; }
return r.json();
}
async function socialPost(path, body) {
const r = await fetch(path, { method: "POST", credentials: "same-origin",
headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
if (!r.ok) { const e = new Error("http " + r.status); e.status = r.status; throw e; }
return r.json();
}
function socialT(k) { try { return (typeof tr === "function") ? tr(k) : k; } catch (e) { return k; } }
function socialTf(k, obj) { try { return (typeof tf === "function") ? tf(k, obj || {}) : k; } catch (e) { return k; } }

/* ---------- 班级页 ---------- */
function socialClassCard(c, mine, username, isAdmin) {
var joined = mine.indexOf(c.id) >= 0;
var h = '<div class="bg-white rounded-xl shadow p-4 mb-3">';
h += '<div class="flex justify-between items-start">';
h += '<div><div class="font-bold text-lg">' + socialEsc(socialTw(c.name)) + '</div>';
h += '<div class="text-sm text-gray-500 mt-1">' + socialEsc(socialTw(c.descr) || socialT("cls_noDesc")) + '</div>';
h += '<div class="text-xs text-gray-400 mt-2">' + socialT("cls_leader") + '：' + socialEsc(socialTw(c.leader) || socialT("cls_noLeader"))
+ ' · ' + socialTf("cls_count", { n: c.member_count || 0 }) + '</div></div>';
if (joined) {
h += '<span class="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700">' + socialT("cls_joined") + '</span>';
} else {
h += '<button class="text-sm px-3 py-1 rounded-full bg-blue-600 text-white" data-cid="' + c.id + '" onclick="socialJoin(this.dataset.cid)">'
+ socialT("cls_join") + '</button>';
}
h += '</div>';
if (joined) {
h += '<div class="mt-3 flex gap-2">';
h += '<button class="text-xs px-2 py-1 rounded border" data-cid="' + c.id + '" onclick="socialToggleMembers(this.dataset.cid)">'
+ socialT("cls_viewMembers") + '</button>';
h += '<button class="text-xs px-2 py-1 rounded border text-red-600" data-cid="' + c.id + '" onclick="socialLeave(this.dataset.cid)">'
+ socialT("cls_leave") + '</button>';
if (isAdmin) {
h += '<button class="text-xs px-2 py-1 rounded border" data-cid="' + c.id + '" onclick="socialEditClass(this.dataset.cid)">'
+ socialT("cls_edit") + '</button>';
h += '<button class="text-xs px-2 py-1 rounded border text-red-600" data-cid="' + c.id + '" onclick="socialDelClass(this.dataset.cid)">'
+ socialT("cls_delete") + '</button>';
}
h += '</div><div id="social-mem-' + c.id + '" class="mt-2 text-sm text-gray-600"></div>';
} else if (isAdmin) {
h += '<div class="mt-2 flex gap-2">';
h += '<button class="text-xs px-2 py-1 rounded border" data-cid="' + c.id + '" onclick="socialEditClass(this.dataset.cid)">'
+ socialT("cls_edit") + '</button>';
h += '<button class="text-xs px-2 py-1 rounded border text-red-600" data-cid="' + c.id + '" onclick="socialDelClass(this.dataset.cid)">'
+ socialT("cls_delete") + '</button>';
h += '</div>';
}
h += '</div>';
return h;
}

async function renderClassesPage(opts) {
opts = opts || {};
var isAdmin = !!opts.admin;
var username = socialUser();
var h = '<div class="max-w-3xl mx-auto px-4 py-4">';
h += '<h2 class="text-xl font-bold mb-4">👥 ' + socialT("cls_title") + '</h2>';
if (!username) {
h += '<div class="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm">' + socialT("cls_needLogin") + '</div></div>';
showSocialPage(h); return;
}
var classes = [];
try { classes = await socialGet("/api/classes"); } catch (e) { classes = []; }
/* 为判断"我的班级"，查各班成员（班级数通常不多；非管理员非组长会 403，视为未加入） */
var memberOf = {};
for (var i = 0; i < classes.length; i++) {
try {
var ms = await socialGet("/api/class/members?class_id=" + encodeURIComponent(classes[i].id) + "&username=" + encodeURIComponent(username));
for (var j = 0; j < ms.length; j++) if (ms[j].username === username) { memberOf[classes[i].id] = 1; break; }
} catch (e) { /* 非管理员非组长 403：视为未加入 */ }
}
var myIds = Object.keys(memberOf);
if (isAdmin) {
h += '<div class="bg-white rounded-xl shadow p-4 mb-4"><div class="font-bold mb-2">' + socialT("cls_adminTitle") + '</div>';
h += '<button class="text-sm px-3 py-1 rounded-full bg-blue-600 text-white" data-x="" onclick="socialEditClass(this.dataset.x)">'
+ socialT("cls_new") + '</button>';
h += '<div id="social-form"></div></div>';
}
if (myIds.length) {
h += '<h3 class="font-bold mt-2 mb-2">' + socialT("cls_my") + '</h3>';
for (var a = 0; a < classes.length; a++) {
if (memberOf[classes[a].id]) h += socialClassCard(classes[a], myIds, username, isAdmin);
}
}
h += '<h3 class="font-bold mt-4 mb-2">' + socialT("cls_all") + '</h3>';
if (!classes.length) {
h += '<div class="text-gray-400 text-sm">' + socialT("cls_empty") + '</div>';
} else {
for (var b = 0; b < classes.length; b++) h += socialClassCard(classes[b], myIds, username, isAdmin);
}
h += '</div>';
showSocialPage(h); return;
}

async function socialJoin(classId) {
var username = socialUser();
if (!username) { alert(socialT("cls_needLogin")); return; }
try {
await socialPost("/api/class/join", { class_id: classId, username: username });
alert(socialT("cls_joinOk"));
if (typeof refreshSocialPage === "function") refreshSocialPage();
else location.reload();
} catch (e) { alert(socialT("cls_opFail")); }
}

async function socialLeave(classId) {
var username = socialUser();
if (!username) return;
if (!confirm(socialT("cls_confirmLeave"))) return;
try {
await socialPost("/api/class/leave", { class_id: classId, username: username });
alert(socialT("cls_leaveOk"));
if (typeof refreshSocialPage === "function") refreshSocialPage();
else location.reload();
} catch (e) {}
}

async function socialToggleMembers(classId) {
var box = document.getElementById("social-mem-" + classId);
if (!box) return;
if (box.getAttribute("data-open") === "1") { box.innerHTML = ""; box.setAttribute("data-open", "0"); return; }
var username = socialUser();
try {
var ms = await socialGet("/api/class/members?class_id=" + encodeURIComponent(classId) + "&username=" + encodeURIComponent(username));
var h = '<div class="text-xs font-bold mb-1">' + socialT("cls_members") + ' (' + ms.length + ')</div><div class="flex flex-wrap gap-1">';
for (var i = 0; i < ms.length; i++) h += '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-100">' + socialEsc(ms[i].username) + '</span>';
h += '</div>';
box.innerHTML = h;
box.setAttribute("data-open", "1");
} catch (e) { box.innerHTML = ""; }
}

async function socialEditClass(classId) {
var adminBox = document.getElementById("adminClassForm");
var box = (adminBox ? adminBox : document.getElementById("social-form"));
if (!box) return;
var name = "", descr = "", leader = "";
if (classId) {
try {
var cs = await socialGet("/api/classes");
for (var i = 0; i < cs.length; i++) if (cs[i].id === classId) {
name = cs[i].name || ""; descr = cs[i].descr || ""; leader = cs[i].leader || ""; break;
}
} catch (e) {}
}
var h = '<div class="mt-3 border-t pt-3">'
+ '<input id="social-f-name" class="w-full border rounded px-2 py-1 mb-2 text-sm" placeholder="' + socialEsc(socialT("cls_name")) + '" value="' + socialEsc(name) + '">'
+ '<input id="social-f-descr" class="w-full border rounded px-2 py-1 mb-2 text-sm" placeholder="' + socialEsc(socialT("cls_descr")) + '" value="' + socialEsc(descr) + '">'
+ '<input id="social-f-leader" class="w-full border rounded px-2 py-1 mb-2 text-sm" placeholder="' + socialEsc(socialT("cls_leaderPh")) + '" value="' + socialEsc(leader) + '">'
+ '<button class="text-sm px-3 py-1 rounded bg-blue-600 text-white" data-cid="' + (classId || "") + '" onclick="socialSaveClass(this.dataset.cid)">'
+ socialT("cls_save") + '</button></div>';
box.innerHTML = h;
box.setAttribute("data-editing", classId || "");
}

async function socialSaveClass(classId) {
var name = (document.getElementById("social-f-name") || {}).value || "";
var descr = (document.getElementById("social-f-descr") || {}).value || "";
var leader = (document.getElementById("social-f-leader") || {}).value || "";
if (!name.trim()) { alert(socialT("cls_name")); return; }
try {
await socialPost("/api/class/save", { id: classId || undefined, name: name.trim(), descr: descr.trim(), leader: leader.trim() });
var ab = document.getElementById("adminClassForm");
if (ab) { ab.innerHTML = ""; if (typeof renderAdminClassesSection === "function") renderAdminClassesSection(); return; }
if (typeof refreshSocialPage === "function") refreshSocialPage();
else location.reload();
} catch (e) { alert(socialT("cls_opFail")); }
}

async function socialDelClass(classId) {
if (!confirm(socialT("cls_confirmDel"))) return;
try {
await socialPost("/api/class/delete", { class_id: classId });
if (document.getElementById("adminClassesBox") && typeof renderAdminClassesSection === "function") { renderAdminClassesSection(); return; }
if (typeof refreshSocialPage === "function") refreshSocialPage();
else location.reload();
} catch (e) { alert(socialT("cls_opFail")); }
}

/* ---------- 徽章页 ---------- */
async function renderBadgesPage(username) {
username = (username || socialUser() || "").trim();
var h = '<div class="max-w-3xl mx-auto px-4 py-4">';
h += '<h2 class="text-xl font-bold mb-4">🏅 ' + socialT("bdg_title") + '</h2>';
if (!username) {
h += '<div class="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm">' + socialT("cls_needLogin") + '</div></div>';
showSocialPage(h); return;
}
var list = [];
try { list = await socialGet("/api/badges?username=" + encodeURIComponent(username)); } catch (e) { list = []; }
var got = 0, i;
for (i = 0; i < list.length; i++) if (list[i].earned) got++;
h += '<div class="text-sm text-gray-500 mb-3">' + socialEsc(username) + ' · ' + socialTf("bdg_count", { a: got, b: list.length }) + '</div>';
h += '<div class="grid grid-cols-2 md:grid-cols-3 gap-3">';
for (i = 0; i < list.length; i++) {
var b = list[i];
var key = b.key || ("bdg_" + b.id);
var nm = socialT(key), ds = socialT(key + "_desc");
if (nm === key) nm = b.name || b.id;
if (ds === key + "_desc") ds = b.desc || "";
if (b.earned) {
h += '<div class="bg-gradient-to-br from-amber-50 to-yellow-100 border-2 border-amber-300 rounded-xl p-4 text-center">'
+ '<div class="text-4xl mb-2">' + b.icon + '</div>'
+ '<div class="font-bold text-sm">' + socialEsc(nm) + '</div>'
+ '<div class="text-xs text-gray-500 mt-1">' + socialEsc(ds) + '</div>'
+ '<div class="text-xs mt-2 inline-block px-2 py-0.5 rounded-full bg-amber-500 text-white">' + socialT("bdg_earned") + '</div>'
+ '</div>';
} else {
h += '<div class="bg-gray-50 border border-gray-200 rounded-xl p-4 text-center opacity-70">'
+ '<div class="text-4xl mb-2 grayscale">' + b.icon + '</div>'
+ '<div class="font-bold text-sm text-gray-500">' + socialEsc(nm) + '</div>'
+ '<div class="text-xs text-gray-400 mt-1">' + socialEsc(ds) + '</div>'
+ '<div class="text-xs mt-2 inline-block px-2 py-0.5 rounded-full bg-gray-300 text-gray-600">' + socialT("bdg_locked") + '</div>'
+ '</div>';
}
}
h += '</div></div>';
showSocialPage(h); return;
}

/* ---------- 管理端统计看板 ---------- */
function socialStatCard(icon, label, value) {
return '<div class="bg-white rounded-xl shadow p-4 text-center">'
+ '<div class="text-2xl mb-1">' + icon + '</div>'
+ '<div class="text-2xl font-bold">' + socialEsc(String(value)) + '</div>'
+ '<div class="text-xs text-gray-500 mt-1">' + socialEsc(label) + '</div></div>';
}

async function renderStatsPage() {
var h = '<div class="max-w-4xl mx-auto px-4 py-4">';
h += '<h2 class="text-xl font-bold mb-4">📊 ' + socialT("stat_title") + '</h2>';
var s = null;
try { s = await socialGet("/api/stats"); }
catch (e) {
var msg = (e && e.status === 403) ? socialT("stat_needAdmin") : socialT("stat_noData");
h += '<div class="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm">' + socialEsc(msg) + '</div></div>';
showSocialPage(h); return;
}
h += '<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">';
h += socialStatCard("👥", socialT("stat_students"), s.students);
h += socialStatCard("📚", socialT("stat_courses"), s.courses);
h += socialStatCard("✅", socialT("stat_completions"), s.completions);
h += socialStatCard("📈", socialT("stat_avgScore"), s.avgScore);
h += socialStatCard("🔥", socialT("stat_active7"), s.active7);
h += '</div>';
h += '<div class="grid md:grid-cols-2 gap-3">';
h += '<div class="bg-white rounded-xl shadow p-4"><div class="font-bold mb-2">🏆 ' + socialT("stat_topCourses") + '</div>';
if (s.topCourses && s.topCourses.length) {
h += '<ol class="text-sm space-y-1">';
for (var i = 0; i < s.topCourses.length; i++) {
var t = s.topCourses[i];
h += '<li class="flex justify-between"><span class="truncate mr-2">' + (i + 1) + '. ' + socialEsc(socialTw(t.title)) + '</span>'
+ '<span class="text-gray-500 whitespace-nowrap">' + socialTf("stat_times", { n: t.count }) + '</span></li>';
}
h += '</ol>';
} else h += '<div class="text-sm text-gray-400">' + socialT("stat_noData") + '</div>';
h += '</div>';
h += '<div class="bg-white rounded-xl shadow p-4"><div class="font-bold mb-2">📝 ' + socialT("stat_wrongsByType") + '</div>';
var keys = s.wrongsByType ? Object.keys(s.wrongsByType) : [];
if (keys.length) {
var total = 0, k;
for (k = 0; k < keys.length; k++) total += s.wrongsByType[keys[k]];
h += '<div class="text-sm space-y-2">';
for (k = 0; k < keys.length; k++) {
var n = s.wrongsByType[keys[k]];
var pct = total ? Math.round(n / total * 100) : 0;
h += '<div><div class="flex justify-between text-xs mb-0.5"><span>' + socialEsc(keys[k]) + '</span><span>' + n + ' (' + pct + '%)</span></div>'
+ '<div class="h-2 bg-gray-100 rounded"><div class="h-2 bg-red-400 rounded" style="width:' + pct + '%"></div></div></div>';
}
h += '</div>';
} else h += '<div class="text-sm text-gray-400">' + socialT("stat_noData") + '</div>';
h += '</div></div></div>';
showSocialPage(h); return;
}

/* 挂载全局动作函数（供 onclick 调用；宿主可提供 refreshSocialPage() 实现局部刷新） */
try {
window.socialJoin = socialJoin;
window.socialLeave = socialLeave;
window.socialToggleMembers = socialToggleMembers;
window.socialEditClass = socialEditClass;
window.socialSaveClass = socialSaveClass;
window.socialDelClass = socialDelClass;
window.renderClassesPage = renderClassesPage;
window.renderBadgesPage = renderBadgesPage;
window.renderStatsPage = renderStatsPage;
} catch (e) {}

/* ================= 管理端区块：数据看板 / 班级管理 ================= */
async function renderAdminStatsSection() {
var box = document.getElementById("adminStatsBox");
if (!box) return;
box.innerHTML = '<div class="text-sm text-slate-400">加载中…</div>';
try {
var s = await socialGet("/api/stats");
var h = '<div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">';
h += socialStatCard("👥", socialT("stat_students"), s.students);
h += socialStatCard("📚", socialT("stat_courses"), s.courses);
h += socialStatCard("✅", socialT("stat_completions"), s.completions);
h += socialStatCard("📈", socialT("stat_avgScore"), s.avgScore);
h += socialStatCard("🔥", socialT("stat_active7"), s.active7);
h += '</div><div class="grid md:grid-cols-2 gap-3">';
h += '<div class="border border-slate-100 rounded-2xl p-4"><div class="font-bold text-sm mb-2">🏆 ' + socialT("stat_topCourses") + '</div>';
if (s.topCourses && s.topCourses.length) {
h += '<ol class="text-sm space-y-1">';
for (var i = 0; i < s.topCourses.length; i++) {
var t = s.topCourses[i];
h += '<li class="flex justify-between"><span class="truncate mr-2">' + (i + 1) + '. ' + socialEsc(socialTw(t.title)) + '</span>'
+ '<span class="text-gray-500 whitespace-nowrap">' + socialTf("stat_times", { n: t.count }) + '</span></li>';
}
h += '</ol>';
} else h += '<div class="text-sm text-gray-400">' + socialT("stat_noData") + '</div>';
h += '</div>';
h += '<div class="border border-slate-100 rounded-2xl p-4"><div class="font-bold text-sm mb-2">📝 ' + socialT("stat_wrongsByType") + '</div>';
var keys = s.wrongsByType ? Object.keys(s.wrongsByType) : [];
if (keys.length) {
var total = 0, k;
for (k = 0; k < keys.length; k++) total += s.wrongsByType[keys[k]];
h += '<div class="text-sm space-y-2">';
for (k = 0; k < keys.length; k++) {
var n = s.wrongsByType[keys[k]];
var pct = total ? Math.round(n / total * 100) : 0;
h += '<div><div class="flex justify-between text-xs mb-0.5"><span>' + socialEsc(keys[k]) + '</span><span>' + n + ' (' + pct + '%)</span></div>'
+ '<div class="h-2 bg-gray-100 rounded"><div class="h-2 bg-red-400 rounded" style="width:' + pct + '%"></div></div></div>';
}
h += '</div>';
} else h += '<div class="text-sm text-gray-400">' + socialT("stat_noData") + '</div>';
h += '</div></div>';
box.innerHTML = h;
try { if (typeof applyI18n === "function") applyI18n(); } catch (e) {}
} catch (e) {
box.innerHTML = '<div class="text-sm text-slate-400">暂无数据</div>';
}
}

async function renderAdminClassesSection() {
var box = document.getElementById("adminClassesBox");
if (!box) return;
box.innerHTML = '<div class="text-sm text-slate-400">加载中…</div>';
try {
var classes = await socialGet("/api/classes");
if (!classes.length) {
box.innerHTML = '<div class="text-sm text-slate-400">暂无班级，点击右上角新建</div>';
return;
}
box.innerHTML = classes.map(function (c) { return socialClassCard(c, [], "", true); }).join("");
try { if (typeof applyI18n === "function") applyI18n(); } catch (e) {}
} catch (e) {
box.innerHTML = '<div class="text-sm text-red-400">加载失败，请重试</div>';
}
}

function adminNewClass() {
try { socialEditClass(""); } catch (e) {}
var box = document.getElementById("adminClassForm");
if (box) { try { box.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e2) {} }
}
/* PWA：注册 Service Worker（满足 Android WebAPK 可安装性；iOS 用添加到主屏幕） */
/* 注意：本文件不开 script 标签——build.py 已在 ui 之后重开脚本块，此处直接续写 JS，嵌套开标签会致整块语法错误（2026-10-10 真实故障） */
if ('serviceWorker' in navigator) { window.addEventListener('load', function() { navigator.serviceWorker.register('/sw.js').catch(function(){}); }); }
</script>
</body>
</html>`;
}
