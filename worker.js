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
function json(data, status) {
return new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json"}});
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
const authed = await isAdminReq(request, env);

// API: 获取全部课程（非管理员拿不到答案）
if (pathname === "/api/data") {
const list = await orderedCourses(env);
return json(authed? list: stripAnswers(list));
}

// API: 保存课程（管理员）
if (pathname === "/api/save" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json();
const qJson = JSON.stringify(b.quizzes || []);
const gJson = JSON.stringify(Array.isArray(b.guide) ? b.guide : []);
const mode = b.mode === "study"? "study": "quiz";
const cat = b.category || "默认", sub = ((b.subcategory || "") + "").trim();
if (b.id && b.id.length > 5) {
await env.DB.prepare("UPDATE courses SET category=?, subcategory=?, title=?, content=?, quizzes_json=?, video_url=?, mode=?, guide_json=?, instructions=? WHERE id=?")
.bind(cat, sub, b.title, b.content, qJson, b.video_url || "", mode, gJson, b.instructions || "", b.id).run();
} else {
const so = await nextSortOrder(env);
await env.DB.prepare("INSERT INTO courses (id, category, subcategory, title, content, quizzes_json, video_url, mode, guide_json, instructions, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
.bind("ID-" + Date.now(), cat, sub, b.title, b.content, qJson, b.video_url || "", mode, gJson, b.instructions || "", so).run();
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
await env.DB.prepare("DELETE FROM courses WHERE id =?").bind(b.id).run();
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
await env.DB.prepare("INSERT INTO courses (id, category, subcategory, title, content, quizzes_json, video_url, mode, guide_json, instructions, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
.bind("ID-" + Date.now() + "-" + n, c.category || "默认", ((c.subcategory || "") + "").trim(), c.title, c.content || "", JSON.stringify(qs), c.video_url || "", c.mode === "study"? "study": "quiz", JSON.stringify(Array.isArray(c.guide) ? c.guide : []), c.instructions || "", so + n).run();
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
const cr = await env.DB.prepare("SELECT parent, name, description FROM categories ORDER BY parent ASC, name ASC").all();
const rows = (cr && cr.results) || [];
const cc = await env.DB.prepare("SELECT category, subcategory, COUNT(*) AS n FROM courses GROUP BY category, subcategory").all();
const seriesMap = {};
function getSeries(nm) {
if (!seriesMap[nm]) seriesMap[nm] = { name: nm, description: "", count: 0, subs: [], _subIdx: {} };
return seriesMap[nm];
}
rows.forEach(r => {
const parent = r.parent || "";
if (!parent) {
const s = getSeries(r.name);
if (r.description) s.description = r.description;
} else {
const s = getSeries(parent);
if (!s._subIdx[r.name]) { s._subIdx[r.name] = { name: r.name, description: r.description || "", count: 0 }; s.subs.push(s._subIdx[r.name]); }
else if (r.description) s._subIdx[r.name].description = r.description;
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
return { name: s.name, description: s.description, count: s.count, totalCount: total, subs: s.subs };
});
return json(out);
}

// API: 保存系列/子栏目（管理员）
// parent 为空=系列；非空=该系列下的子栏目。改名时同步更新课程与子栏目的归属
if (pathname === "/api/category/save" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json();
const name = ((b.name || "") + "").trim();
if (!name) return json({ error: "名称不能为空"}, 400);
const desc = ((b.description || "") + "").trim();
const oldName = ((b.oldName || "") + "").trim();
const parent = ((b.parent || "") + "").trim();
const now = new Date().toISOString();
async function upsert(p, n, d) {
await env.DB.prepare("INSERT INTO categories (parent, name, description, created_at) VALUES (?,?,?,?) ON CONFLICT(parent, name) DO UPDATE SET description=excluded.description").bind(p, n, d, now).run();
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
const ansMap = {};
b.answers.forEach(a => { ansMap[a.i] = a.u;});
let score = 0, gradable = 0;
const details = qs.map((q, i) => {
const v = checkAnswer(q, ansMap[i] == null? "": ansMap[i]);
if (v === null) return { i: i, verdict: null, expected: q.a || ""};
gradable++;
if (v) score++;
return { i: i, verdict:!!v, expected: q.a || ""};
});
const scoreText = score + "/" + gradable;
const title = b.courseTitle || course.title || "";
// 去重：同一学员同一课程只保留最新一条
await env.DB.prepare("DELETE FROM progress WHERE username=? AND (course_id=? OR course_id=?)").bind(username, courseId, title).run();
await env.DB.prepare("INSERT INTO progress (username, course_id, course_title, score, submitted_at) VALUES (?,?,?,?,?)")
.bind(username, courseId, title, scoreText, now).run();
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
const password = (b.password || "") + "";
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
for (const it of items) {
await env.DB.prepare("INSERT INTO wrongs (username, course_id, course_title, series, sub, qtype, qnum, question, user_answer, correct_answer, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
.bind(username, courseId, title, it.series || "", it.sub || "", it.type || "", String(it.n || ""), it.q || "", it.u || "", it.expected || "", now).run();
}
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
const r = await env.DB.prepare("SELECT quizzes_json FROM courses WHERE id =?").bind(cid).all();
const rows = (r && r.results) || [];
let qs = [];
try { qs = JSON.parse((rows[0] && rows[0].quizzes_json) || "[]");} catch (e) {}
return json({ quizzes: qs});
}

// API: 管理登录（校验密码，写入 HttpOnly 会话 Cookie）
if (pathname === "/api/verify" && request.method === "POST") {
if (authed) return json({ ok: true});
const b = await request.json().catch(() => ({}));
const ok = (await sha256hex(String(b.password || ""))) === await getPwHash(env);
if (!ok) return json({ ok: false});
const resp = json({ ok: true});
resp.headers.set("Set-Cookie", adminCookie(await adminToken(env)));
return resp;
}

// API: 修改管理密码（管理员）
if (pathname === "/api/change-password" && request.method === "POST") {
if (!authed) return new Response("ADMIN_AUTH_REQUIRED", { status: 403});
const b = await request.json().catch(() => ({}));
const oldOk = (await sha256hex(String(b.oldPassword || ""))) === await getPwHash(env);
if (!oldOk) return json({ ok: false, error: "原密码错误"}, 400);
const np = String(b.newPassword || "");
if (np.length < 6) return json({ ok: false, error: "新密码至少 6 位"}, 400);
await setSetting(env, "admin_pw_hash", await sha256hex(np));
const resp = json({ ok: true});
resp.headers.set("Set-Cookie", adminCookie(await adminToken(env)));
return resp;
}

// API: 首页公告
if (pathname === "/api/notice" && request.method === "GET") {
return json({ notice: (await getSetting(env, "notice")) || ""});
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

// 教师管理端页面
if (pathname === "/admin" || pathname.indexOf("/admin/") === 0) {
const list = await orderedCourses(env);
const acats = [...new Set(list.map(item => item.category))];
const data = authed? list: stripAnswers(list);
return new Response(renderHTML(data, acats, { shareMode: false, isAdmin: true, adminAuthed: authed, notice: ""}), { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store, no-cache, must-revalidate" }});
}

// 课程分享短链：/ID-xxxx
const shortId = /^\/ID-[A-Za-z0-9_-]+$/.test(pathname)? pathname.slice(1): null;
if (shortId) {
const sr = await env.DB.prepare("SELECT * FROM courses WHERE id =?").bind(shortId).all();
const srows = (sr && sr.results) || [];
if (!srows.length) return new Response("课程不存在或已删除", { status: 404});
const scats = [...new Set(srows.map(item => item.category))];
return new Response(renderHTML(stripAnswers(srows), scats, { shareMode: true, isAdmin: false, adminAuthed: false, notice: notice}), { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store, no-cache, must-revalidate" }});
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
return new Response(renderHTML(stripAnswers(displayData), categories, { shareMode: isShareMode, isAdmin: false, adminAuthed: false, notice: notice}), { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store, no-cache, must-revalidate" }});

} catch (e) {
return new Response("服务器错误: " + e.message, { status: 500});
}
}
};

function renderHTML(results, categories, opts) {
    var isShareMode = opts.shareMode, isAdmin = opts.isAdmin, adminAuthed = !!opts.adminAuthed, notice = opts.notice || "";
  // 把服务端已过滤好的展示数据直接灌给前端（分享模式只含被分享的那一课），顺带防 </script> 注入
  const bootJson = JSON.stringify(results || []).replace(/</g, function(){ return String.fromCharCode(92) + 'u003c'; });

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
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
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
        #fontFab { position: fixed; right: 1rem; bottom: 5rem; z-index: 100; display: flex; flex-direction: column; align-items: center; gap: .5rem; }
        #fontFabBtn { height: 3rem; padding: 0 1.1rem; border-radius: 9999px; background: linear-gradient(135deg,#8b5cf6,#6366f1); color: #fff; font-weight: 900; font-size: 1rem; box-shadow: 0 6px 20px rgba(124,93,250,.45); border: 2px solid #fff; cursor: pointer; line-height: 1; }
        #fontFabBtn:active { transform: scale(.94); }
        #fontFabBtn { opacity: .55; transition: opacity .25s; }
        #fontFab.open #fontFabBtn, #fontFabBtn:hover { opacity: 1; }
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
        .verse-text { background: #fef3c7; border-bottom: 2px solid #f59e0b; border-radius: .2rem; padding: 0 .25rem; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    </style>
</head>
<body class="bg-[#f6f7fb] min-h-screen text-slate-900 pb-20">
    <script>window.__BOOT__ = { shareMode: ${isShareMode}, isAdmin: ${isAdmin}, adminAuthed: ${adminAuthed}, list: ${bootJson} };</script>

    <!-- 顶栏 -->
    <header class="bg-white/90 backdrop-blur sticky top-0 z-50 border-b border-slate-100">
        <div class="max-w-6xl mx-auto px-5 py-3 flex justify-between items-center">
            <div class="flex items-center gap-2.5 cursor-pointer" onclick="location.href=location.origin">
                <div class="w-9 h-9 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white text-lg shadow-md shadow-violet-200">📖</div>
                <span class="font-black text-lg tracking-tight">团契智学</span>
                ${isAdmin ? '<span class="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold">教师管理</span>' : ''}
            </div>
            <div class="flex gap-2">
                ${isAdmin
                    ? '<a href="/" class="text-xs bg-slate-100 px-3.5 py-2 rounded-xl font-medium text-slate-600 hover:bg-slate-200 transition">学员端</a>'
                      + '<button onclick="exportSelected()" class="text-xs bg-emerald-600 text-white px-3.5 py-2 rounded-xl font-bold shadow-md shadow-emerald-200 hover:opacity-95 transition">📥 批量导出</button>'
                      + '<button onclick="openEditModal()" class="text-xs bg-gradient-to-r from-violet-600 to-indigo-600 text-white px-3.5 py-2 rounded-xl font-bold shadow-md shadow-violet-200 hover:opacity-95 transition">+ 创建新课件</button>'
                    : '<button onclick="openWrongBook()" class="text-xs bg-slate-100 px-3.5 py-2 rounded-xl font-medium text-slate-600 hover:bg-slate-200 transition">📝 错题本</button>'
                      + '<button onclick="nameBtnClick()" id="nameBtn" class="text-xs bg-slate-100 px-3.5 py-2 rounded-xl font-medium text-slate-600 hover:bg-slate-200 transition">设置姓名</button>'}
            </div>
        </div>
    </header>

    <main class="max-w-6xl mx-auto px-5 pt-8">
        <!-- 标题区 -->
        <h1 class="text-[2rem] leading-tight font-black tracking-tight">我的课程</h1>
        <p class="text-slate-400 mt-1 mb-6">系统学习，稳步成长</p>

        ${(!isAdmin && notice) ? '<div class="mb-6 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl px-5 py-4 text-sm text-amber-800 flex gap-3"><span class="text-lg">📢</span><span>' + notice.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>' : ''}

        ${!isAdmin ? `
        <!-- 统计卡片 -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div class="bg-violet-50 rounded-3xl p-5 flex items-center gap-4">
                <div class="w-14 h-14 shrink-0 rounded-2xl bg-violet-500 flex items-center justify-center text-white text-2xl shadow-sm">📖</div>
                <div>
                    <div id="statTotal" class="text-3xl font-black text-violet-600 leading-none">–</div>
                    <div class="text-xs text-slate-500 mt-1.5">全部课程</div>
                </div>
            </div>
            <div class="bg-emerald-50 rounded-3xl p-5 flex items-center gap-4">
                <div class="w-14 h-14 shrink-0 rounded-2xl bg-emerald-500 flex items-center justify-center text-white text-2xl shadow-sm">✓</div>
                <div>
                    <div id="statDone" class="text-3xl font-black text-emerald-600 leading-none">0</div>
                    <div class="text-xs text-slate-500 mt-1.5">已完成</div>
                </div>
            </div>
            <div class="bg-amber-50 rounded-3xl p-5 flex items-center gap-4">
                <div class="w-14 h-14 shrink-0 rounded-2xl bg-amber-500 flex items-center justify-center text-white text-2xl shadow-sm">◷</div>
                <div>
                    <div id="statDoing" class="text-3xl font-black text-amber-600 leading-none">0</div>
                    <div class="text-xs text-slate-500 mt-1.5">进行中</div>
                </div>
            </div>
            <div class="bg-rose-50 rounded-3xl p-5 flex items-center gap-4">
                <div class="w-14 h-14 shrink-0 rounded-2xl bg-rose-500 flex items-center justify-center text-white text-2xl shadow-sm">★</div>
                <div>
                    <div id="statAvg" class="text-3xl font-black text-rose-500 leading-none">--</div>
                    <div class="text-xs text-slate-500 mt-1.5">平均分</div>
                </div>
            </div>
        </div>

        <!-- 我的成绩 -->
        <div id="myScoresCard" class="hidden bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-3">📊 我的成绩</h3>
            <div id="myScoresAvg" class="text-xs text-slate-400 mb-2"></div>
            <ul id="myScoresList" class="space-y-2 max-h-64 overflow-y-auto"></ul>
        </div>
        ` : ''}

        ${isAdmin ? `
        <!-- 按姓名查成绩 -->
        <div class="bg-white rounded-3xl p-6 shadow-sm mb-6">
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

        <!-- 学员管理员 -->
        <div class="bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-2">👑 学员管理员</h3>
            <p class="text-xs text-slate-400 mb-3">设为管理员的学员，在学员端打开课件可直接查看答案（无需答题），按钮在课件顶部右侧。</p>
            <ul id="adminStudentList" class="space-y-2"><li class="text-sm text-slate-400">加载中…</li></ul>
        </div>

        <!-- 数据管理 -->
        <div class="bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-4">🗂️ 数据管理</h3>
            <div class="flex flex-wrap gap-2">
                <button onclick="openImportModal()" class="text-xs bg-violet-100 text-violet-700 px-4 py-2.5 rounded-xl font-bold hover:bg-violet-200 transition">📥 批量导入课程</button>
                <button onclick="exportCSV()" class="text-xs bg-emerald-100 text-emerald-700 px-4 py-2.5 rounded-xl font-bold hover:bg-emerald-200 transition">📤 导出成绩 CSV</button>
                <button onclick="openPwModal()" class="text-xs bg-amber-100 text-amber-700 px-4 py-2.5 rounded-xl font-bold hover:bg-amber-200 transition">🔑 修改管理密码</button>
            </div>
        </div>

        <!-- 公告设置 -->
        <div class="bg-white rounded-3xl p-6 shadow-sm mb-6">
            <h3 class="font-bold text-slate-800 mb-4">📢 首页公告</h3>
            <div class="flex gap-2">
                <input id="noticeText" placeholder="公告内容（学员端首页顶部显示，留空则不显示）" class="flex-1 border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400">
                <button onclick="saveNotice()" class="bg-indigo-900 text-white px-6 rounded-2xl text-sm font-bold">保存</button>
            </div>
        </div>

        <!-- 系列与子栏目管理 -->
        <div class="bg-white rounded-3xl p-6 shadow-sm mb-6">
            <div class="flex items-center justify-between mb-2">
                <h3 class="font-bold text-slate-800">📚 系列与子栏目</h3>
                <button onclick="openCatModal('', '')" class="text-xs bg-violet-100 text-violet-700 px-4 py-2 rounded-xl font-bold hover:bg-violet-200 transition">＋ 新增系列</button>
            </div>
            <p class="text-xs text-slate-400 mb-4">给系列（如"基要真理"）和子栏目写简介，会显示在学员端对应标题下方；新增/编辑课程时直接选择即可，无需重复填写。</p>
            <div id="catList" class="space-y-3"><div class="text-sm text-slate-400">加载中…</div></div>
        </div>

        <!-- 系列/子栏目编辑弹窗 -->
        <div id="catModal" class="hidden fixed inset-0 bg-slate-900/95 z-[75] flex items-center justify-center p-4">
            <div class="bg-white rounded-3xl w-full max-w-md p-8 shadow-2xl">
                <h2 class="font-black text-lg mb-5" id="catModalTitle">＋ 新增系列</h2>
                <input id="cat_parent" type="hidden">
                <input id="cat_old" type="hidden">
                <input id="cat_name" placeholder="名称" class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-3">
                <textarea id="cat_desc" placeholder="简介（学员端可见，可空）" class="w-full h-32 border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-5"></textarea>
                <div class="flex gap-3">
                    <button onclick="saveCat()" class="flex-1 bg-indigo-900 text-white py-3 rounded-2xl font-bold">保存</button>
                    <button onclick="toggleModal('catModal')" class="bg-slate-200 text-slate-600 px-6 py-3 rounded-2xl font-bold">取消</button>
                </div>
            </div>
        </div>
        ` : ''}

        <!-- 搜索框 -->
        <div class="relative mb-8">
            <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg">⌕</span>
            <input id="searchInput" oninput="filterCourses()" placeholder="搜索课程..."
                class="w-full bg-white border border-slate-100 rounded-2xl py-3.5 pl-11 pr-4 text-sm shadow-sm outline-none focus:ring-2 focus:ring-violet-200 focus:border-violet-300 transition placeholder:text-slate-400">
        </div>

        <!-- 课程分区（JS 按栏目渲染） -->
        <div id="courseSections"></div>
        <div id="loadingState" class="text-center text-slate-400 py-16 text-sm">课程加载中…</div>
        <div id="emptyState" class="hidden text-center text-slate-400 py-16 text-sm">没有找到匹配的课程</div>
    </main>
    ${!isAdmin ? '<footer class="max-w-6xl mx-auto px-5 mt-6 text-center"><a href="/admin" class="text-xs text-slate-300 hover:text-violet-500 transition">教师管理入口 →</a></footer>' : ''}

    <!-- 答题 / 学习弹窗 -->
    <div id="lessonModal" class="hidden fixed inset-0 bg-white z-[80] overflow-y-auto">
        <div class="w-full max-w-6xl mx-auto px-3 md:px-6 py-6 pb-32">
            <div id="lessonHeader"></div>
            <div id="studyProg" class="hidden mt-4 text-sm font-bold text-violet-600"></div>
            <div id="lessonBody" class="mt-10 space-y-4"></div>
            <div id="lessonFooter" class="mt-12 pt-10 border-t">
                <div id="resultArea" class="hidden mt-8 space-y-4"></div>
                <button id="backListBtn" onclick="location.reload()" class="mt-10 w-full text-slate-400 text-sm hover:underline">返回列表</button>
            </div>
        </div>
    </div>

    ${!isAdmin ? `
    <!-- 错题本弹窗 -->
    <div id="wrongBookModal" class="hidden fixed inset-0 bg-slate-900/60 z-[90] flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
            <div class="p-6 border-b flex items-center justify-between">
                <h2 id="wrongBookTitle" class="font-black text-lg">📝 我的错题本</h2>
                <div class="flex gap-2">
                    <button onclick="openWrongExportMenu()" class="text-xs bg-emerald-600 text-white px-4 py-2 rounded-xl font-bold">📥 导出</button>
                    <button onclick="clearWrongBook()" class="text-xs bg-red-50 text-red-500 px-4 py-2 rounded-xl font-bold">清空</button>
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
        <div class="bg-white rounded-3xl w-full max-w-6xl h-[90vh] flex flex-col md:flex-row overflow-hidden shadow-2xl">
            <div class="w-full md:w-1/3 p-6 border-r overflow-y-auto space-y-4 bg-slate-50">
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
                        <h3 class="text-xs font-black text-indigo-900">🗺️ 章节导读（思维导图式）</h3>
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
                <input id="f_video" placeholder="视频链接（可选，如微信云盘分享链接）" class="w-full border p-3 rounded-xl text-sm">
            </div>
            <div class="flex-1 p-6 flex flex-col overflow-hidden">
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
            <input id="adminPwd" type="password" placeholder="管理密码" onkeydown="if(event.key==='Enter')adminLogin()"
                class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-3 text-center">
            <button onclick="adminLogin()" class="w-full bg-indigo-900 text-white py-3.5 rounded-2xl font-bold">进入管理端</button>
            <a href="/" class="block mt-4 text-slate-400 text-sm hover:underline">返回学员端</a>
        </div>
    </div>` : ''}
    <script>
        var allData = [];
        var catRows = [];  /* 系列树：[{name, description, count, totalCount, subs:[{name, description, count}]}] */
        var catInfo = {};  /* 系列名 -> {description, subDesc:{子栏目名:简介}}（学员端展示用） */
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
            var name = localStorage.getItem(USER_KEY) || "匿名学员";
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
            var name = localStorage.getItem(USER_KEY) || "匿名学员";
            var all = (getWrong()[name] || []);
            var arr = courseId ? all.filter(function(x) { return x.cid === courseId; }) : all;
            var titleEl = document.getElementById('wrongBookTitle');
            if (titleEl) titleEl.innerText = courseId ? ('📝 错题本' + (arr.length && arr[0].title ? ' · ' + arr[0].title : '')) : '📝 我的错题本';
            var list = document.getElementById('wrongBookList');
            if (!arr.length) {
                list.innerHTML = '<div class="text-center text-slate-400 text-sm py-10">' + (courseId ? '本课件暂无错题，答错的题目会自动收录在这里' : '错题本是空的，答错的题目会自动收录在这里') + '</div>';
            } else {
                list.innerHTML = arr.map(function(x) {
                    return '<div class="border border-slate-100 rounded-2xl p-4">'
                        + '<div class="text-[11px] text-violet-500 font-bold mb-1">' + esc([x.series, x.sub, x.title].filter(function(s) { return s; }).join(' · ') || '') + '</div>'
                        + '<div class="text-[11px] text-indigo-500 font-bold mb-1">' + esc(wrongTypeNum(x)) + '</div>'
                        + '<div class="text-sm font-bold text-slate-800 mb-2">' + esc(x.q || '') + '</div>'
                        + '<div class="text-xs text-slate-500">你的答案：' + esc(x.u || '（未填）') + '</div>'
                        + '<div class="text-xs text-emerald-600 font-bold mt-1">正确参考：' + esc(x.expected || '') + '</div></div>';
                }).join('');
            }
            toggleModal('wrongBookModal');
        }
        function clearWrongBook() {
            var fc = window._wrongCourseId || null;
            if (!confirm(fc ? "确定清空本课件的错题记录？" : "确定清空错题本？")) return;
            var name = localStorage.getItem(USER_KEY) || "匿名学员";
            var w = getWrong();
            if (fc) w[name] = (w[name] || []).filter(function(x) { return x.cid !== fc; });
            else w[name] = [];
            setWrong(w);
            openWrongBook(fc);
        }

        /* 小工具 */
        function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
        function stripEmoji(s) { return String(s == null ? "" : s).replace(/^[📖\s]+/, ""); } /* 去掉标题开头自带的 📖，避免与固定图标重复 */
        /* 经文高亮：引用→紫色徽章（完整显示），引用后经文正文→琥珀底纹；s须为已转义文本 */
        var BIBLE_BOOKS = '撒母耳记上|撒母耳记下|列王纪上|列王纪下|历代志上|历代志下|帖撒罗尼迦前书|帖撒罗尼迦后书|提摩太前书|提摩太后书|哥林多前书|哥林多后书|约翰一书|约翰二书|约翰三书|彼得前书|彼得后书|创世记|出埃及记|利未记|民数记|申命记|约书亚记|士师记|路得记|以斯拉记|尼希米记|以斯帖记|约伯记|传道书|以赛亚书|耶利米书|耶利米哀歌|以西结书|但以理书|何西阿书|约珥书|阿摩司书|俄巴底亚书|约拿书|弥迦书|那鸿书|哈巴谷书|西番雅书|哈该书|撒迦利亚书|玛拉基书|马太福音|马可福音|路加福音|约翰福音|使徒行传|罗马书|加拉太书|以弗所书|腓立比书|歌罗西书|提多书|腓利门书|希伯来书|雅各书|犹大书|启示录|诗篇|箴言|雅歌';
        /* 经文高亮：引用→紫色徽章（完整显示），引用后经文正文→琥珀底纹；s须为已转义文本 */
        function hlVerse(s) {
            s = String(s == null ? "" : s);
            var B = BIBLE_BOOKS;
            var SP = ' *';
            s = s.replace(new RegExp('《(' + B + ')》' + SP + '([0-9]+)' + SP + '章' + SP + '([0-9]+)' + SP + '节', 'g'), '<span class="verse-ref">《$1》$2章$3节</span>');
            s = s.replace(new RegExp('(' + B + ')' + SP + '([0-9]+)' + SP + '章' + SP + '([0-9]+)' + SP + '节' + SP + '说' + SP + '[：:，,]' + SP + '([^<]*)', 'g'), '<span class="verse-ref">$1$2章$3节</span><span class="verse-text">$4</span>');
            s = s.replace(new RegExp('(?<!">)(' + B + ')' + SP + '([0-9]+)' + SP + '章' + SP + '([0-9]+)' + SP + '节', 'g'), '<span class="verse-ref">$1$2章$3节</span>');
            s = s.replace(new RegExp('(' + B + ')' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([0-9]+)' + SP + '[：:]' + SP + '([^<]*)', 'g'), '<span class="verse-ref">$1$2:$3</span><span class="verse-text">$4</span>');
            s = s.replace(new RegExp('(?<!">)(' + B + ')' + SP + '([0-9]+)' + SP + '[:：]' + SP + '([0-9]+)', 'g'), '<span class="verse-ref">$1$2:$3</span>');
            return s;
        }
        /* verseSegs：将 hlVerse 输出切分为段 [{k:0普通|1引用|2经文, t:文本}]，供 PPT 多 run 渲染 */
        function verseSegs(s) {
            var html = hlVerse(s), segs = [], i = 0;
            var R1 = '<span class="verse-ref">', R2 = '<span class="verse-text">', E = '</span>';
            while (i < html.length) {
                var j1 = html.indexOf(R1, i), j2 = html.indexOf(R2, i), j = -1, k = 0, tag = '';
                if (j1 >= 0 && (j2 < 0 || j1 < j2)) { j = j1; k = 1; tag = R1; }
                else if (j2 >= 0) { j = j2; k = 2; tag = R2; }
                if (j < 0) { segs.push({ k: 0, t: html.slice(i) }); break; }
                if (j > i) segs.push({ k: 0, t: html.slice(i, j) });
                var e = html.indexOf(E, j + tag.length);
                segs.push({ k: k, t: html.slice(j + tag.length, e) });
                i = e + E.length;
            }
            return segs;
        }
        function stripMd(s) { return String(s || "").replace(/[#>*_~]/g, "").replace(/\\\\s+/g, " ").trim(); }
        function shuffle(arr) { for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; }
        function fmtTime(t) { if (!t) return ""; try { return new Date(t).toLocaleString("zh-CN", { hour12: false }).slice(0, 16); } catch(e) { return t; } }
        /* 字号调节：改根 font-size，Tailwind rem 单位全站跟随；localStorage 持久化 */
        var FONT_KEY = "TQ_FONT_V1";
        var FONT_SCALES = [0.85, 1, 1.15, 1.3, 1.5];
        var FONT_LABELS = ["小", "标准", "较大", "大", "特大"];
        var FONT_DEFAULT = 2;
        function getFontIdx() { var i = parseInt(localStorage.getItem(FONT_KEY) || String(FONT_DEFAULT), 10); if (isNaN(i)) i = FONT_DEFAULT; return Math.min(4, Math.max(0, i)); }
        function applyFontScale() {
            var i = getFontIdx();
            document.documentElement.style.fontSize = (16 * FONT_SCALES[i]) + "px";
            var lb = document.getElementById("fontLevelLabel"); if (lb) lb.innerText = FONT_LABELS[i];
        }
        function fontStep(d) { var i = getFontIdx() + d; i = Math.min(4, Math.max(0, i)); try { localStorage.setItem(FONT_KEY, String(i)); } catch(e) {} applyFontScale(); }
        function toggleFontPanel() {
            var p = document.getElementById("fontPanel");
            var f = document.getElementById("fontFab");
            p.classList.toggle("hidden");
            if (f) f.classList.toggle("open", !p.classList.contains("hidden"));
        }
        function fontReset() { try { localStorage.setItem(FONT_KEY, String(FONT_DEFAULT)); } catch(e) {} applyFontScale(); }

        async function load() {
            var r = await fetch('/api/data');
            allData = await r.json();
            try {
                var cr = await fetch('/api/categories');
                var cj = await cr.json();
                catRows = Array.isArray(cj) ? cj : [];
                catInfo = {};
                catRows.forEach(function(s) {
                    var sd = {};
                    (s.subs || []).forEach(function(x) { sd[x.name] = x.description || ""; });
                    catInfo[s.name] = { description: s.description || "", subDesc: sd };
                });
            } catch (e) {}
            var list = (BOOT.list && BOOT.list.length) ? BOOT.list : (BOOT.shareMode ? [] : allData);
            renderSections(list);
            updateStats();
            if (!BOOT.isAdmin) {
                var nr = await fetch('/api/notice').then(function(x){ return x.json(); }).catch(function(){ return {}; });
                // 公告已由服务端渲染；这里只拉成绩
                refreshStats();
            } else {
                var gate = document.getElementById('adminGate');
                if (gate && (BOOT.adminAuthed || sessionStorage.getItem('TQ_ADMIN_OK') === '1')) gate.style.display = 'none';
                var nrt = await fetch('/api/notice').then(function(x){ return x.json(); }).catch(function(){ return {}; });
                var nt = document.getElementById('noticeText');
                if (nt && nrt.notice) nt.value = nrt.notice;
                renderCatList();
                renderCatForm();
            }
            var sid = new URLSearchParams(window.location.search).get('id');
            if (!sid) {
                var pm = window.location.pathname.match(/^\\/(ID-[A-Za-z0-9_-]+)$/);
                if (pm) sid = pm[1];
            }
            if (sid && allData.length > 0) startLesson(sid);
        }
        window.onload = load;

        /* 状态徽标 */
        function statusBadge(id) {
            var p = getMyProg()[id] || {};
            if (p.completed)
                return '<span class="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-full"><span class="w-3.5 h-3.5 rounded-full border-2 border-emerald-500 flex items-center justify-center text-[9px]">✓</span>已完成</span>';
            if (p.started)
                return '<span class="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full"><span class="w-3.5 h-3.5 rounded-full border-2 border-amber-500"></span>进行中</span>';
            return '<span class="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 bg-slate-100 px-3 py-1.5 rounded-full"><span class="w-3.5 h-3.5 rounded-full border-2 border-slate-300"></span>未开始</span>';
        }

        /* 课程卡片（新 UI） */
        function courseCard(c, idx) {
            var desc = stripMd(c.content).slice(0, 44) + "…";
            var shareBtn = '<button data-id="' + c.id + '" onclick="copyShareLink(this.dataset.id)" title="复制分享链接" class="text-slate-300 hover:text-violet-600 transition">🔗</button>';
            var adminBtns = "";
            if (BOOT.isAdmin) {
                adminBtns = '<button data-id="' + c.id + '" onclick="editCourse(this.dataset.id)" title="编辑" class="text-slate-300 hover:text-violet-600 transition">🖊️</button>'
                    + '<button data-id="' + c.id + '" data-dir="up" onclick="moveCourse(this.dataset.id,this.dataset.dir)" title="上移" class="text-slate-300 hover:text-violet-600 transition">⬆️</button>'
                    + '<button data-id="' + c.id + '" data-dir="down" onclick="moveCourse(this.dataset.id,this.dataset.dir)" title="下移" class="text-slate-300 hover:text-violet-600 transition">⬇️</button>'
                    + '<button data-id="' + c.id + '" onclick="exportCourse(this.dataset.id)" title="导出HTML（手机电脑可打开）" class="text-slate-300 hover:text-emerald-600 transition">📥</button>'
                    + '<button data-id="' + c.id + '" onclick="deleteCourse(this.dataset.id)" title="删除" class="text-slate-300 hover:text-red-500 transition">🗑️</button>';
            }
            var cardBtns = '<div class="flex items-center gap-3 text-[15px]">' + shareBtn + adminBtns + '</div>';
            var videoBadge = c.video_url ? ' <span class="text-[11px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full align-middle">🎬 视频</span>' : '';
            var goText = '开始学习';
            return '<div class="course-card bg-white rounded-[1.75rem] border border-slate-100 shadow-sm p-6 flex flex-col gap-4 hover:shadow-lg hover:-translate-y-0.5 transition"'
                + ' data-search="' + esc(c.title + " " + c.content + " " + (c.subcategory || "")).toLowerCase() + '"'
                + ' style="animation-delay:' + Math.min(idx * 40, 600) + 'ms">'
                + '<div class="flex items-center justify-between"><div class="flex items-center gap-2">' + (BOOT.isAdmin ? '<input type="checkbox" class="exp-check w-4 h-4 accent-violet-600" data-id="' + c.id + '" title="勾选后可批量导出">' : '') + statusBadge(c.id) + '</div>' + cardBtns + '</div>'
                + '<div><h3 class="font-bold text-[1.05rem] text-slate-900 leading-snug">' + esc(c.title) + videoBadge + '</h3>'
                + '<p class="text-sm text-slate-400 mt-2 leading-relaxed line-clamp-2">' + esc(desc) + '</p></div>'
                + '<button data-id="' + c.id + '" onclick="startLesson(this.dataset.id)" class="mt-auto w-full bg-gradient-to-r from-violet-600 to-indigo-600 text-white py-3.5 rounded-2xl font-bold shadow-lg shadow-violet-200 hover:shadow-xl hover:opacity-95 active:scale-[.99] transition flex items-center justify-center gap-2">' + goText + ' <span aria-hidden="true">→</span></button>'
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
                    var gridHtml = '<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-8">' + cards + '</div>';
                    if (sk) {
                        var sd = info.subDesc[sk] || "";
                        var kKey = "sub:" + cat + "::" + sk, kBody = "treeBodyS" + si + "K" + ki, kChev = "treeChevS" + si + "K" + ki;
                        var kCollapsed = !!st[kKey];
                        bodyHtml += '<div class="ml-1 md:ml-5 mt-7">'
                            + '<button data-tkey="' + esc(kKey) + '" data-tbody="' + kBody + '" data-tchev="' + kChev + '" onclick="toggleTree(this)" class="flex items-center gap-2 mb-3 group">'
                            + '<span id="' + kChev + '" class="text-xs text-violet-500 w-4 text-center">' + (kCollapsed ? "▶" : "▼") + '</span>'
                            + '<span class="text-[15px] font-bold text-slate-700 group-hover:text-violet-700">📁 ' + esc(sk) + '</span>'
                            + '<span class="text-xs text-slate-400">' + subgroups[sk].length + ' 课</span></button>'
                            + (sd ? '<p class="text-xs text-slate-500 mb-3 ml-6 leading-relaxed">' + esc(stripMd(sd)) + '</p>' : '')
                            + '<div id="' + kBody + '" class="' + (kCollapsed ? "hidden" : "") + '">' + gridHtml + '</div></div>';
                    } else {
                        bodyHtml += gridHtml;
                    }
                });
                html += '<div class="mb-6">'
                    + '<button data-tkey="' + esc(sKey) + '" data-tbody="' + sBody + '" data-tchev="' + sChev + '" onclick="toggleTree(this)" class="flex items-center gap-3 w-full text-left group">'
                    + '<span id="' + sChev + '" class="text-sm text-violet-500 w-5 text-center">' + (sCollapsed ? "▶" : "▼") + '</span>'
                    + '<span class="w-1.5 h-7 bg-violet-500 rounded-full"></span>'
                    + '<h2 class="text-xl font-black tracking-tight group-hover:text-violet-700">' + esc(cat) + '</h2>'
                    + '<span class="text-sm text-slate-400">' + groups[cat].length + ' 课</span></button>'
                    + (info.description ? '<p class="text-sm text-slate-500 mt-2 ml-[52px] leading-relaxed">' + esc(info.description) + '</p>' : '')
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
            var name = localStorage.getItem(USER_KEY);
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
            document.getElementById('myScoresAvg').innerText = '共 ' + rows.length + ' 条记录' + (avg != null ? '，平均 ' + avg + ' 分' : '');
            document.getElementById('myScoresList').innerHTML = rows.map(function(s) {
                return '<li class="flex items-center justify-between text-sm border-b border-slate-50 pb-2">'
                    + '<span class="text-slate-600">' + esc(s.course_title || s.course_id) + '</span>'
                    + '<span class="text-slate-400 text-xs">' + esc(fmtTime(s.submitted_at)) + '</span>'
                    + '<span class="text-indigo-600 font-bold">' + esc(s.score) + '</span></li>';
            }).join('');
        }

        /* 搜索过滤 */
        function filterCourses() {
            var kw = document.getElementById('searchInput').value.trim().toLowerCase();
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

        function toggleModal(id) { document.getElementById(id).classList.toggle('hidden'); }
        function closeLessonModal() { document.getElementById('lessonModal').classList.add('hidden'); }
        function login() { openAuthModal('login', null, true); }
        /* 姓名按钮：未登记则登录，已登记则确认后登出（本地错题本按姓名保留） */
        function syncNameBtn() {
            var nm = "";
            try { nm = (localStorage.getItem(USER_KEY) || "").trim(); } catch (e) {}
            var nb = document.getElementById("nameBtn");
            if (nb) nb.innerText = nm || "设置姓名";
        }
        function nameBtnClick() {
            var nm = "";
            try { nm = (localStorage.getItem(USER_KEY) || "").trim(); } catch (e) {}
            if (!nm) { login(); return; }
            if (confirm("退出当前学员（" + nm + "）？\\n该姓名下的错题本与本地学习记录会保留，下次登记同一姓名可继续查看。")) {
                try { localStorage.removeItem(USER_KEY); localStorage.removeItem(STUDENT_TOKEN_KEY); localStorage.removeItem(STUDENT_ADMIN_KEY); } catch (e) {}
                location.reload();
            }
        }
        /* 答题前必须输入姓名：无姓名时弹窗阻断，登记后继续 */
        function requireNameForQuiz(tab) {
            var nm = "";
            try { nm = (localStorage.getItem(USER_KEY) || "").trim(); } catch (e) {}
            if (nm) return true;
            openAuthModal('login', tab, false);
            return false;
        }
        var STUDENT_TOKEN_KEY = "TQ_STUDENT_TOKEN_V1";
        var STUDENT_ADMIN_KEY = "TQ_STUDENT_ADMIN_V1";
        function studentToken() { try { return localStorage.getItem(STUDENT_TOKEN_KEY) || ""; } catch (e) { return ""; } }
        function studentIsAdmin() { try { return !!((localStorage.getItem(USER_KEY) || "").trim()) && localStorage.getItem(STUDENT_ADMIN_KEY) === "1"; } catch (e) { return false; } }
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
                    + '<h3 id="authTitle" style="font-weight:800;color:#1e293b;margin:0 0 6px;font-size:17px">👤 学员登录</h3>'
                    + '<p id="authDesc" style="font-size:12px;color:#94a3b8;margin:0 0 14px">请输入姓名与密码，成绩与错题本将记在此名下。</p>'
                    + '<input id="authName" placeholder="学员姓名" ' + inp + '>'
                    + '<input id="authPw" type="password" placeholder="密码（至少4位）" ' + inp + '>'
                    + '<input id="authPw2" type="password" placeholder="确认密码" ' + inp + ' style="display:none;width:100%;border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;font-size:14px;outline:none;margin-bottom:10px;box-sizing:border-box">'
                    + '<div id="authErr" style="display:none;color:#dc2626;font-size:12px;margin-bottom:10px"></div>'
                    + '<button id="authOk" onclick="submitAuth()" style="width:100%;background:#4f46e5;color:#fff;border:none;border-radius:12px;padding:11px;font-size:14px;font-weight:700;margin-bottom:8px">登 录</button>'
                    + '<button id="authSwitch" onclick="toggleAuthMode()" style="width:100%;background:none;border:none;color:#4f46e5;font-size:12px;padding:6px">首次使用？点此注册</button>'
                    + '</div>';
                document.body.appendChild(m);
                ['authName','authPw','authPw2'].forEach(function(id) {
                    var el = document.getElementById(id);
                    if (el) el.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') submitAuth(); });
                });
            }
            setAuthMode(mode === 'register' ? 'register' : 'login');
            var nm = document.getElementById('authName');
            if (nm && !nm.value) { try { nm.value = (localStorage.getItem(USER_KEY) || "").trim(); } catch (e) {} }
            m.style.display = 'flex';
            setTimeout(function() { var el = document.getElementById(window._authMode === 'login' ? 'authPw' : 'authName'); if (el) el.focus(); }, 60);
        }
        function setAuthMode(mode) {
            window._authMode = mode;
            var isReg = (mode === 'register');
            document.getElementById('authTitle').innerText = isReg ? '👤 学员注册' : '👤 学员登录';
            document.getElementById('authDesc').innerText = isReg ? '首次使用请设置登录密码，请牢记。' : '请输入姓名与密码，成绩与错题本将记在此名下。';
            document.getElementById('authOk').innerText = isReg ? '注 册' : '登 录';
            document.getElementById('authSwitch').innerText = isReg ? '已有账号？点此登录' : '首次使用？点此注册';
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
            if (!name) { showAuthErr('请输入姓名'); return; }
            if (pw.length < 4) { showAuthErr('密码至少4位'); return; }
            if (mode === 'register') {
                var pw2 = document.getElementById('authPw2').value || "";
                if (pw !== pw2) { showAuthErr('两次输入的密码不一致'); return; }
            }
            var btn = document.getElementById('authOk');
            btn.disabled = true; btn.innerText = '处理中…';
            try {
                var r = await fetch('/api/student/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: pw, mode: mode }) });
                var j = await r.json();
                if (!j.success) { showAuthErr(j.error || '操作失败，请重试'); return; }
                try { localStorage.setItem(USER_KEY, name); localStorage.setItem(STUDENT_TOKEN_KEY, j.token || ""); localStorage.setItem(STUDENT_ADMIN_KEY, j.is_admin ? "1" : "0"); } catch (e) {}
                document.getElementById('authPw').value = '';
                document.getElementById('authPw2').value = '';
                document.getElementById('authModal').style.display = 'none';
                if (window._authReload) { window._authReload = false; location.reload(); return; }
                syncNameBtn();
                var snb = document.getElementById("shareNameBox"); if (snb) snb.innerHTML = shareNameHTML();
                if (activeLessonId) { var _pg = getMyProg(); if (!_pg[activeLessonId] || !_pg[activeLessonId].completed) { _pg[activeLessonId] = { started: true, completed: false }; setMyProg(_pg); } }
                var t = window._pendingQTab; window._pendingQTab = null;
                if (t) switchQTab(t);
            } catch (e) {
                showAuthErr('网络错误，请重试');
            } finally {
                btn.disabled = false;
                setAuthMode(window._authMode || 'login');
            }
        }
        function openShareAuth() { openAuthModal('login', null, false); }
        /* 分享页姓名条：与主站共用同一本地姓名，成绩自动记在其名下 */
        function shareNameHTML() {
            var sn0 = (localStorage.getItem(USER_KEY) || "").trim();
            if (sn0) return '<span class="text-slate-600">学员：<b class="text-slate-800">' + esc(sn0) + '</b></span>'
                + '<button onclick="shareRename()" class="text-xs text-violet-600 underline">更换</button>';
            return '<button onclick="openShareAuth()" class="text-xs bg-violet-600 text-white px-3 py-1.5 rounded-xl font-bold">登录 / 注册</button>';
        }
        function shareRename() {
            try { localStorage.removeItem(USER_KEY); localStorage.removeItem(STUDENT_TOKEN_KEY); localStorage.removeItem(STUDENT_ADMIN_KEY); } catch(e) {}
            document.getElementById("shareNameBox").innerHTML = shareNameHTML();
            var nb = document.getElementById("nameBtn"); if (nb) nb.innerText = "设置姓名";
        }

        function copyShareLink(id) {
            var url = window.location.origin + "/" + id;
            navigator.clipboard.writeText(url).then(function() { alert("链接已复制！"); });
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
                return '<div id="qcard-' + i + '" data-qnum="' + num + '"><div class="bg-blue-50 border-l-4 border-blue-400 p-6 rounded-r-lg">'
                    + '<p class="mb-3"><span class="verse-ref">📖 ' + esc(stripEmoji(q.h || q.o || '核心经文')) + '</span></p>'
                    + '<div class="text-slate-800"><span class="verse-text">' + studyPara(q, i) + '</span></div>' + verdict + '</div></div>';
            }
            if (q.type === 'single' || q.type === 'judge' || q.type === 'multiple') {
                var isMulti = q.type === 'multiple';
                var opts = q.type === 'judge' ? ['√', '×'] : String(q.o || '').split(',');
                var pills = opts.map(function(o) {
                    var t = o.trim(); if (!t) return '';
                    var val = t.charAt(0);
                    return '<label class="sopt" data-val="' + esc(val) + '"><input type="' + (isMulti ? 'checkbox' : 'radio') + '" name="u-' + i + '" value="' + esc(val) + '" class="hidden"><span>' + esc(t) + '</span></label>';
                }).join('');
                return '<div id="qcard-' + i + '" data-qnum="' + num + '"><p>' + num + '. ' + hlVerse(esc(q.q)) + (isMulti ? ' <span class="text-xs text-indigo-500 font-bold">（多选）</span>' : '') + '</p>'
                    + '<div class="flex flex-wrap gap-2 mt-3">' + pills + '</div>' + verdict + '</div>';
            }
            if (q.type === 'essay') {
                return '<div id="qcard-' + i + '" data-qnum="' + num + '"><p>' + num + '. ' + hlVerse(esc(q.q)) + '</p>'
                    + '<textarea id="u-' + i + '" class="quiz-input w-full p-4 border rounded-2xl bg-slate-50 h-28 mt-3" placeholder="输入你的回答..."></textarea>' + verdict + '</div>';
            }
            return '<div id="qcard-' + i + '" data-qnum="' + num + '"><p>' + num + '. ' + studyPara(q, i) + '</p>' + verdict + '</div>';
        }
        /* 进度统计：填空按空格数，选择/问答按题数 */
        function studyProgress() {
            var total = 0, filled = 0;
            for (var v = 0; v < activeQuizzes.length; v++) {
                var qv = activeQuizzes[v];
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
            bar.innerText = '进度：已填写 ' + p.filled + ' / ' + p.total;
            if (studyRevealed) return;
            var btn = document.getElementById('studySubmit'), hint = document.getElementById('studyHint');
            if (!btn || !hint) return;
            if (p.total > 0 && p.filled === p.total) {
                btn.disabled = false;
                hint.innerText = '🎉 填写完成！现在可以核对答案了';
                hint.className = 'mt-4 text-emerald-600 text-sm italic';
            } else {
                btn.disabled = true;
                hint.innerText = '请填写完所有 ' + p.total + ' 个空格以激活核对功能';
                hint.className = 'mt-4 text-rose-500 text-sm italic';
            }
        }
        function studySubmitBtn() { if (studyRevealed) toggleStudyEdit(); else submitStudy(); }
        async function submitStudy() {
            if (BOOT.shareMode && !(localStorage.getItem(USER_KEY) || "").trim()) {
                alert("请先在页面上方设置学员姓名，成绩将记在该姓名下。");
                var sni = document.getElementById("shareNameInput"); if (sni) sni.focus();
                return;
            }
            if (!(localStorage.getItem(USER_KEY) || "").trim()) { openAuthModal('login', null, false); return; }
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
            if (!ok) { alert('还有未填写的内容，请填写完整后再核对。'); return; }
            var btn = document.getElementById('studySubmit');
            btn.disabled = true; btn.innerText = '核对中…';
            var name = localStorage.getItem(USER_KEY) || '匿名学员';
            try {
                var r = await fetch('/api/submit', {
                    method: 'POST',
                    body: JSON.stringify({ username: name, course_id: activeLessonId, courseTitle: activeCourseTitle, answers: answers, token: (function(){ try { return localStorage.getItem(STUDENT_TOKEN_KEY) || ""; } catch(e) { return ""; } })() })
                });
                var res = await r.json();
                if (!r.ok || !res.details) throw 0;
                renderStudyGraded(res);
            } catch (e) {
                alert('核对失败，请检查网络后重试');
                btn.disabled = false; btn.innerText = '核对答案';
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
                    if (d.verdict === null) vEl.innerHTML = '<span class="text-amber-600">○ 开放性答案，请对照参考自评</span>';
                    else vEl.innerHTML = d.verdict ? '<span class="text-emerald-600">✓ 回答正确</span>' : '<span class="text-red-500">✗ 回答错误</span>';
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
                        '<div class="qref-wrap mt-2"><button onclick="toggleQRef(' + d.i + ')" class="text-xs font-bold text-indigo-600 hover:underline">📖 显示/隐藏参考答案</button>'
                        + '<div id="qref-' + d.i + '" class="hidden mt-2 text-sm rounded-xl bg-indigo-50 border border-indigo-100 p-3 text-slate-700 text-left">' + esc(d.expected) + '</div></div>');
                }
                if (d.verdict === false) {
                    if (vEl) vEl.insertAdjacentHTML('afterend',
                        '<div class="ans-compare mt-2 text-sm rounded-xl bg-red-50 border border-red-100 p-3 space-y-1 text-left">'
                        + '<div><span class="font-bold text-red-500">你的答案：</span><span class="text-slate-700">' + esc(userAnsText || '（未填）') + '</span></div>'
                        + '<div><span class="font-bold text-emerald-600">正确答案：</span><span class="text-slate-700">' + esc(correctText || '') + '</span></div></div>');
                    var qn = card ? (card.getAttribute('data-qnum') || '') : '';
                    wrongs.push({ cid: activeLessonId, title: activeCourseTitle, series: activeCategory, sub: activeSubcategory, q: q.q || '', type: q.type || '', n: qn, u: userAnsText, expected: correctText, ts: Date.now() });
                }
            });
            if (wrongs.length) saveWrongs(wrongs);
            /* 错题同步到服务端，教师可在管理端查看（失败不影响本地） */
            try {
                if (name && name !== "匿名学员") {
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
            if (btn) { btn.disabled = false; btn.innerText = '返回修改填写'; btn.classList.remove('bg-slate-800', 'hover:bg-slate-900'); btn.classList.add('bg-emerald-600', 'hover:bg-emerald-700'); }
            if (hint) { hint.innerText = '核对完成：' + res.score + ' / ' + res.gradable + '（成绩已上传）'; hint.className = 'mt-4 text-slate-500 text-sm'; }
            var bar = document.getElementById('progress-bar');
            if (bar) bar.innerText = '进度：已填写 ' + p.total + ' / ' + p.total + ' · 得分 ' + res.score + ' / ' + res.gradable;
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
            if (btn) { btn.innerText = '核对答案'; btn.classList.remove('bg-emerald-600', 'hover:bg-emerald-700'); btn.classList.add('bg-slate-800', 'hover:bg-slate-900'); }
            updateStudyBar();
            updateQReport();
        }

        /* 分 Tab 课件：页签切换 / 问答参考答案开关 / 成绩报告 */
        function switchQTab(tab) {
            if (tab !== 'overview' && !requireNameForQuiz(tab)) return;
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
                if (r) { r.innerText = '待核对'; r.className = 'text-xl md:text-2xl font-bold text-slate-400'; }
                if (h) h.innerText = '全部填写完成后，点击「核对答案」即可在这里看到得分与掌握评级。';
                if (act) { act.innerText = '核对答案'; act.className = 'bg-slate-800 hover:bg-slate-900 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition'; }
                return;
            }
            var sc = lastGradeRes.score, gr = lastGradeRes.gradable;
            if (s) s.innerText = sc + ' / ' + gr;
            var pct = gr > 0 ? sc / gr * 100 : 0, rating = '继续加油', cls = 'text-xl md:text-2xl font-bold text-slate-400';
            if (pct >= 80) { rating = '融会贯通'; cls = 'text-xl md:text-2xl font-bold text-emerald-600'; }
            else if (pct >= 60) { rating = '掌握良好'; cls = 'text-xl md:text-2xl font-bold text-indigo-600'; }
            else if (ans > 0) { rating = '需再复习'; cls = 'text-xl md:text-2xl font-bold text-amber-500'; }
            if (r) { r.innerText = rating; r.className = cls; }
            if (h) h.innerText = '核对完成，成绩已上传；错题已自动加入错题本。如需重做，可点击「返回修改填写」或「重新作答」。';
            if (act) { act.innerText = '返回修改填写'; act.className = 'bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition'; }
        }

        async function startLesson(id) {
            var item = null;
            for (var k = 0; k < allData.length; k++) { if (allData[k].id === id) { item = allData[k]; break; } }
            if (!item) return;
            activeLessonId = id;
            activeCourseTitle = item.title;
            activeCategory = item.category || "";
            activeSubcategory = item.subcategory || "";
            teacherMode = false;
            await refreshStudentAdmin();
            var prog = getMyProg();
            if (!prog[id] || !prog[id].completed) { prog[id] = { started: true, completed: false }; setMyProg(prog); }
            activeQuizzes = JSON.parse(item.quizzes_json || "[]");

            var videoHtml = "";
            if (item.video_url) {
                if (/\\\.(mp4|webm|m4v|ogg)(\\\?|#|$)/i.test(item.video_url)) {
                    videoHtml = '<div class="rounded-3xl overflow-hidden bg-black mb-8"><video src="' + esc(item.video_url) + '" controls playsinline preload="metadata" class="w-full max-h-[60vh]"></video></div>';
                } else {
                    videoHtml = '<a href="' + esc(item.video_url) + '" target="_blank" rel="noopener" class="block rounded-3xl mb-8 p-8 text-center bg-gradient-to-br from-slate-900 to-indigo-950 text-white no-underline">'
                        + '<div class="text-5xl mb-3">▶️</div>'
                        + '<div class="font-black text-lg mb-1">观看课程视频</div>'
                        + '<div class="text-slate-400 text-xs">点击在新页面打开观看</div></a>';
                }
            }
            studyRevealed = false;
            var info0 = catInfo[item.category] || { description: "", subDesc: {} };
            var subDesc0 = item.subcategory ? (info0.subDesc[item.subcategory] || "") : "";
            /* 统一智能页头：有章节→分章课件版，无章节→互动答题版，均带实时进度 */
            var hasSections = activeQuizzes.some(function(q) { return (q.s || "").trim() !== ""; });
            var totalUnits = countUnits();
            var subTitle = hasSections ? '专题课件 · 分章互动版' : '互动答题 · 即时核对版';
            var shareBar = '';
            if (BOOT.shareMode) {
                shareBar = '<div class="mb-6 flex flex-wrap items-center justify-between gap-3 bg-violet-50 border border-violet-100 rounded-2xl px-4 py-3 text-left">'
                    + '<a href="/" class="text-sm font-bold text-violet-700 hover:underline">← 返回智学课程系统</a>'
                    + '<div id="shareNameBox" class="flex items-center gap-2 text-sm">' + shareNameHTML() + '</div></div>';
            } else {
                shareBar = '<div class="mb-6 flex flex-wrap items-center justify-between gap-3 bg-violet-50 border border-violet-100 rounded-2xl px-4 py-3 text-left">'
                    + '<a href="javascript:void(0)" onclick="closeLessonModal()" class="text-sm font-bold text-violet-700 hover:underline">← 返回课程列表</a>'
                    + '<div class="flex items-center gap-2 text-sm">' + shareNameHTML() + '</div></div>';
            }
            /* ===== 分 Tab 互动课件：导读 / 按题型分页 / 成绩报告（参考互动课件 UI） ===== */
            lastGradeRes = null;
            var typeTabs = [
                { t: 'verse', label: '经文诵读', icon: '📖' },
                { t: 'fill', label: '填空题', icon: '✏️' },
                { t: 'single', label: '单项选择题', icon: '🔘' },
                { t: 'multiple', label: '多项选择题', icon: '☑️' },
                { t: 'judge', label: '判断题', icon: '⚖️' },
                { t: 'essay', label: '问答与思辨', icon: '💬' }
            ].filter(function (mt) { return activeQuizzes.some(function (q) { return q.type === mt.t; }); });
            var CN_NUM = ['一', '二', '三', '四', '五', '六'];
            typeTabs.forEach(function (mt, ti) {
                mt.num = CN_NUM[ti] || '';
                mt.count = activeQuizzes.filter(function (q) { return q.type === mt.t; }).length;
            });
            var tabBtns = '<button id="qtab-overview" onclick="switchQTab(\\'overview\\')" class="qtab-btn qtab-active">📖 课程导读</button>'
                + typeTabs.map(function (mt) {
                    return '<button id="qtab-' + mt.t + '" onclick="switchQTab(\\'' + mt.t + '\\')" class="qtab-btn">' + mt.icon + ' ' + (mt.num ? mt.num + '、' : '') + mt.label + '<span class="qtab-count">' + mt.count + '题</span></button>';
                }).join('')
                + '<button id="qtab-report" onclick="switchQTab(\\'report\\')" class="qtab-btn qtab-report">📊 成绩报告</button>';
            var teacherTopBtn = '<button id="teacherBtn" onclick="teacherUnlock()" class="shrink-0 text-xs px-3 py-2 rounded-lg font-bold bg-slate-800 hover:bg-slate-700 text-amber-200 border border-amber-500/30 transition">🔑 教师版查看答案</button>';
            document.getElementById('lessonHeader').innerHTML = shareBar
                + '<div class="sticky top-0 z-40 -mx-3 md:-mx-6 px-3 md:px-6 pt-4 pb-2 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 shadow-md">'
                + '<div class="w-full max-w-6xl mx-auto"><div class="flex items-start justify-between gap-3">'
                + '<div class="min-w-0"><div class="flex items-center gap-2 text-[11px] font-semibold text-indigo-300 uppercase tracking-wider mb-1">'
                + '<span class="bg-indigo-900/80 px-2.5 py-0.5 rounded-full border border-indigo-700/50 truncate">' + esc(item.category || '课程') + '</span>'
                + (item.subcategory ? '<span class="bg-amber-900/60 text-amber-200 px-2.5 py-0.5 rounded-full border border-amber-600/50 truncate">📁 ' + esc(item.subcategory) + '</span>' : '')
                + '<span class="shrink-0">在线互动课件</span></div>'
                + '<h1 class="text-xl md:text-2xl font-bold text-indigo-50 leading-snug">' + esc(item.title) + '</h1>'
                + '<p class="text-indigo-300/80 text-xs mt-1">' + subTitle + '</p></div>'
                + (canViewAnswers() ? teacherTopBtn : '<button onclick="openWrongBook(activeLessonId)" class="shrink-0 text-xs px-3 py-2 rounded-lg font-bold bg-indigo-900/80 hover:bg-indigo-800 text-indigo-100 border border-indigo-700/50 transition">📝 错题本</button>')
                + '</div>'
                + '<div id="progress-bar" class="text-xs mt-2 text-indigo-200 font-medium">进度：已填写 0 / ' + totalUnits + '</div>'
                + '<nav class="flex gap-1 overflow-x-auto mt-1.5">' + tabBtns + '</nav>'
                + '</div></div>';
            /* 导读页：视频 / 课程内容 / 答题说明 / 开始答题 */
            var typeSummary = typeTabs.map(function (mt) { return (mt.num ? mt.num + '、' : '') + mt.label + mt.count + '题'; }).join('、');
            var firstTab = typeTabs.length ? typeTabs[0].t : 'report';
            /* 章节导读卡片（思维导图式）：管理端按章节一条条录入的小结 */
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
                + (item.content ? '<div class="prose text-slate-600 bg-slate-50 p-6 rounded-2xl text-sm leading-relaxed max-w-none">' + marked.parse(item.content) + '</div>' : '')
                + guideCards
                + '<div class="bg-amber-50 p-4 rounded-xl border border-amber-200/80 flex items-start gap-3"><div class="shrink-0">💡</div>'
                + '<div class="text-xs text-amber-900 leading-relaxed whitespace-pre-line"><b>答题说明：</b>' + (item.instructions ? esc(item.instructions) : ('本课共' + esc(typeSummary || '多种题型') + '。请按上方页签逐项作答，全部填写完成后点击底部「核对答案」查看判分与解析；错题会自动进入错题本，方便复习。')) + '</div></div>'
                + '<div class="flex justify-end"><button onclick="switchQTab(\\'' + firstTab + '\\')" class="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition">开始答题 →</button></div>'
                + '</div></section>';
            /* 按题型分页：有章节则组内再按章节徽章分组 */
            function qCardWrap(q, i, n) {
                return '<div class="bg-white rounded-xl p-5 shadow-sm border border-slate-200/80 text-slate-700 leading-relaxed">' + renderQ(q, i, n) + '</div>';
            }
            var typeSecs = typeTabs.map(function (mt) {
                var secHtml = '';
                var qnum = 0;
                if (hasSections) {
                    var secs = [], secMap = {};
                    activeQuizzes.forEach(function (q) { var s = (q.s || '').trim() || '本课内容'; if (!secMap[s]) { secMap[s] = true; secs.push(s); } });
                    secs.forEach(function (s, si) {
                        var inner = '';
                        activeQuizzes.forEach(function (q, i) {
                            if (q.type !== mt.t) return;
                            if (((q.s || '').trim() || '本课内容') !== s) return;
                            if (q.type !== 'verse') { qnum++; }
                            inner += qCardWrap(q, i, qnum);
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
                        flat += qCardWrap(q, i, qnum);
                    });
                    secHtml = '<div class="space-y-4">' + flat + '</div>';
                }
                return '<section id="qsec-' + mt.t + '" class="qsec hidden">'
                    + '<div class="flex items-center gap-2 mb-4"><span class="w-2 h-6 bg-indigo-600 rounded-full"></span>'
                    + '<h2 class="text-xl font-bold text-slate-900">' + mt.icon + ' ' + (mt.num ? mt.num + '、' : '') + mt.label + ' <span class="text-sm font-normal text-slate-400">(共' + mt.count + '题)</span></h2></div>'
                    + secHtml + '</section>';
            }).join('');
            /* 成绩报告页 */
            var reportSec = '<section id="qsec-report" class="qsec hidden"><div class="bg-white rounded-2xl p-6 md:p-8 shadow-sm border border-slate-200/80 text-center space-y-6">'
                + '<div class="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto text-3xl">🎓</div>'
                + '<div><h2 class="text-2xl font-bold text-slate-900">答题成绩与复习报告</h2><p class="text-xs text-slate-500 mt-1">' + esc(item.title) + ' · 综合测评</p></div>'
                + '<div class="grid grid-cols-3 gap-3 max-w-3xl mx-auto">'
                + '<div class="bg-slate-50 p-4 rounded-xl border border-slate-200"><div class="text-xs text-slate-500 mb-1">已答客观题</div><div class="text-xl md:text-2xl font-bold text-indigo-600" id="qr-progress">0 / 0</div></div>'
                + '<div class="bg-slate-50 p-4 rounded-xl border border-slate-200"><div class="text-xs text-slate-500 mb-1">客观题得分</div><div class="text-xl md:text-2xl font-bold text-emerald-600" id="qr-score">--</div></div>'
                + '<div class="bg-slate-50 p-4 rounded-xl border border-slate-200"><div class="text-xs text-slate-500 mb-1">理解掌握评级</div><div class="text-xl md:text-2xl font-bold text-slate-400" id="qr-rating">待核对</div></div>'
                + '</div>'
                + '<p id="qr-hint" class="text-xs text-slate-500 max-w-3xl mx-auto leading-relaxed"></p>'
                + '<div class="flex flex-wrap justify-center gap-3">'
                + '<button id="qr-action" onclick="studySubmitBtn()" class="bg-slate-800 hover:bg-slate-900 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition">核对答案</button>'
                + '<button onclick="toggleStudyEdit();switchQTab(\\'overview\\')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 px-5 py-2.5 rounded-xl text-xs font-bold transition">↺ 重新作答</button>'
                + (canViewAnswers() ? '<button onclick="teacherUnlock()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition">📖 查看全套参考答案</button>' : '')
                + '</div></div></section>';
            var bodyHtml = '<div id="quizContainer" class="space-y-6">' + overviewSec + typeSecs + reportSec + '</div>'
                + '<div class="sticky bottom-0 z-40 mt-6 -mx-3 md:-mx-6 px-3 md:px-6 pb-4 pt-3 bg-gradient-to-t from-white via-white to-transparent">'
                + '<div class="w-full max-w-6xl mx-auto bg-white/95 backdrop-blur border border-slate-200 rounded-2xl shadow-lg px-4 py-3 flex items-center justify-between gap-3">'
                + '<p id="studyHint" class="text-rose-500 text-xs italic">请填写完所有空格以激活核对功能</p>'
                + '<button id="studySubmit" disabled onclick="studySubmitBtn()" class="shrink-0 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white font-bold py-2.5 px-6 rounded-xl shadow transition active:scale-95 text-sm">核对答案</button>'
                + '</div></div>'
                + '<footer class="text-center mt-6 text-slate-400 text-xs">课程来源：' + esc(item.category) + (item.subcategory ? ' · ' + esc(item.subcategory) : '') + ' · ' + esc(item.title) + '</footer>';
            var bodyEl = document.getElementById('lessonBody');
            bodyEl.innerHTML = bodyHtml;

            updateStudyBar();
            bodyEl.oninput = updateStudyBar;
            bodyEl.onchange = updateStudyBar;

            var bb = document.getElementById('backListBtn');
            if (bb) {
                if (BOOT.shareMode) { bb.innerText = '← 返回智学课程系统'; bb.onclick = function() { location.href = '/'; }; }
                else { bb.innerText = '返回列表'; bb.onclick = function() { location.reload(); }; }
            }
            document.getElementById('resultArea').classList.add('hidden');
            toggleModal('lessonModal');
            var lms = document.getElementById('lessonModal'); if (lms) lms.scrollTop = 0;
            switchQTab('overview');
        }

        /* 按姓名查询成绩（管理端） */
        async function queryScores() {
            var nameInput = document.getElementById('scoreQueryName');
            var name = (nameInput.value || "").trim() || (localStorage.getItem(USER_KEY) || "").trim();
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
                        + '<div class="text-xs"><span class="text-emerald-600 font-bold">正确答案：</span><span class="text-slate-600">' + esc(x.correct_answer) + '</span></div>'
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
                        + '<button data-un="' + esc(s.username) + '" data-to="' + (admin ? '0' : '1') + '" onclick="toggleStudentAdmin(this.dataset.un, this.dataset.to)" class="text-xs font-bold px-3 py-1.5 rounded-xl ' + (admin ? 'bg-slate-100 text-slate-500' : 'bg-violet-600 text-white') + '">'
                        + (admin ? '取消管理员' : '设为管理员') + '</button></li>';
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
            + '.chapter ul{margin:6px 0 0;padding-left:20px;color:#475569;} .chapter li{margin-bottom:4px;}'
            + '.q{border-top:1px solid #f1f5f9;padding:14px 0;} .q:first-of-type{border-top:none;}'
            + '.q-text{font-weight:600;margin-bottom:8px;}'
            + '.blank{display:inline-block;min-width:70px;border-bottom:2px solid #94a3b8;margin:0 2px;}'
            + '.opts{margin:8px 0;} .opt{padding:6px 0;color:#475569;}'
            + 'details.ans{margin-top:8px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:10px 14px;}'
            + 'details.ans summary{cursor:pointer;font-weight:700;color:#047857;font-size:14px;}'
            + 'details.ans div{margin-top:6px;color:#334155;}'
            + 'footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:24px;}'
            + '.empty{color:#94a3b8;text-align:center;padding:20px;}'
            + '.ws{margin:10px 0 4px;}.ws-line{border-bottom:1px solid #cbd5e1;height:1.8em;}'
            + '.verse-ref{display:inline-block;background:#7c3aed;color:#fff;font-weight:700;font-size:12px;padding:1px 8px;border-radius:9999px;white-space:nowrap;}.verse-text{background:#fef3c7;border-bottom:2px solid #f59e0b;border-radius:3px;padding:0 3px;}'
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
        function buildExportHTML(c) {
            var qs = [], guide = [];
            try { qs = JSON.parse(c.quizzes_json || '[]'); } catch (e) {}
            try { guide = JSON.parse(c.guide_json || '[]'); } catch (e) {}
            var title = c.title || '未命名课件';
            var meta = [c.category, c.subcategory].filter(function(x) { return x; }).join(' · ');
            var now = new Date(), ds = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
            var body = '', i;
            if (c.content) body += '<section class="card"><h2>📖 课程导读</h2><div class="md">' + expMd(c.content) + '</div></section>';
            if (c.video_url) body += '<section class="card"><h2>🎬 课程视频</h2><p class="md"><a href="' + esc(c.video_url) + '">观看课程视频</a></p></section>';
            var realGuide = guide.filter(function(g) { return g && (g.title || (g.points || []).length); });
            if (realGuide.length) {
                body += '<section class="card"><h2>🗺️ 章节导读</h2>' + realGuide.map(function(g, gi) {
                    var pts = (g.points || []).filter(function(x) { return String(x).trim(); });
                    return '<div class="chapter"><div class="ch-title">' + esc(g.title || ('第' + (gi + 1) + '章')) + '</div>'
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
                    var qtext = expInline(hlVerse(esc(q.q || '')));
                    var bracket = (t === 'single' || t === 'multiple' || t === 'judge') ? '（ ）' : '';
                    var opts = '';
                    if ((t === 'single' || t === 'multiple') && q.o) {
                        opts = '<div class="opts">' + String(q.o).split(',').map(function(p) {
                            return '<div class="opt">' + esc(String(p).trim()) + '</div>';
                        }).join('') + '</div>';
                    }
                    var ans = expAnswer(q);
                    var ws = '';
                    if (t === 'essay') {
                        ws = '<div class="ws">';
                        for (var wi = 0; wi < 5; wi++) ws += '<div class="ws-line"></div>';
                        ws += '</div>';
                    }
                    body += '<div class="q"><div class="q-text">' + (qi + 1) + '. ' + bracket + qtext + '</div>' + opts + ws
                        + (ans ? '<details class="ans"><summary>查看答案</summary><div>' + esc(ans) + '</div></details>' : '') + '</div>';
                });
                body += '</section>';
            });
            if (!hasQ && !c.content && !realGuide.length) body += '<section class="card"><p class="empty">本课件暂无内容</p></section>';
            return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
                + '<meta name="viewport" content="width=device-width,initial-scale=1">'
                + '<title>' + esc(title) + ' - 团契智学</title><style>' + EXP_CSS + '</style></head>'
                + '<body><div class="wrap"><header class="hero"><div class="meta">' + esc(meta) + '</div>'
                + '<h1>' + esc(title) + '</h1><div class="date">导出日期：' + ds + ' · 团契智学</div></header>'
                + body + '<footer>由团契智学学习平台导出</footer></div></body></html>';
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
        function openExportMenu(ids) {
            exportIds = ids || [];
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
            if (exportIds.length === 1) {
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
                var c = findCourse(ids[0]);
                if (c) printCourse(c);
                if (ids.length > 1) alert('打印每次仅支持 1 个课件，已打开第 1 个');
                return;
            }
            ids.forEach(function(id, i) { setTimeout(function() { exportOne(id, fmt); }, i * 900); });
        }
        function exportOne(id, fmt) {
            var c = findCourse(id);
            if (!c) return;
            var fn = safeFileName(c.title);
            if (fmt === 'html') downloadHTML(fn + '.html', buildExportHTML(c));
            else if (fmt === 'word') downloadText(fn + '.doc', buildWordHTML(c), 'application/msword');
            else if (fmt === 'excel') downloadText(fn + '.xls', buildExcelHTML(c), 'application/vnd.ms-excel');
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
        var WORD_CSS = 'body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.75;color:#1e293b;font-size:14px;}'
            + 'h1{font-size:24px;}h2{font-size:18px;color:#4c1d95;border-bottom:2px solid #a78bfa;padding-bottom:6px;}'
            + '.hero{background:#ede9fe;padding:20px;}'
            + '.card{margin-bottom:16px;}'
            + '.q{margin:12px 0;}.q-text{font-weight:bold;}'
            + '.blank{display:inline-block;min-width:70px;border-bottom:2px solid #94a3b8;}'
            + '.ans{background:#f0fdf4;border:1px solid #bbf7d0;padding:8px 12px;margin-top:6px;}'
            + '.chapter{margin-bottom:10px;}.ch-title{font-weight:bold;}'
            + '.md p{margin:0 0 8px;}.md ul{margin:0 0 8px;padding-left:20px;}'
            + '.verse-ref{display:inline-block;background:#7c3aed;color:#fff;font-weight:700;font-size:12px;padding:1px 8px;border-radius:9999px;white-space:nowrap;}.verse-text{background:#fef3c7;border-bottom:2px solid #f59e0b;border-radius:3px;padding:0 3px;}'
            + '.ws{margin:10px 0 4px;}.ws-line{border-bottom:1px solid #cbd5e1;height:28px;}'
            + '.answer-key{page-break-before:always;}.answer-key ol{margin:6px 0 12px;padding-left:24px;}.answer-key li{margin-bottom:6px;}';
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
            h = h.split('<html lang="zh-CN">').join('<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">');
            var p1 = h.split('<style>');
            var p2 = p1[1].split('</style>');
            h = p1[0] + '<style>' + WORD_CSS + '</style>' + p2[1];
            var dd1 = '<details class="ans">', dd2 = '</details>', di, dj;
            while ((di = h.indexOf(dd1)) >= 0) {
                dj = h.indexOf(dd2, di);
                if (dj < 0) break;
                h = h.slice(0, di) + h.slice(dj + dd2.length);
            }
            h = h.split('<span class="blank">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>').join('<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>');
            var key = buildAnswerKey(c);
            if (key) h = h.split('<footer>').join(key + '<footer>');
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
                guideHtml = '<h3>章节导读</h3><table border="1" cellpadding="6" cellspacing="0"><tr><th>序号</th><th>章节</th><th>要点</th></tr>' + grows + '</table><br><br>';
            }
            var trs = qs.map(function(q, i) {
                var t = q.type || 'fill';
                var bracket = (t === 'single' || t === 'multiple' || t === 'judge') ? '（ ）' : '';
                return '<tr><td>' + (i + 1) + '</td><td>' + esc(EXP_TYPE_PLAIN[t] || t) + '</td><td>' + hlVerse(esc(bracket + (q.q || ''))) + '</td><td>' + esc(q.o || '') + '</td><td>' + esc(expAnswer(q)) + '</td></tr>';
            }).join('');
            return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">'
                + '<head><meta charset="utf-8"><style>.verse-ref{display:inline-block;background:#7c3aed;color:#fff;font-weight:700;font-size:12px;padding:1px 8px;border-radius:9999px;white-space:nowrap;}.verse-text{background:#fef3c7;border-bottom:2px solid #f59e0b;border-radius:3px;padding:0 3px;}</style>'
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
            try { nm = (localStorage.getItem(USER_KEY) || "").trim(); } catch (e) {}
            return nm || "匿名学员";
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
                    + '<h3 style="font-weight:800;color:#1e293b;margin:0 0 4px">📥 导出错题本</h3>'
                    + '<p id="wrongExportSub" style="font-size:12px;color:#94a3b8;margin:0 0 16px"></p>'
                    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
                    + '<button data-fmt="html" onclick="doWrongExport(this.dataset.fmt)" ' + btn + '>📄<br>网页 HTML</button>'
                    + '<button data-fmt="word" onclick="doWrongExport(this.dataset.fmt)" ' + btn + '>📝<br>Word 文档</button>'
                    + '<button data-fmt="excel" onclick="doWrongExport(this.dataset.fmt)" ' + btn + '>📊<br>Excel 表格</button>'
                    + '<button data-fmt="pptx1" onclick="doWrongExport(this.dataset.fmt)" ' + btn + '>📽️<br>PPT 单页版<br><span style="font-size:11px;font-weight:400;color:#94a3b8">自设动画</span></button>'
                    + '<button data-fmt="pptx2" onclick="doWrongExport(this.dataset.fmt)" ' + btn + '>📽️<br>PPT 两页版<br><span style="font-size:11px;font-weight:400;color:#94a3b8">翻页揭示</span></button>'
                    + '</div>'
                    + '<button data-fmt="print" onclick="doWrongExport(this.dataset.fmt)" style="margin-top:8px;width:100%;border:1px solid #e2e8f0;border-radius:16px;padding:12px;font-size:14px;font-weight:700;color:#334155;background:#fff">🖨️ 打印 / 存为 PDF</button>'
                    + '<button onclick="closeWrongExportMenu()" style="margin-top:4px;width:100%;font-size:12px;color:#94a3b8;padding:8px;background:none;border:none">取消</button>'
                    + '</div>';
                document.body.appendChild(m);
            }
            var fc = window._wrongCourseId || null;
            var arr = getWrong()[wrongBookName()] || [];
            if (fc) arr = arr.filter(function(x) { return x.cid === fc; });
            document.getElementById('wrongExportSub').innerText = wrongBookName() + ' · 共' + arr.length + '题' + (fc ? '（本课件）' : '（全部课件）');
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
            if (!arr.length) { alert("错题本是空的"); return; }
            var fn = safeFileName(name + '的错题本');
            var pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
            if (fmt === 'html') downloadHTML(fn + '.html', buildWrongHTML(name, arr));
            else if (fmt === 'word') downloadText(fn + '.doc', buildWrongWordHTML(name, arr), 'application/msword');
            else if (fmt === 'excel') downloadText(fn + '.xls', buildWrongExcelHTML(name, arr), 'application/vnd.ms-excel');
            else if (fmt === 'pptx1') downloadBytes(fn + '-单页版.pptx', buildWrongPptx(name, arr, 'single'), pptxMime);
            else if (fmt === 'pptx2') downloadBytes(fn + '-两页版.pptx', buildWrongPptx(name, arr, 'dual'), pptxMime);
            else if (fmt === 'print') printWrongs(name, arr);
        }
        function buildWrongHTML(name, arr) {
            var ds = wrongDateStr();
            var body = arr.map(function(x, i) {
                return '<section class="card"><h2>第' + (i + 1) + '题 <span style="font-size:13px;color:#6366f1;">' + esc(wrongTypeNum(x)) + '</span></h2>'
                    + (wrongMeta(x) ? '<p style="font-size:12px;color:#94a3b8;margin:-8px 0 10px;">' + esc(wrongMeta(x)) + '</p>' : '')
                    + '<div class="md"><p>' + esc(x.q || '') + '</p>'
                    + '<p>你的答案：<b style="color:#dc2626;">' + esc(x.u || '（未填）') + '</b></p>'
                    + '<p>正确答案：<b style="color:#059669;">' + esc(x.expected || '') + '</b></p></div></section>';
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
            h = h.split('<html lang="zh-CN">').join('<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">');
            var p1 = h.split('<style>');
            var p2 = p1[1].split('</style>');
            h = p1[0] + '<style>' + WORD_CSS + '</style>' + p2[1];
            return h;
        }
        function buildWrongExcelHTML(name, arr) {
            var trs = arr.map(function(x, i) {
                return '<tr><td>' + (i + 1) + '</td><td>' + esc(x.series || '') + '</td><td>' + esc(x.sub || '') + '</td><td>' + esc(x.title || '') + '</td>'
                    + '<td>' + esc(WRONG_TYPE_LABEL[x.type] || x.type || '') + '</td><td>' + esc(x.n || '') + '</td>'
                    + '<td>' + esc(x.q || '') + '</td><td>' + esc(x.u || '') + '</td><td>' + esc(x.expected || '') + '</td></tr>';
            }).join('');
            return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">'
                + '<head><meta charset="utf-8"></head><body>'
                + '<h3>' + esc(name) + '的错题本（共' + arr.length + '题）</h3>'
                + '<table border="1" cellpadding="6" cellspacing="0"><tr><th>序号</th><th>系列</th><th>子栏目</th><th>课件</th><th>题型</th><th>题号</th><th>题目</th><th>你的答案</th><th>正确答案</th></tr>'
                + trs + '</table></body></html>';
        }
        function printWrongs(name, arr) {
            var w = window.open('', '_blank');
            if (!w) { alert('浏览器阻止了新窗口，请允许弹窗后重试'); return; }
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
                qParas.push(pptxPara(String(x.q || ''), 1800, false));
                qParas.push(pptxPara('你的答案：' + (x.u || '（未填）'), 1800, false, 'C0504D'));
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
                var color = sg.k === 1 ? '7C3AED' : (sg.k === 2 ? 'B45309' : null);
                return pptxRun(sg.t, sz, sg.k === 1, color);
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
                    t: [pptxPara('章节导读 · ' + (g.title || ('第' + (gi + 1) + '章')), 3200, true)],
                    b: pts.map(function(x) { return pptxRichPara('• ' + String(x).trim(), 1800); })
                });
            });
            var single = (mode === 'single');
            qs.forEach(function(q, i) {
                var t = q.type || 'fill';
                var lines = ['【' + (EXP_TYPE_PLAIN[t] || '') + '】' + (q.q || '')];
                if ((t === 'single' || t === 'multiple') && q.o) {
                    String(q.o).split(',').forEach(function(o) { lines.push(String(o).trim()); });
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
        async function adminLogin() {
            var p = document.getElementById('adminPwd').value;
            if (!p) return;
            var r = await fetch('/api/verify', { method: 'POST', body: JSON.stringify({ password: p }) });
            var j = await r.json();
            if (j.ok) { sessionStorage.setItem('TQ_ADMIN_OK', '1'); location.reload(); }
            else alert('密码错误');
        }

        /* 教师版：查看本课全部正确答案（需管理会话） */
        async function teacherUnlock() {
            if (!document.getElementById('teacherBtn')) return;
            if (teacherMode) {
                teacherMode = false;
                document.querySelectorAll('.tch-box').forEach(function(el) { el.remove(); });
                document.getElementById('teacherBtn').innerText = '🔑 教师版查看答案';
                return;
            }
            var ansUrl = '/api/answers?course_id=' + encodeURIComponent(activeLessonId || "");
            var isStuAdmin = !BOOT.isAdmin && studentIsAdmin();
            if (isStuAdmin) ansUrl += '&username=' + encodeURIComponent(progName()) + '&token=' + encodeURIComponent(studentToken());
            var r = await fetch(ansUrl);
            if (r.status === 403) {
                if (isStuAdmin) { alert("登录已过期，请重新登录"); return; }
                var p = prompt("请输入管理密码进入教师版：");
                if (!p) return;
                var v = await fetch('/api/verify', { method: 'POST', body: JSON.stringify({ password: p }) });
                var j = await v.json();
                if (!j.ok) { alert("密码错误"); return; }
                r = await fetch(ansUrl);
            }
            if (!r.ok) { alert("获取答案失败"); return; }
            var qs = (await r.json()).quizzes || [];
            teacherMode = true;
            activeQuizzes.forEach(function(q, i) {
                var card = document.getElementById('qcard-' + i);
                if (!card || card.querySelector('.tch-box')) return;
                var div = document.createElement('div');
                div.className = 'tch-box mt-4 pt-4 border-t border-dashed border-amber-300 text-sm';
                div.innerHTML = '<span class="font-bold text-amber-700">📖 教师版答案：</span>'
                    + '<span class="text-slate-700 font-bold">' + (esc((qs[i] || {}).a) || '开放性答案') + '</span>';
                card.appendChild(div);
            });
            document.getElementById('teacherBtn').innerText = '✓ 退出教师版';
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
        /* 章节导读（思维导图式）结构化编辑器 */
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
        /* 章节导读：可视化 / JSON 代码双模式 */
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
                    if (!Array.isArray(guideVal)) { alert('章节导读 JSON 顶层必须是数组'); return; }
                } catch (e) { alert('章节导读 JSON 格式错误：' + e.message); return; }
            } else {
                guideVal = guideData;
            }
            var sv = document.getElementById('f_series').value;
            var series = sv === '__new__' ? document.getElementById('f_series_new').value.trim() : sv;
            var uv = document.getElementById('f_sub').value;
            var sub = uv === '__new__' ? document.getElementById('f_sub_new').value.trim() : (uv || "");
            if (!series) { alert("请选择或新建一个系列"); return; }
            var b = { id: document.getElementById('f_id').value, category: series, subcategory: sub, title: document.getElementById('f_title').value, content: document.getElementById('f_content').value, video_url: document.getElementById('f_video').value, guide: guideVal, instructions: document.getElementById('f_instructions').value, quizzes: quizzes };
            var r = await fetch('/api/save', { method: 'POST', body: JSON.stringify(b) });
            if (r.status === 403) { alert("请先登录管理端后再发布"); return; }
            if (r.ok) location.reload(); else alert("保存失败");
        }
        function openEditModal() { document.getElementById('f_id').value = ""; document.getElementById('f_video').value = ""; document.getElementById('f_instructions').value = ""; document.getElementById('f_series_new').value = ""; document.getElementById('f_sub_new').value = ""; document.getElementById('quizList').innerHTML = ""; guideData = []; initGuideEditor(); renderGuideEditor(); renderCatForm(); addQuizRow(); document.getElementById('quizJson').value = ""; initQuizMode(); setQuizMode('visual'); document.getElementById('guideJson').value = ""; initGuideMode(); setGuideMode('visual'); toggleModal('editModal'); }
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
            document.getElementById('quizList').innerHTML = ""; JSON.parse(item.quizzes_json || "[]").forEach(function(q) { addQuizRow(q); });
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
        function renderCatList() {
            var box = document.getElementById('catList');
            if (!box) return;
            if (!catRows.length) {
                box.innerHTML = '<div class="text-sm text-slate-400">暂无系列。点击右上角"＋ 新增系列"创建；保存课程时填写的系列也会自动出现在这里补简介。</div>';
                return;
            }
            box.innerHTML = catRows.map(function(s) {
                var subs = (s.subs || []).map(function(x) {
                    return '<div class="ml-5 mt-2 border-l-2 border-violet-100 pl-3 py-1.5 flex items-start gap-2">'
                        + '<div class="flex-1 min-w-0"><div class="text-sm font-bold text-slate-700">📁 ' + esc(x.name)
                        + ' <span class="text-xs font-normal text-slate-400">' + x.count + ' 门课程</span></div>'
                        + '<div class="text-xs text-slate-500 mt-0.5 leading-relaxed">' + (x.description ? esc(x.description) : '<span class="text-slate-300">（暂无简介）</span>') + '</div></div>'
                        + '<div class="flex gap-1.5 shrink-0">'
                        + '<button data-p="' + esc(s.name) + '" data-n="' + esc(x.name) + '" onclick="openCatModal(this.dataset.p, this.dataset.n)" class="text-xs bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-lg font-bold">编辑</button>'
                        + '<button data-p="' + esc(s.name) + '" data-n="' + esc(x.name) + '" onclick="deleteCat(this.dataset.p, this.dataset.n)" class="text-xs bg-red-50 text-red-500 px-2.5 py-1 rounded-lg font-bold">删除</button>'
                        + '</div></div>';
                }).join('');
                return '<div class="border border-slate-100 rounded-2xl p-4">'
                    + '<div class="flex items-start gap-3"><div class="flex-1 min-w-0">'
                    + '<div class="font-bold text-slate-800 text-sm">📚 ' + esc(s.name)
                    + ' <span class="text-xs font-normal text-slate-400">' + s.totalCount + ' 门课程</span></div>'
                    + '<div class="text-xs text-slate-500 mt-1 leading-relaxed">' + (s.description ? esc(s.description) : '<span class="text-slate-300">（暂无简介，点击编辑添加）</span>') + '</div></div>'
                    + '<div class="flex gap-1.5 shrink-0 flex-wrap justify-end">'
                    + '<button data-p="' + esc(s.name) + '" onclick="openCatModal(this.dataset.p, null)" class="text-xs bg-violet-50 text-violet-600 px-2.5 py-1 rounded-lg font-bold">＋子栏目</button>'
                    + '<button data-p="" data-n="' + esc(s.name) + '" onclick="openCatModal(this.dataset.p, this.dataset.n)" class="text-xs bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-lg font-bold">编辑</button>'
                    + '<button data-p="" data-n="' + esc(s.name) + '" onclick="deleteCat(this.dataset.p, this.dataset.n)" class="text-xs bg-red-50 text-red-500 px-2.5 py-1 rounded-lg font-bold">删除</button>'
                    + '</div></div>'
                    + subs + '</div>';
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
            document.getElementById('cat_name').value = row ? row.name : "";
            document.getElementById('cat_desc').value = row ? (row.description || "") : "";
            document.getElementById('catModalTitle').innerText = parent
                ? (row ? "编辑子栏目（" + parent + "）" : "＋ 新增子栏目（" + parent + "）")
                : (row ? "编辑系列" : "＋ 新增系列");
            toggleModal('catModal');
        }
        async function saveCat() {
            var name = document.getElementById('cat_name').value.trim();
            var desc = document.getElementById('cat_desc').value.trim();
            var parent = document.getElementById('cat_parent').value;
            var oldName = document.getElementById('cat_old').value;
            if (!name) { alert("请填写名称"); return; }
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
        async function doChangePassword() {
            var o = document.getElementById('pw_old').value, n = document.getElementById('pw_new').value;
            var r = await fetch('/api/change-password', { method: 'POST', body: JSON.stringify({ oldPassword: o, newPassword: n }) });
            var j = await r.json().catch(function(){ return {}; });
            if (j.ok) { alert("密码修改成功"); toggleModal('pwModal'); }
            else alert("修改失败：" + (j.error || "未知错误"));
        }
        applyFontScale();
        document.addEventListener("DOMContentLoaded", applyFontScale); /* 浮钮HTML在script之后，等DOM就绪再刷标签 */
        var sn = localStorage.getItem(USER_KEY);
        syncNameBtn();
        var sqn = document.getElementById('scoreQueryName'); if (sqn && sn) sqn.value = sn;
        if (document.getElementById('studentSelect')) loadStudents();
        if (document.getElementById('adminStudentList')) loadAdminStudents();
    </script>

    <!-- 字号调节：全站可见 -->
    <div id="fontFab">
        <div id="fontPanel" class="hidden">
            <button onclick="fontStep(1)" title="放大字体">A＋</button>
            <div id="fontLevelLabel" class="text-xs font-bold text-slate-600 px-1">标准</div>
            <button onclick="fontStep(-1)" title="缩小字体">A－</button>
            <button onclick="fontReset()" title="恢复标准字号" class="font-reset-btn">重置</button>
        </div>
        <button id="fontFabBtn" onclick="toggleFontPanel()" title="调整字体大小">字体</button>
    </div>
<script>
/* PWA：注册 Service Worker（满足 Android WebAPK 可安装性；iOS 用添加到主屏幕） */
if ('serviceWorker' in navigator) { window.addEventListener('load', function() { navigator.serviceWorker.register('/sw.js').catch(function(){}); }); }
</script>
</body>
</html>`;
}
