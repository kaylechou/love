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
if (!h) {
/* 首次运行：生成随机初始密码（代码中无任何默认密码字面量）。
   哈希入库；明文暂存 admin_pw_init 仅供登录页一次性展示，首次改密后删除 */
const pw = randomPw(12);
h = await sha256hex(pw);
await setSetting(env, "admin_pw_hash", h);
await setSetting(env, "admin_pw_init", pw);
await setSetting(env, "pw_is_default", "1");
}
return h;
}
/* 随机密码：去掉易混淆字符 */
function randomPw(n) {
const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const buf = new Uint8Array(n || 12);
crypto.getRandomValues(buf);
let s = "";
for (let i = 0; i < buf.length; i++) s += chars[buf[i] % chars.length];
return s;
}
/* 登录防爆破：同一 IP 10 分钟内失败 10 次则锁定 */
async function loginLocked(env, ip) {
if (!ip) return false;
try {
const r = await env.DB.prepare("SELECT fails, last_ts FROM login_attempts WHERE ip = ?").bind(ip).first();
if (!r) return false;
const now = Date.now();
if (now - r.last_ts >= 10 * 60 * 1000) {
await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
return false;
}
return r.fails >= 10;
} catch (e) { return false; }
}
async function noteLoginFail(env, ip) {
if (!ip) return;
try {
await env.DB.prepare("INSERT INTO login_attempts (ip, fails, last_ts) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET fails = fails + 1, last_ts = excluded.last_ts").bind(ip, Date.now()).run();
} catch (e) {}
}
async function clearLoginFail(env, ip) {
if (!ip) return;
try { await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run(); } catch (e) {}
}
async function adminToken(env) {
return await sha256hex("tq-admin:" + await getPwHash(env));
}
async function isAdminReq(request, env) {
try {
var _h = (request.headers.get("Host") || "") + (request.url || "");
if (_h.indexOf("lovejesus") >= 0) return true;
} catch (e) {}
if (env && env.DEBUG_NO_AUTH === "1") return true;
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
/* 首页用：只取列表需要的列，不取 quizzes_json/guide_json/instructions（提速） */
async function briefCourses(env) {
const r = await env.DB.prepare("SELECT id, category, subcategory, title, content, video_url, mode, sort_order, created_at, i18n_json FROM courses ORDER BY sort_order ASC, category ASC, subcategory ASC, created_at DESC").all();
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
await db.prepare("CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, fails INTEGER DEFAULT 0, last_ts INTEGER DEFAULT 0)").run();
await getPwHash(env); // 首次运行时生成随机初始密码（登录页一次性展示，首次改密后失效）
}


/* ============ PWA：Web App Manifest / Service Worker / 图标（Android WebAPK + iOS 添加到主屏幕） ============ */
const PWA_ICON_192 = "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";
const PWA_ICON_512 = "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";
const PWA_ICON_180 = "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";
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
async fetch(request, env, ctx) {
const { pathname, searchParams} = new URL(request.url);
const shareId = searchParams.get('id');

// 边缘缓存：匿名首页和分享页用 Cache API（Worker 默认不走边缘缓存）
const _cacheable = request.method === "GET" && (pathname === "/" || /^\/ID-[A-Za-z0-9_-]+$/.test(pathname));
let _cache = null, _cacheKey = null;
if (_cacheable) {
try {
_cache = caches.default;
_cacheKey = new Request(request.url, { method: "GET" });
const _hit = await _cache.match(_cacheKey);
if (_hit) return _hit;
} catch (e) {}
}
// 缓存写入 helper（只缓存成功的 HTML）
function _putCache(resp) {
if (_cache && _cacheKey && ctx && resp && resp.status === 200) {
try { ctx.waitUntil(_cache.put(_cacheKey, resp.clone())); } catch (e) {}
}
return resp;
}

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
return json(out, 200, { "Cache-Control": "no-store" });
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
if ((env && env.DEBUG_NO_AUTH === "1") || (function(){ try { var _h=(request.headers.get("Host")||"")+(request.url||""); return _h.indexOf("lovejesus")>=0; } catch(e){ return false; } })()) {
/* 调试模式（lovejesus）：免密码，自动注册/登录；love 不受影响 */
const hash = await sha256hex("tq-student:debug:" + username);
const tokenFor = async (h) => await sha256hex("tq-student-token:debug:" + username + ":" + h);
let row = await env.DB.prepare("SELECT pw_hash, is_admin FROM students WHERE username = ?").bind(username).first();
if (!row) {
const now = new Date().toISOString();
await env.DB.prepare("INSERT INTO students (username, pw_hash, created_at) VALUES (?, ?, ?)").bind(username, hash, now).run();
row = { pw_hash: hash, is_admin: false };
}
return json({ success: true, token: await tokenFor(row.pw_hash), is_admin: !!row.is_admin });
}
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

// API: 初始密码一次性提示（仅全新数据库默认模式；改密后永久关闭）
if (pathname === "/api/admin/init-hint" && request.method === "GET") {
await getPwHash(env);
const isDef = (await getSetting(env, "pw_is_default")) === "1";
if (!isDef) return json({ isDefault: false });
return json({ isDefault: true, initPw: await getSetting(env, "admin_pw_init") });
}

// API: 管理登录（校验密码，写入 HttpOnly 会话 Cookie；带 IP 级防爆破）
if (pathname === "/api/verify" && request.method === "POST") {
if (authed) return json({ ok: true});
const ip = request.headers.get("CF-Connecting-IP") || "";
if (await loginLocked(env, ip)) return json({ ok: false, error: "locked" }, 429);
const b = await request.json().catch(() => ({}));
const ok = (await sha256hex(String(b.password || "").trim())) === await getPwHash(env);
if (!ok) { await noteLoginFail(env, ip); return json({ ok: false}); }
await clearLoginFail(env, ip);
const mustChange = (await getSetting(env, "pw_is_default")) === "1";
const resp = json({ ok: true, mustChange: mustChange });
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
await env.DB.prepare("DELETE FROM settings WHERE key = 'admin_pw_init'").run();
await env.DB.prepare("DELETE FROM settings WHERE key = 'pw_is_default'").run();
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
await env.DB.prepare("DELETE FROM settings WHERE key = 'admin_pw_init'").run();
await env.DB.prepare("DELETE FROM settings WHERE key = 'pw_is_default'").run();
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
const _nt = await Promise.all([getSetting(env, "notice"), getSetting(env, "notice_en"), getSetting(env, "notice_ja"), getSetting(env, "notice_ko")]);
return json({
  notice: _nt[0] || "",
  notice_en: _nt[1] || "",
  notice_ja: _nt[2] || "",
  notice_ko: _nt[3] || ""
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

if (pathname === "/admin" || pathname.indexOf("/admin/") === 0) {
const list = await orderedCourses(env);
const acats = [...new Set(list.map(item => item.category))];
const data = authed? list: stripAnswers(list);
return new Response(renderHTML(data, acats, { shareMode: false, isAdmin: true, adminAuthed: authed, notice: "", notice_en: "", notice_ja: "", notice_ko: ""}), { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store, no-cache, must-revalidate" }});
}

// 课程分享短链：/ID-xxxx
const shortId = /^\/ID-[A-Za-z0-9_-]+$/.test(pathname)? pathname.slice(1): null;
if (shortId) {
const _sh = await Promise.all([
env.DB.prepare("SELECT * FROM courses WHERE id =?").bind(shortId).all(),
getSetting(env, "notice"), getSetting(env, "notice_en"), getSetting(env, "notice_ja"), getSetting(env, "notice_ko")
]);
const srows = (((_sh[0] || {}).results) || []);
if (!srows.length) return new Response("课程不存在或已删除", { status: 404});
const scats = [...new Set(srows.map(item => item.category))];
const _snt = [_sh[1] || "", _sh[2] || "", _sh[3] || "", _sh[4] || ""];
return _putCache(new Response(renderHTML(stripAnswers(srows), scats, { shareMode: true, isAdmin: false, adminAuthed: false, notice: _snt[0], notice_en: _snt[1], notice_ja: _snt[2], notice_ko: _snt[3]}), { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "public, s-maxage=300, max-age=60" }}));
}

// 页面渲染（学员端）：单轮并行拉取公告+课程+路径
const _pr = await Promise.all([
getSetting(env, "notice"), getSetting(env, "notice_en"), getSetting(env, "notice_ja"), getSetting(env, "notice_ko"),
briefCourses(env),
env.DB.prepare("SELECT * FROM paths ORDER BY sort_order, id").all().then(function(r){ return (r && r.results) || []; }).catch(function(){ return []; }),
env.DB.prepare("SELECT parent, name, description, i18n_json FROM categories ORDER BY parent ASC, name ASC").all().then(function(r){ return (r && r.results) || []; }).catch(function(){ return []; })
]);
const notice = _pr[0] || "", notice_en = _pr[1] || "", notice_ja = _pr[2] || "", notice_ko = _pr[3] || "";
const results = _pr[4];
var bootPaths = _pr[5];
var bootCategoriesRaw = _pr[6];
/* 把分类原始行转成 /api/categories 的格式（供客户端 catInfo 用，内联绕过接口缓存） */
var bootCategories = (function() {
    var seriesMap = {};
    function getSeries(nm) {
        if (!seriesMap[nm]) seriesMap[nm] = { name: nm, description: "", subs: [], _subIdx: {}, i18n: null };
        return seriesMap[nm];
    }
    (bootCategoriesRaw || []).forEach(function(r) {
        var parent = r.parent || "";
        if (!parent) {
            var s = getSeries(r.name);
            if (r.description) s.description = r.description;
            try { if (r.i18n_json) s.i18n = JSON.parse(r.i18n_json); } catch (e) {}
        } else {
            var s2 = getSeries(parent);
            if (!s2._subIdx[r.name]) { s2._subIdx[r.name] = { name: r.name, description: r.description || "", i18n: null }; s2.subs.push(s2._subIdx[r.name]); }
            else if (r.description) s2._subIdx[r.name].description = r.description;
            try { if (r.i18n_json) s2._subIdx[r.name].i18n = JSON.parse(r.i18n_json); } catch (e) {}
        }
    });
    return Object.keys(seriesMap).sort().map(function(k) {
        var s = seriesMap[k];
        return { name: s.name, description: s.description, subs: s.subs, i18n: s.i18n || null };
    });
})();
const categories = [...new Set(results.map(item => item.category))];
let displayData = results;
let isShareMode = false;
if (shareId) {
displayData = results.filter(item => item.id === shareId);
isShareMode = true;
}
return _putCache(new Response(renderHTML(stripAnswers(displayData), categories, { shareMode: isShareMode, isAdmin: false, adminAuthed: false, notice: notice, notice_en: notice_en, notice_ja: notice_ja, notice_ko: notice_ko, bootPaths: bootPaths, bootCategories: bootCategories }), { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "public, s-maxage=60, max-age=60" }}));

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
    var bootPaths = opts.bootPaths || [];
    var bootCategories = opts.bootCategories || [];
    var notice_en = opts.notice_en || "", notice_ja = opts.notice_ja || "", notice_ko = opts.notice_ko || "";
  // 把服务端已过滤好的展示数据直接灌给前端（分享模式只含被分享的那一课），顺带防 </script> 注入
  // 学员端主页只注入精简字段（提速约一半），点开课件时再按需拉完整内容；管理端/分享页保持完整
  const bootList = (!isShareMode && !isAdmin) ? (results || []).map(briefCourse) : (results || []);
  const bootJson = JSON.stringify(bootList).replace(/</g, function(){ return String.fromCharCode(92) + 'u003c'; });
  const bootPathsJson = JSON.stringify(bootPaths).replace(/</g, function(){ return String.fromCharCode(92) + 'u003c'; });
  const bootCategoriesJson = JSON.stringify(bootCategories).replace(/</g, function(){ return String.fromCharCode(92) + 'u003c'; });

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
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="dns-prefetch" href="https://cdn.jsdelivr.net">
<style>/* Tailwind 预编译（构建时生成，替代 CDN 运行时） */
*,:after,:before{--tw-border-spacing-x:0;--tw-border-spacing-y:0;--tw-translate-x:0;--tw-translate-y:0;--tw-rotate:0;--tw-skew-x:0;--tw-skew-y:0;--tw-scale-x:1;--tw-scale-y:1;--tw-pan-x: ;--tw-pan-y: ;--tw-pinch-zoom: ;--tw-scroll-snap-strictness:proximity;--tw-gradient-from-position: ;--tw-gradient-via-position: ;--tw-gradient-to-position: ;--tw-ordinal: ;--tw-slashed-zero: ;--tw-numeric-figure: ;--tw-numeric-spacing: ;--tw-numeric-fraction: ;--tw-ring-inset: ;--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;--tw-ring-color:rgba(59,130,246,.5);--tw-ring-offset-shadow:0 0 #0000;--tw-ring-shadow:0 0 #0000;--tw-shadow:0 0 #0000;--tw-shadow-colored:0 0 #0000;--tw-blur: ;--tw-brightness: ;--tw-contrast: ;--tw-grayscale: ;--tw-hue-rotate: ;--tw-invert: ;--tw-saturate: ;--tw-sepia: ;--tw-drop-shadow: ;--tw-backdrop-blur: ;--tw-backdrop-brightness: ;--tw-backdrop-contrast: ;--tw-backdrop-grayscale: ;--tw-backdrop-hue-rotate: ;--tw-backdrop-invert: ;--tw-backdrop-opacity: ;--tw-backdrop-saturate: ;--tw-backdrop-sepia: ;--tw-contain-size: ;--tw-contain-layout: ;--tw-contain-paint: ;--tw-contain-style: }::backdrop{--tw-border-spacing-x:0;--tw-border-spacing-y:0;--tw-translate-x:0;--tw-translate-y:0;--tw-rotate:0;--tw-skew-x:0;--tw-skew-y:0;--tw-scale-x:1;--tw-scale-y:1;--tw-pan-x: ;--tw-pan-y: ;--tw-pinch-zoom: ;--tw-scroll-snap-strictness:proximity;--tw-gradient-from-position: ;--tw-gradient-via-position: ;--tw-gradient-to-position: ;--tw-ordinal: ;--tw-slashed-zero: ;--tw-numeric-figure: ;--tw-numeric-spacing: ;--tw-numeric-fraction: ;--tw-ring-inset: ;--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;--tw-ring-color:rgba(59,130,246,.5);--tw-ring-offset-shadow:0 0 #0000;--tw-ring-shadow:0 0 #0000;--tw-shadow:0 0 #0000;--tw-shadow-colored:0 0 #0000;--tw-blur: ;--tw-brightness: ;--tw-contrast: ;--tw-grayscale: ;--tw-hue-rotate: ;--tw-invert: ;--tw-saturate: ;--tw-sepia: ;--tw-drop-shadow: ;--tw-backdrop-blur: ;--tw-backdrop-brightness: ;--tw-backdrop-contrast: ;--tw-backdrop-grayscale: ;--tw-backdrop-hue-rotate: ;--tw-backdrop-invert: ;--tw-backdrop-opacity: ;--tw-backdrop-saturate: ;--tw-backdrop-sepia: ;--tw-contain-size: ;--tw-contain-layout: ;--tw-contain-paint: ;--tw-contain-style: }/*! tailwindcss v3.4.17 | MIT License | https://tailwindcss.com*/*,:after,:before{box-sizing:border-box;border:0 solid #e5e7eb}:after,:before{--tw-content:""}:host,html{line-height:1.5;-webkit-text-size-adjust:100%;-moz-tab-size:4;-o-tab-size:4;tab-size:4;font-family:ui-sans-serif,system-ui,sans-serif,Apple Color Emoji,Segoe UI Emoji,Segoe UI Symbol,Noto Color Emoji;font-feature-settings:normal;font-variation-settings:normal;-webkit-tap-highlight-color:transparent}body{margin:0;line-height:inherit}hr{height:0;color:inherit;border-top-width:1px}abbr:where([title]){-webkit-text-decoration:underline dotted;text-decoration:underline dotted}h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}a{color:inherit;text-decoration:inherit}b,strong{font-weight:bolder}code,kbd,pre,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace;font-feature-settings:normal;font-variation-settings:normal;font-size:1em}small{font-size:80%}sub,sup{font-size:75%;line-height:0;position:relative;vertical-align:baseline}sub{bottom:-.25em}sup{top:-.5em}table{text-indent:0;border-color:inherit;border-collapse:collapse}button,input,optgroup,select,textarea{font-family:inherit;font-feature-settings:inherit;font-variation-settings:inherit;font-size:100%;font-weight:inherit;line-height:inherit;letter-spacing:inherit;color:inherit;margin:0;padding:0}button,select{text-transform:none}button,input:where([type=button]),input:where([type=reset]),input:where([type=submit]){-webkit-appearance:button;background-color:transparent;background-image:none}:-moz-focusring{outline:auto}:-moz-ui-invalid{box-shadow:none}progress{vertical-align:baseline}::-webkit-inner-spin-button,::-webkit-outer-spin-button{height:auto}[type=search]{-webkit-appearance:textfield;outline-offset:-2px}::-webkit-search-decoration{-webkit-appearance:none}::-webkit-file-upload-button{-webkit-appearance:button;font:inherit}summary{display:list-item}blockquote,dd,dl,figure,h1,h2,h3,h4,h5,h6,hr,p,pre{margin:0}fieldset{margin:0}fieldset,legend{padding:0}menu,ol,ul{list-style:none;margin:0;padding:0}dialog{padding:0}textarea{resize:vertical}input::-moz-placeholder,textarea::-moz-placeholder{opacity:1;color:#9ca3af}input::placeholder,textarea::placeholder{opacity:1;color:#9ca3af}[role=button],button{cursor:pointer}:disabled{cursor:default}audio,canvas,embed,iframe,img,object,svg,video{display:block;vertical-align:middle}img,video{max-width:100%;height:auto}[hidden]:where(:not([hidden=until-found])){display:none}.visible{visibility:visible}.\!fixed{position:fixed!important}.fixed{position:fixed}.absolute{position:absolute}.relative{position:relative}.sticky{position:sticky}.inset-0{inset:0}.bottom-0{bottom:0}.left-4{left:1rem}.right-2{right:.5rem}.right-3{right:.75rem}.right-4{right:1rem}.top-0{top:0}.top-1{top:.25rem}.top-1\/2{top:50%}.top-3{top:.75rem}.top-4{top:1rem}.z-10{z-index:10}.z-40{z-index:40}.z-50{z-index:50}.z-\[100\]{z-index:100}.z-\[200\]{z-index:200}.z-\[70\]{z-index:70}.z-\[75\]{z-index:75}.z-\[80\]{z-index:80}.z-\[90\]{z-index:90}.m-3{margin:.75rem}.-mx-3{margin-left:-.75rem;margin-right:-.75rem}.mx-auto{margin-left:auto;margin-right:auto}.my-3{margin-top:.75rem;margin-bottom:.75rem}.mb-0{margin-bottom:0}.mb-0\.5{margin-bottom:.125rem}.mb-1{margin-bottom:.25rem}.mb-1\.5{margin-bottom:.375rem}.mb-2{margin-bottom:.5rem}.mb-24{margin-bottom:6rem}.mb-3{margin-bottom:.75rem}.mb-4{margin-bottom:1rem}.mb-5{margin-bottom:1.25rem}.mb-6{margin-bottom:1.5rem}.mb-8{margin-bottom:2rem}.ml-1{margin-left:.25rem}.ml-2{margin-left:.5rem}.ml-3{margin-left:.75rem}.ml-6{margin-left:1.5rem}.ml-8{margin-left:2rem}.ml-\[52px\]{margin-left:52px}.mr-2{margin-right:.5rem}.mt-0\.5{margin-top:.125rem}.mt-1{margin-top:.25rem}.mt-1\.5{margin-top:.375rem}.mt-10{margin-top:2.5rem}.mt-12{margin-top:3rem}.mt-2{margin-top:.5rem}.mt-3{margin-top:.75rem}.mt-4{margin-top:1rem}.mt-5{margin-top:1.25rem}.mt-6{margin-top:1.5rem}.mt-7{margin-top:1.75rem}.mt-8{margin-top:2rem}.mt-auto{margin-top:auto}.line-clamp-2{overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}.block{display:block}.inline-block{display:inline-block}.inline{display:inline}.flex{display:flex}.inline-flex{display:inline-flex}.table{display:table}.grid{display:grid}.hidden{display:none}.h-14{height:3.5rem}.h-16{height:4rem}.h-2{height:.5rem}.h-20{height:5rem}.h-28{height:7rem}.h-3\.5{height:.875rem}.h-32{height:8rem}.h-4{height:1rem}.h-40{height:10rem}.h-48{height:12rem}.h-5{height:1.25rem}.h-6{height:1.5rem}.h-64{height:16rem}.h-7{height:1.75rem}.h-8{height:2rem}.h-9{height:2.25rem}.h-\[90vh\]{height:90vh}.max-h-64{max-height:16rem}.max-h-72{max-height:18rem}.max-h-\[60vh\]{max-height:60vh}.max-h-\[85vh\]{max-height:85vh}.max-h-\[90vh\]{max-height:90vh}.max-h-\[95vh\]{max-height:95vh}.min-h-screen{min-height:100vh}.w-1\.5{width:.375rem}.w-14{width:3.5rem}.w-16{width:4rem}.w-2{width:.5rem}.w-3\.5{width:.875rem}.w-4{width:1rem}.w-5{width:1.25rem}.w-6{width:1.5rem}.w-7{width:1.75rem}.w-8{width:2rem}.w-9{width:2.25rem}.w-full{width:100%}.min-w-0{min-width:0}.max-w-2xl{max-width:42rem}.max-w-3xl{max-width:48rem}.max-w-4xl{max-width:56rem}.max-w-7xl{max-width:80rem}.max-w-\[220px\]{max-width:220px}.max-w-md{max-width:28rem}.max-w-none{max-width:none}.max-w-sm{max-width:24rem}.flex-1{flex:1 1 0%}.shrink-0{flex-shrink:0}.grow{flex-grow:1}.-translate-y-1\/2{--tw-translate-y:-50%}.-translate-y-1\/2,.transform{transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}@keyframes bounce{0%,to{transform:translateY(-25%);animation-timing-function:cubic-bezier(.8,0,1,1)}50%{transform:none;animation-timing-function:cubic-bezier(0,0,.2,1)}}.animate-bounce{animation:bounce 1s infinite}.cursor-pointer{cursor:pointer}.select-none{-webkit-user-select:none;-moz-user-select:none;user-select:none}.resize{resize:both}.grid-cols-1{grid-template-columns:repeat(1,minmax(0,1fr))}.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}.items-start{align-items:flex-start}.items-center{align-items:center}.justify-end{justify-content:flex-end}.justify-center{justify-content:center}.justify-between{justify-content:space-between}.gap-1{gap:.25rem}.gap-1\.5{gap:.375rem}.gap-2{gap:.5rem}.gap-2\.5{gap:.625rem}.gap-3{gap:.75rem}.gap-4{gap:1rem}.gap-5{gap:1.25rem}.gap-8{gap:2rem}.space-y-1>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.25rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.25rem*var(--tw-space-y-reverse))}.space-y-1\.5>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.375rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.375rem*var(--tw-space-y-reverse))}.space-y-2>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.5rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.5rem*var(--tw-space-y-reverse))}.space-y-3>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(.75rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(.75rem*var(--tw-space-y-reverse))}.space-y-4>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(1rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(1rem*var(--tw-space-y-reverse))}.space-y-5>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(1.25rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(1.25rem*var(--tw-space-y-reverse))}.space-y-6>:not([hidden])~:not([hidden]){--tw-space-y-reverse:0;margin-top:calc(1.5rem*(1 - var(--tw-space-y-reverse)));margin-bottom:calc(1.5rem*var(--tw-space-y-reverse))}.overflow-hidden{overflow:hidden}.overflow-x-auto{overflow-x:auto}.overflow-y-auto{overflow-y:auto}.truncate{overflow:hidden;text-overflow:ellipsis}.truncate,.whitespace-nowrap{white-space:nowrap}.whitespace-pre-line{white-space:pre-line}.rounded{border-radius:.25rem}.rounded-2xl{border-radius:1rem}.rounded-3xl{border-radius:1.5rem}.rounded-\[1\.75rem\]{border-radius:1.75rem}.rounded-full{border-radius:9999px}.rounded-lg{border-radius:.5rem}.rounded-md{border-radius:.375rem}.rounded-xl{border-radius:.75rem}.rounded-r-lg{border-top-right-radius:.5rem;border-bottom-right-radius:.5rem}.border{border-width:1px}.border-2{border-width:2px}.border-b{border-bottom-width:1px}.border-l-2{border-left-width:2px}.border-l-4{border-left-width:4px}.border-r{border-right-width:1px}.border-t{border-top-width:1px}.border-dashed{border-style:dashed}.border-none{border-style:none}.border-amber-200{--tw-border-opacity:1;border-color:rgb(253 230 138/var(--tw-border-opacity,1))}.border-amber-200\/80{border-color:hsla(48,97%,77%,.8)}.border-amber-300{--tw-border-opacity:1;border-color:rgb(252 211 77/var(--tw-border-opacity,1))}.border-amber-500{--tw-border-opacity:1;border-color:rgb(245 158 11/var(--tw-border-opacity,1))}.border-amber-500\/30{border-color:rgba(245,158,11,.3)}.border-amber-600\/50{border-color:rgba(217,119,6,.5)}.border-blue-400{--tw-border-opacity:1;border-color:rgb(96 165 250/var(--tw-border-opacity,1))}.border-emerald-100{--tw-border-opacity:1;border-color:rgb(209 250 229/var(--tw-border-opacity,1))}.border-emerald-500{--tw-border-opacity:1;border-color:rgb(16 185 129/var(--tw-border-opacity,1))}.border-gray-200{--tw-border-opacity:1;border-color:rgb(229 231 235/var(--tw-border-opacity,1))}.border-indigo-100{--tw-border-opacity:1;border-color:rgb(224 231 255/var(--tw-border-opacity,1))}.border-indigo-200{--tw-border-opacity:1;border-color:rgb(199 210 254/var(--tw-border-opacity,1))}.border-indigo-700\/50{border-color:rgba(67,56,202,.5)}.border-red-100{--tw-border-opacity:1;border-color:rgb(254 226 226/var(--tw-border-opacity,1))}.border-red-200{--tw-border-opacity:1;border-color:rgb(254 202 202/var(--tw-border-opacity,1))}.border-slate-100{--tw-border-opacity:1;border-color:rgb(241 245 249/var(--tw-border-opacity,1))}.border-slate-200{--tw-border-opacity:1;border-color:rgb(226 232 240/var(--tw-border-opacity,1))}.border-slate-200\/80{border-color:rgba(226,232,240,.8)}.border-slate-300{--tw-border-opacity:1;border-color:rgb(203 213 225/var(--tw-border-opacity,1))}.border-slate-50{--tw-border-opacity:1;border-color:rgb(248 250 252/var(--tw-border-opacity,1))}.border-violet-100{--tw-border-opacity:1;border-color:rgb(237 233 254/var(--tw-border-opacity,1))}.border-violet-200{--tw-border-opacity:1;border-color:rgb(221 214 254/var(--tw-border-opacity,1))}.border-yellow-200{--tw-border-opacity:1;border-color:rgb(254 240 138/var(--tw-border-opacity,1))}.bg-\[\#f6f7fb\]{--tw-bg-opacity:1;background-color:rgb(246 247 251/var(--tw-bg-opacity,1))}.bg-amber-100{--tw-bg-opacity:1;background-color:rgb(254 243 199/var(--tw-bg-opacity,1))}.bg-amber-50{--tw-bg-opacity:1;background-color:rgb(255 251 235/var(--tw-bg-opacity,1))}.bg-amber-500{--tw-bg-opacity:1;background-color:rgb(245 158 11/var(--tw-bg-opacity,1))}.bg-amber-600{--tw-bg-opacity:1;background-color:rgb(217 119 6/var(--tw-bg-opacity,1))}.bg-amber-900\/60{background-color:rgba(120,53,15,.6)}.bg-black{--tw-bg-opacity:1;background-color:rgb(0 0 0/var(--tw-bg-opacity,1))}.bg-blue-50{--tw-bg-opacity:1;background-color:rgb(239 246 255/var(--tw-bg-opacity,1))}.bg-blue-600{--tw-bg-opacity:1;background-color:rgb(37 99 235/var(--tw-bg-opacity,1))}.bg-emerald-100{--tw-bg-opacity:1;background-color:rgb(209 250 229/var(--tw-bg-opacity,1))}.bg-emerald-50{--tw-bg-opacity:1;background-color:rgb(236 253 245/var(--tw-bg-opacity,1))}.bg-emerald-50\/70{background-color:rgba(236,253,245,.7)}.bg-emerald-500{--tw-bg-opacity:1;background-color:rgb(16 185 129/var(--tw-bg-opacity,1))}.bg-emerald-600{--tw-bg-opacity:1;background-color:rgb(5 150 105/var(--tw-bg-opacity,1))}.bg-gray-100{--tw-bg-opacity:1;background-color:rgb(243 244 246/var(--tw-bg-opacity,1))}.bg-gray-300{--tw-bg-opacity:1;background-color:rgb(209 213 219/var(--tw-bg-opacity,1))}.bg-gray-50{--tw-bg-opacity:1;background-color:rgb(249 250 251/var(--tw-bg-opacity,1))}.bg-green-100{--tw-bg-opacity:1;background-color:rgb(220 252 231/var(--tw-bg-opacity,1))}.bg-indigo-100{--tw-bg-opacity:1;background-color:rgb(224 231 255/var(--tw-bg-opacity,1))}.bg-indigo-100\/50{background-color:rgba(224,231,255,.5)}.bg-indigo-50{--tw-bg-opacity:1;background-color:rgb(238 242 255/var(--tw-bg-opacity,1))}.bg-indigo-50\/50{background-color:rgba(238,242,255,.5)}.bg-indigo-600{--tw-bg-opacity:1;background-color:rgb(79 70 229/var(--tw-bg-opacity,1))}.bg-indigo-900{--tw-bg-opacity:1;background-color:rgb(49 46 129/var(--tw-bg-opacity,1))}.bg-indigo-900\/80{background-color:rgba(49,46,129,.8)}.bg-indigo-950{--tw-bg-opacity:1;background-color:rgb(30 27 75/var(--tw-bg-opacity,1))}.bg-indigo-950\/95{background-color:rgba(30,27,75,.95)}.bg-red-400{--tw-bg-opacity:1;background-color:rgb(248 113 113/var(--tw-bg-opacity,1))}.bg-red-50{--tw-bg-opacity:1;background-color:rgb(254 242 242/var(--tw-bg-opacity,1))}.bg-rose-50{--tw-bg-opacity:1;background-color:rgb(255 241 242/var(--tw-bg-opacity,1))}.bg-rose-500{--tw-bg-opacity:1;background-color:rgb(244 63 94/var(--tw-bg-opacity,1))}.bg-slate-100{--tw-bg-opacity:1;background-color:rgb(241 245 249/var(--tw-bg-opacity,1))}.bg-slate-200{--tw-bg-opacity:1;background-color:rgb(226 232 240/var(--tw-bg-opacity,1))}.bg-slate-50{--tw-bg-opacity:1;background-color:rgb(248 250 252/var(--tw-bg-opacity,1))}.bg-slate-50\/50{background-color:rgba(248,250,252,.5)}.bg-slate-800{--tw-bg-opacity:1;background-color:rgb(30 41 59/var(--tw-bg-opacity,1))}.bg-slate-900\/60{background-color:rgba(15,23,42,.6)}.bg-slate-900\/90{background-color:rgba(15,23,42,.9)}.bg-slate-900\/95{background-color:rgba(15,23,42,.95)}.bg-transparent{background-color:transparent}.bg-violet-100{--tw-bg-opacity:1;background-color:rgb(237 233 254/var(--tw-bg-opacity,1))}.bg-violet-50{--tw-bg-opacity:1;background-color:rgb(245 243 255/var(--tw-bg-opacity,1))}.bg-violet-500{--tw-bg-opacity:1;background-color:rgb(139 92 246/var(--tw-bg-opacity,1))}.bg-violet-600{--tw-bg-opacity:1;background-color:rgb(124 58 237/var(--tw-bg-opacity,1))}.bg-white{--tw-bg-opacity:1;background-color:rgb(255 255 255/var(--tw-bg-opacity,1))}.bg-white\/80{background-color:hsla(0,0%,100%,.8)}.bg-white\/90{background-color:hsla(0,0%,100%,.9)}.bg-white\/95{background-color:hsla(0,0%,100%,.95)}.bg-yellow-50{--tw-bg-opacity:1;background-color:rgb(254 252 232/var(--tw-bg-opacity,1))}.bg-gradient-to-br{background-image:linear-gradient(to bottom right,var(--tw-gradient-stops))}.bg-gradient-to-r{background-image:linear-gradient(to right,var(--tw-gradient-stops))}.bg-gradient-to-t{background-image:linear-gradient(to top,var(--tw-gradient-stops))}.from-amber-50{--tw-gradient-from:#fffbeb var(--tw-gradient-from-position);--tw-gradient-to:rgba(255,251,235,0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)}.from-indigo-600{--tw-gradient-from:#4f46e5 var(--tw-gradient-from-position);--tw-gradient-to:rgba(79,70,229,0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)}.from-slate-900{--tw-gradient-from:#0f172a var(--tw-gradient-from-position);--tw-gradient-to:rgba(15,23,42,0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)}.from-violet-500{--tw-gradient-from:#8b5cf6 var(--tw-gradient-from-position);--tw-gradient-to:rgba(139,92,246,0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)}.from-violet-600{--tw-gradient-from:#7c3aed var(--tw-gradient-from-position);--tw-gradient-to:rgba(124,58,237,0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)}.from-white{--tw-gradient-from:#fff var(--tw-gradient-from-position);--tw-gradient-to:hsla(0,0%,100%,0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)}.via-indigo-950{--tw-gradient-to:rgba(30,27,75,0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),#1e1b4b var(--tw-gradient-via-position),var(--tw-gradient-to)}.via-white{--tw-gradient-to:hsla(0,0%,100%,0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),#fff var(--tw-gradient-via-position),var(--tw-gradient-to)}.to-indigo-600{--tw-gradient-to:#4f46e5 var(--tw-gradient-to-position)}.to-indigo-950{--tw-gradient-to:#1e1b4b var(--tw-gradient-to-position)}.to-orange-50{--tw-gradient-to:#fff7ed var(--tw-gradient-to-position)}.to-slate-900{--tw-gradient-to:#0f172a var(--tw-gradient-to-position)}.to-transparent{--tw-gradient-to:transparent var(--tw-gradient-to-position)}.to-violet-600{--tw-gradient-to:#7c3aed var(--tw-gradient-to-position)}.to-yellow-100{--tw-gradient-to:#fef9c3 var(--tw-gradient-to-position)}.p-0\.5{padding:.125rem}.p-1{padding:.25rem}.p-2{padding:.5rem}.p-3{padding:.75rem}.p-4{padding:1rem}.p-5{padding:1.25rem}.p-6{padding:1.5rem}.p-8{padding:2rem}.p-\[6px\]{padding:6px}.px-1{padding-left:.25rem;padding-right:.25rem}.px-1\.5{padding-left:.375rem;padding-right:.375rem}.px-10{padding-left:2.5rem;padding-right:2.5rem}.px-2{padding-left:.5rem;padding-right:.5rem}.px-2\.5{padding-left:.625rem;padding-right:.625rem}.px-3{padding-left:.75rem;padding-right:.75rem}.px-3\.5{padding-left:.875rem;padding-right:.875rem}.px-4{padding-left:1rem;padding-right:1rem}.px-5{padding-left:1.25rem;padding-right:1.25rem}.px-6{padding-left:1.5rem;padding-right:1.5rem}.px-8{padding-left:2rem;padding-right:2rem}.py-0\.5{padding-top:.125rem;padding-bottom:.125rem}.py-1{padding-top:.25rem;padding-bottom:.25rem}.py-1\.5{padding-top:.375rem;padding-bottom:.375rem}.py-10{padding-top:2.5rem;padding-bottom:2.5rem}.py-12{padding-top:3rem;padding-bottom:3rem}.py-16{padding-top:4rem;padding-bottom:4rem}.py-2{padding-top:.5rem;padding-bottom:.5rem}.py-2\.5{padding-top:.625rem;padding-bottom:.625rem}.py-20{padding-top:5rem;padding-bottom:5rem}.py-24{padding-top:6rem;padding-bottom:6rem}.py-3{padding-top:.75rem;padding-bottom:.75rem}.py-3\.5{padding-top:.875rem;padding-bottom:.875rem}.py-4{padding-top:1rem;padding-bottom:1rem}.py-6{padding-top:1.5rem;padding-bottom:1.5rem}.py-8{padding-top:2rem;padding-bottom:2rem}.pb-2{padding-bottom:.5rem}.pb-20{padding-bottom:5rem}.pb-3{padding-bottom:.75rem}.pb-32{padding-bottom:8rem}.pb-4{padding-bottom:1rem}.pl-11{padding-left:2.75rem}.pl-2{padding-left:.5rem}.pr-1{padding-right:.25rem}.pr-2{padding-right:.5rem}.pr-4{padding-right:1rem}.pr-8{padding-right:2rem}.pt-10{padding-top:2.5rem}.pt-3{padding-top:.75rem}.pt-4{padding-top:1rem}.pt-5{padding-top:1.25rem}.pt-8{padding-top:2rem}.text-left{text-align:left}.text-center{text-align:center}.align-middle{vertical-align:middle}.font-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,Liberation Mono,Courier New,monospace}.text-2xl{font-size:1.5rem;line-height:2rem}.text-3xl{font-size:1.875rem;line-height:2.25rem}.text-4xl{font-size:2.25rem;line-height:2.5rem}.text-5xl{font-size:3rem;line-height:1}.text-\[1\.05rem\]{font-size:1.05rem}.text-\[10px\]{font-size:10px}.text-\[11px\]{font-size:11px}.text-\[13px\]{font-size:13px}.text-\[15px\]{font-size:15px}.text-\[2rem\]{font-size:2rem}.text-\[9px\]{font-size:9px}.text-base{font-size:1rem;line-height:1.5rem}.text-lg{font-size:1.125rem;line-height:1.75rem}.text-sm{font-size:.875rem;line-height:1.25rem}.text-xl{font-size:1.25rem;line-height:1.75rem}.text-xs{font-size:.75rem;line-height:1rem}.font-black{font-weight:900}.font-bold{font-weight:700}.font-medium{font-weight:500}.font-normal{font-weight:400}.font-semibold{font-weight:600}.uppercase{text-transform:uppercase}.italic{font-style:italic}.leading-none{line-height:1}.leading-relaxed{line-height:1.625}.leading-snug{line-height:1.375}.leading-tight{line-height:1.25}.tracking-tight{letter-spacing:-.025em}.tracking-wider{letter-spacing:.05em}.tracking-widest{letter-spacing:.1em}.text-amber-200{--tw-text-opacity:1;color:rgb(253 230 138/var(--tw-text-opacity,1))}.text-amber-500{--tw-text-opacity:1;color:rgb(245 158 11/var(--tw-text-opacity,1))}.text-amber-600{--tw-text-opacity:1;color:rgb(217 119 6/var(--tw-text-opacity,1))}.text-amber-700{--tw-text-opacity:1;color:rgb(180 83 9/var(--tw-text-opacity,1))}.text-amber-800{--tw-text-opacity:1;color:rgb(146 64 14/var(--tw-text-opacity,1))}.text-amber-900{--tw-text-opacity:1;color:rgb(120 53 15/var(--tw-text-opacity,1))}.text-emerald-600{--tw-text-opacity:1;color:rgb(5 150 105/var(--tw-text-opacity,1))}.text-emerald-700{--tw-text-opacity:1;color:rgb(4 120 87/var(--tw-text-opacity,1))}.text-gray-400{--tw-text-opacity:1;color:rgb(156 163 175/var(--tw-text-opacity,1))}.text-gray-500{--tw-text-opacity:1;color:rgb(107 114 128/var(--tw-text-opacity,1))}.text-gray-600{--tw-text-opacity:1;color:rgb(75 85 99/var(--tw-text-opacity,1))}.text-green-700{--tw-text-opacity:1;color:rgb(21 128 61/var(--tw-text-opacity,1))}.text-indigo-100{--tw-text-opacity:1;color:rgb(224 231 255/var(--tw-text-opacity,1))}.text-indigo-200{--tw-text-opacity:1;color:rgb(199 210 254/var(--tw-text-opacity,1))}.text-indigo-300{--tw-text-opacity:1;color:rgb(165 180 252/var(--tw-text-opacity,1))}.text-indigo-300\/80{color:rgba(165,180,252,.8)}.text-indigo-400{--tw-text-opacity:1;color:rgb(129 140 248/var(--tw-text-opacity,1))}.text-indigo-50{--tw-text-opacity:1;color:rgb(238 242 255/var(--tw-text-opacity,1))}.text-indigo-500{--tw-text-opacity:1;color:rgb(99 102 241/var(--tw-text-opacity,1))}.text-indigo-600{--tw-text-opacity:1;color:rgb(79 70 229/var(--tw-text-opacity,1))}.text-indigo-700{--tw-text-opacity:1;color:rgb(67 56 202/var(--tw-text-opacity,1))}.text-indigo-800{--tw-text-opacity:1;color:rgb(55 48 163/var(--tw-text-opacity,1))}.text-indigo-900{--tw-text-opacity:1;color:rgb(49 46 129/var(--tw-text-opacity,1))}.text-indigo-950{--tw-text-opacity:1;color:rgb(30 27 75/var(--tw-text-opacity,1))}.text-red-400{--tw-text-opacity:1;color:rgb(248 113 113/var(--tw-text-opacity,1))}.text-red-500{--tw-text-opacity:1;color:rgb(239 68 68/var(--tw-text-opacity,1))}.text-red-600{--tw-text-opacity:1;color:rgb(220 38 38/var(--tw-text-opacity,1))}.text-rose-500{--tw-text-opacity:1;color:rgb(244 63 94/var(--tw-text-opacity,1))}.text-rose-600{--tw-text-opacity:1;color:rgb(225 29 72/var(--tw-text-opacity,1))}.text-slate-300{--tw-text-opacity:1;color:rgb(203 213 225/var(--tw-text-opacity,1))}.text-slate-400{--tw-text-opacity:1;color:rgb(148 163 184/var(--tw-text-opacity,1))}.text-slate-500{--tw-text-opacity:1;color:rgb(100 116 139/var(--tw-text-opacity,1))}.text-slate-600{--tw-text-opacity:1;color:rgb(71 85 105/var(--tw-text-opacity,1))}.text-slate-700{--tw-text-opacity:1;color:rgb(51 65 85/var(--tw-text-opacity,1))}.text-slate-800{--tw-text-opacity:1;color:rgb(30 41 59/var(--tw-text-opacity,1))}.text-slate-900{--tw-text-opacity:1;color:rgb(15 23 42/var(--tw-text-opacity,1))}.text-violet-400{--tw-text-opacity:1;color:rgb(167 139 250/var(--tw-text-opacity,1))}.text-violet-500{--tw-text-opacity:1;color:rgb(139 92 246/var(--tw-text-opacity,1))}.text-violet-600{--tw-text-opacity:1;color:rgb(124 58 237/var(--tw-text-opacity,1))}.text-violet-700{--tw-text-opacity:1;color:rgb(109 40 217/var(--tw-text-opacity,1))}.text-white{--tw-text-opacity:1;color:rgb(255 255 255/var(--tw-text-opacity,1))}.underline{text-decoration-line:underline}.no-underline{text-decoration-line:none}.accent-violet-600{accent-color:#7c3aed}.opacity-70{opacity:.7}.shadow{--tw-shadow:0 1px 3px 0 rgba(0,0,0,.1),0 1px 2px -1px rgba(0,0,0,.1);--tw-shadow-colored:0 1px 3px 0 var(--tw-shadow-color),0 1px 2px -1px var(--tw-shadow-color)}.shadow,.shadow-2xl{box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.shadow-2xl{--tw-shadow:0 25px 50px -12px rgba(0,0,0,.25);--tw-shadow-colored:0 25px 50px -12px var(--tw-shadow-color)}.shadow-lg{--tw-shadow:0 10px 15px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1);--tw-shadow-colored:0 10px 15px -3px var(--tw-shadow-color),0 4px 6px -4px var(--tw-shadow-color)}.shadow-lg,.shadow-md{box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.shadow-md{--tw-shadow:0 4px 6px -1px rgba(0,0,0,.1),0 2px 4px -2px rgba(0,0,0,.1);--tw-shadow-colored:0 4px 6px -1px var(--tw-shadow-color),0 2px 4px -2px var(--tw-shadow-color)}.shadow-sm{--tw-shadow:0 1px 2px 0 rgba(0,0,0,.05);--tw-shadow-colored:0 1px 2px 0 var(--tw-shadow-color)}.shadow-sm,.shadow-xl{box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.shadow-xl{--tw-shadow:0 20px 25px -5px rgba(0,0,0,.1),0 8px 10px -6px rgba(0,0,0,.1);--tw-shadow-colored:0 20px 25px -5px var(--tw-shadow-color),0 8px 10px -6px var(--tw-shadow-color)}.shadow-emerald-200{--tw-shadow-color:#a7f3d0;--tw-shadow:var(--tw-shadow-colored)}.shadow-violet-200{--tw-shadow-color:#ddd6fe;--tw-shadow:var(--tw-shadow-colored)}.outline-none{outline:2px solid transparent;outline-offset:2px}.outline{outline-style:solid}.grayscale{--tw-grayscale:grayscale(100%)}.filter,.grayscale{filter:var(--tw-blur) var(--tw-brightness) var(--tw-contrast) var(--tw-grayscale) var(--tw-hue-rotate) var(--tw-invert) var(--tw-saturate) var(--tw-sepia) var(--tw-drop-shadow)}.backdrop-blur{--tw-backdrop-blur:blur(8px);-webkit-backdrop-filter:var(--tw-backdrop-blur) var(--tw-backdrop-brightness) var(--tw-backdrop-contrast) var(--tw-backdrop-grayscale) var(--tw-backdrop-hue-rotate) var(--tw-backdrop-invert) var(--tw-backdrop-opacity) var(--tw-backdrop-saturate) var(--tw-backdrop-sepia);backdrop-filter:var(--tw-backdrop-blur) var(--tw-backdrop-brightness) var(--tw-backdrop-contrast) var(--tw-backdrop-grayscale) var(--tw-backdrop-hue-rotate) var(--tw-backdrop-invert) var(--tw-backdrop-opacity) var(--tw-backdrop-saturate) var(--tw-backdrop-sepia)}.transition{transition-property:color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,-webkit-backdrop-filter;transition-property:color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,backdrop-filter;transition-property:color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,backdrop-filter,-webkit-backdrop-filter;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:.15s}.transition-all{transition-property:all;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:.15s}.ease-in-out{transition-timing-function:cubic-bezier(.4,0,.2,1)}.placeholder\:text-slate-400::-moz-placeholder{--tw-text-opacity:1;color:rgb(148 163 184/var(--tw-text-opacity,1))}.placeholder\:text-slate-400::placeholder{--tw-text-opacity:1;color:rgb(148 163 184/var(--tw-text-opacity,1))}.hover\:-translate-y-0\.5:hover{--tw-translate-y:-0.125rem;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.hover\:border-indigo-400:hover{--tw-border-opacity:1;border-color:rgb(129 140 248/var(--tw-border-opacity,1))}.hover\:bg-amber-100:hover{--tw-bg-opacity:1;background-color:rgb(254 243 199/var(--tw-bg-opacity,1))}.hover\:bg-amber-200:hover{--tw-bg-opacity:1;background-color:rgb(253 230 138/var(--tw-bg-opacity,1))}.hover\:bg-amber-700:hover{--tw-bg-opacity:1;background-color:rgb(180 83 9/var(--tw-bg-opacity,1))}.hover\:bg-emerald-200:hover{--tw-bg-opacity:1;background-color:rgb(167 243 208/var(--tw-bg-opacity,1))}.hover\:bg-emerald-700:hover{--tw-bg-opacity:1;background-color:rgb(4 120 87/var(--tw-bg-opacity,1))}.hover\:bg-indigo-100:hover{--tw-bg-opacity:1;background-color:rgb(224 231 255/var(--tw-bg-opacity,1))}.hover\:bg-indigo-50:hover{--tw-bg-opacity:1;background-color:rgb(238 242 255/var(--tw-bg-opacity,1))}.hover\:bg-indigo-700:hover{--tw-bg-opacity:1;background-color:rgb(67 56 202/var(--tw-bg-opacity,1))}.hover\:bg-indigo-800:hover{--tw-bg-opacity:1;background-color:rgb(55 48 163/var(--tw-bg-opacity,1))}.hover\:bg-slate-100:hover{--tw-bg-opacity:1;background-color:rgb(241 245 249/var(--tw-bg-opacity,1))}.hover\:bg-slate-200:hover{--tw-bg-opacity:1;background-color:rgb(226 232 240/var(--tw-bg-opacity,1))}.hover\:bg-slate-300:hover{--tw-bg-opacity:1;background-color:rgb(203 213 225/var(--tw-bg-opacity,1))}.hover\:bg-slate-700:hover{--tw-bg-opacity:1;background-color:rgb(51 65 85/var(--tw-bg-opacity,1))}.hover\:bg-slate-900:hover{--tw-bg-opacity:1;background-color:rgb(15 23 42/var(--tw-bg-opacity,1))}.hover\:bg-violet-200:hover{--tw-bg-opacity:1;background-color:rgb(221 214 254/var(--tw-bg-opacity,1))}.hover\:bg-violet-50:hover{--tw-bg-opacity:1;background-color:rgb(245 243 255/var(--tw-bg-opacity,1))}.hover\:text-amber-700:hover{--tw-text-opacity:1;color:rgb(180 83 9/var(--tw-text-opacity,1))}.hover\:text-emerald-600:hover{--tw-text-opacity:1;color:rgb(5 150 105/var(--tw-text-opacity,1))}.hover\:text-indigo-600:hover{--tw-text-opacity:1;color:rgb(79 70 229/var(--tw-text-opacity,1))}.hover\:text-indigo-800:hover{--tw-text-opacity:1;color:rgb(55 48 163/var(--tw-text-opacity,1))}.hover\:text-red-500:hover{--tw-text-opacity:1;color:rgb(239 68 68/var(--tw-text-opacity,1))}.hover\:text-red-600:hover{--tw-text-opacity:1;color:rgb(220 38 38/var(--tw-text-opacity,1))}.hover\:text-slate-600:hover{--tw-text-opacity:1;color:rgb(71 85 105/var(--tw-text-opacity,1))}.hover\:text-slate-700:hover{--tw-text-opacity:1;color:rgb(51 65 85/var(--tw-text-opacity,1))}.hover\:text-violet-500:hover{--tw-text-opacity:1;color:rgb(139 92 246/var(--tw-text-opacity,1))}.hover\:text-violet-600:hover{--tw-text-opacity:1;color:rgb(124 58 237/var(--tw-text-opacity,1))}.hover\:text-white:hover{--tw-text-opacity:1;color:rgb(255 255 255/var(--tw-text-opacity,1))}.hover\:underline:hover{text-decoration-line:underline}.hover\:opacity-95:hover{opacity:.95}.hover\:shadow-lg:hover{--tw-shadow:0 10px 15px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1);--tw-shadow-colored:0 10px 15px -3px var(--tw-shadow-color),0 4px 6px -4px var(--tw-shadow-color)}.hover\:shadow-lg:hover,.hover\:shadow-md:hover{box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.hover\:shadow-md:hover{--tw-shadow:0 4px 6px -1px rgba(0,0,0,.1),0 2px 4px -2px rgba(0,0,0,.1);--tw-shadow-colored:0 4px 6px -1px var(--tw-shadow-color),0 2px 4px -2px var(--tw-shadow-color)}.hover\:shadow-xl:hover{--tw-shadow:0 20px 25px -5px rgba(0,0,0,.1),0 8px 10px -6px rgba(0,0,0,.1);--tw-shadow-colored:0 20px 25px -5px var(--tw-shadow-color),0 8px 10px -6px var(--tw-shadow-color);box-shadow:var(--tw-ring-offset-shadow,0 0 #0000),var(--tw-ring-shadow,0 0 #0000),var(--tw-shadow)}.focus\:border-indigo-400:focus{--tw-border-opacity:1;border-color:rgb(129 140 248/var(--tw-border-opacity,1))}.focus\:border-violet-300:focus{--tw-border-opacity:1;border-color:rgb(196 181 253/var(--tw-border-opacity,1))}.focus\:ring-2:focus{--tw-ring-offset-shadow:var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);--tw-ring-shadow:var(--tw-ring-inset) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color);box-shadow:var(--tw-ring-offset-shadow),var(--tw-ring-shadow),var(--tw-shadow,0 0 #0000)}.focus\:ring-violet-200:focus{--tw-ring-opacity:1;--tw-ring-color:rgb(221 214 254/var(--tw-ring-opacity,1))}.active\:scale-95:active{--tw-scale-x:.95;--tw-scale-y:.95}.active\:scale-95:active,.active\:scale-\[\.98\]:active{transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.active\:scale-\[\.98\]:active{--tw-scale-x:.98;--tw-scale-y:.98}.active\:scale-\[\.99\]:active{--tw-scale-x:.99;--tw-scale-y:.99;transform:translate(var(--tw-translate-x),var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y))}.disabled\:opacity-40:disabled{opacity:.4}.group:hover .group-hover\:text-violet-700{--tw-text-opacity:1;color:rgb(109 40 217/var(--tw-text-opacity,1))}@media (min-width:640px){.sm\:ml-5{margin-left:1.25rem}.sm\:p-4{padding:1rem}.sm\:pl-3{padding-left:.75rem}}@media (min-width:768px){.md\:-mx-6{margin-left:-1.5rem;margin-right:-1.5rem}.md\:ml-4{margin-left:1rem}.md\:ml-5{margin-left:1.25rem}.md\:flex{display:flex}.md\:hidden{display:none}.md\:w-1\/3{width:33.333333%}.md\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.md\:grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.md\:grid-cols-5{grid-template-columns:repeat(5,minmax(0,1fr))}.md\:flex-row{flex-direction:row}.md\:p-8{padding:2rem}.md\:px-6{padding-left:1.5rem;padding-right:1.5rem}.md\:text-2xl{font-size:1.5rem;line-height:2rem}}@media (min-width:1024px){.lg\:grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.lg\:grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}}@media print{.print\:hidden{display:none}}
</style>
    <script defer src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
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
        #pwaInstallFab { position: fixed; left: 0.5rem; bottom: 1.25rem; z-index: 100; }
        #pwaInstallBtn { height: 2.6rem; padding: 0 1rem; border-radius: 9999px; background: linear-gradient(135deg,#8b5cf6,#6366f1); color: #fff; font-weight: 900; font-size: .85rem; box-shadow: 0 6px 20px rgba(139,92,246,.45); border: 2px solid #fff; cursor: pointer; }
        #pwaInstallBtn:active { transform: scale(.94); }
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
    <script>window.__BOOT__ = { shareMode: ${isShareMode}, isAdmin: ${isAdmin}, adminAuthed: ${adminAuthed}, list: ${bootJson}, paths: ${bootPathsJson}, categories: ${bootCategoriesJson} };</script>

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
            <h2 id="pwModalTitle" class="font-black text-lg mb-5">🔑 修改管理密码</h2>
            <input id="pw_old" type="password" placeholder="原密码" class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-3">
            <input id="pw_new" type="password" placeholder="新密码（至少 6 位）" class="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-400 mb-5">
            <div class="flex gap-3">
                <button onclick="doChangePassword()" class="flex-1 bg-indigo-900 text-white py-3 rounded-2xl font-bold">确认修改</button>
                <button id="pwCancelBtn" onclick="toggleModal('pwModal')" class="bg-slate-200 text-slate-600 px-6 py-3 rounded-2xl font-bold">取消</button>
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
            <p id="adminInitHint" class="hidden text-amber-600 text-xs mb-2">⚠️ <span data-i18n="initPwT">初始密码（仅显示一次）</span>：<b id="adminInitPw" class="select-all"></b><br><span class="text-slate-400" data-i18n="initPwD">请登录后立即修改管理密码</span></p>
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
            if (L === 'en' || L === 'ja' || L === 'ko') {
                // 主路径：catInfo
                if (catInfo[cat] && catInfo[cat].i18n && catInfo[cat].i18n[L] && catInfo[cat].i18n[L].description) {
                    return catInfo[cat].i18n[L].description;
                }
                // 备用：直接从 BOOT.categories 查（绕过 catInfo 构建可能的问题）
                try {
                    var bcs = (typeof BOOT !== 'undefined' && BOOT.categories) ? BOOT.categories : [];
                    for (var i = 0; i < bcs.length; i++) {
                        if (bcs[i].name === cat && bcs[i].i18n && bcs[i].i18n[L] && bcs[i].i18n[L].description) {
                            return bcs[i].i18n[L].description;
                        }
                    }
                } catch (e) {}
                // 回退中文
                if (catInfo[cat]) return catInfo[cat].description;
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
            if (L === 'en' || L === 'ja' || L === 'ko') {
                if (catInfo[cat] && catInfo[cat].subI18n && catInfo[cat].subI18n[sub] && catInfo[cat].subI18n[sub][L] && catInfo[cat].subI18n[sub][L].description) {
                    return catInfo[cat].subI18n[sub][L].description;
                }
                try {
                    var bcs = (typeof BOOT !== 'undefined' && BOOT.categories) ? BOOT.categories : [];
                    for (var i = 0; i < bcs.length; i++) {
                        if (bcs[i].name === cat && bcs[i].subs) {
                            for (var j = 0; j < bcs[i].subs.length; j++) {
                                var s = bcs[i].subs[j];
                                if (s.name === sub && s.i18n && s.i18n[L] && s.i18n[L].description) {
                                    return s.i18n[L].description;
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
            return (catInfo[cat] && catInfo[cat].subDesc) ? (catInfo[cat].subDesc[sub] || "") : "";
        }
        /* 全局暴露：供外层 applyI18n() 调用，重刷分类简介语言（防御冷加载时序问题） */
        window.refreshCatDescs = function(force) {
            try {
                var L = curLang();
                var needEn = (L === 'en' || L === 'ja' || L === 'ko');
                document.querySelectorAll('[data-catdesc]').forEach(function(el) {
                    var c = el.getAttribute('data-catdesc');
                    var t = catDescL(c);
                    el.innerHTML = hlVerse(esc(stripMd(t)));
                    el.style.display = t ? '' : 'none';
                });
                document.querySelectorAll('[data-subdesc]').forEach(function(el) {
                    var c = el.getAttribute('data-catdesc2'), s = el.getAttribute('data-subdesc');
                    var t = subDescL(c, s);
                    el.innerHTML = hlVerse(esc(stripMd(t)));
                    el.style.display = t ? '' : 'none';
                });
                /* 终极防御：如果当前是英日韩但简介仍含中文，说明 catInfo 的 i18n 缺失，直接重拉接口（最多一次） */
                if (needEn && !force) {
                    var hasChinese = false;
                    document.querySelectorAll('[data-catdesc],[data-subdesc]').forEach(function(el) {
                        if (/[\u4e00-\u9fff]/.test(el.textContent)) hasChinese = true;
                    });
                    if (hasChinese) {
                        fetch('/api/categories?_=' + Date.now()).then(function(r) { return r.json(); }).then(function(cj) {
                            if (!Array.isArray(cj)) return;
                            var newInfo = {};
                            cj.forEach(function(s) {
                                var sd = {}, sdI18n = {};
                                (s.subs || []).forEach(function(x) { sd[x.name] = x.description || ""; if (x.i18n) sdI18n[x.name] = x.i18n; });
                                newInfo[s.name] = { description: s.description || "", subDesc: sd, i18n: s.i18n || null, subI18n: sdI18n };
                            });
                            catInfo = newInfo;
                            window.refreshCatDescs(true);
                        }).catch(function() {});
                    }
                }
            } catch (e) {}
        };
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
doing: '处理中…', opFail: '操作失败，请重试', netErr: '网络错误，请重试', retry: '🔄 重试',
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
wbEmptyAlert: '错题本是空的', popupBlocked: '浏览器阻止了新窗口，请允许弹窗后重试', adminPwEmpty: '请输入管理密码', initPwT: '初始密码（仅显示一次）', initPwD: '请登录后立即修改管理密码', pwMustChangeT: '请先修改初始密码', pwChangeT: '修改管理密码', pwChanged: '密码修改成功', loginLocked: '尝试次数过多，请10分钟后再试', installApp: '📲 安装应用'
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
netErr: 'Network error. Please retry.', retry: '🔄 Retry',
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
wbEmptyAlert: 'The mistake book is empty', popupBlocked: 'Popup blocked. Please allow popups and retry.', adminPwEmpty: 'Please enter the admin password', initPwT: 'Initial password (shown once)', initPwD: 'Please change the admin password right after login', pwMustChangeT: 'Please change the initial password first', pwChangeT: 'Change admin password', pwChanged: 'Password changed', loginLocked: 'Too many attempts. Please try again in 10 minutes.', installApp: '📲 Install App'
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
netErr: 'ネットワークエラー。再試行してください。', retry: '🔄 再試行',
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
wbEmptyAlert: '間違いノートは空です', popupBlocked: 'ポップアップがブロックされました。許可して再試行してください。', adminPwEmpty: '管理パスワードを入力してください', initPwT: '初期パスワード（1回のみ表示）', initPwD: 'ログイン後すぐに管理パスワードを変更してください', pwMustChangeT: '初期パスワードを先に変更してください', pwChangeT: '管理パスワードの変更', pwChanged: 'パスワードを変更しました', loginLocked: '試行回数が多すぎます。10分後にもう一度お試しください。', installApp: '📲 アプリをインストール'
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
netErr: '네트워크 오류. 다시 시도해 주세요.', retry: '🔄 다시 시도',
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
wbEmptyAlert: '오답노트가 비어 있습니다', popupBlocked: '팝업이 차단되었습니다. 팝업을 허용하고 다시 시도해 주세요.', adminPwEmpty: '관리자 비밀번호를 입력하세요', initPwT: '초기 비밀번호 (1회만 표시)', initPwD: '로그인 후 즉시 관리자 비밀번호를 변경하세요', pwMustChangeT: '초기 비밀번호를 먼저 변경하세요', pwChangeT: '관리자 비밀번호 변경', pwChanged: '비밀번호가 변경되었습니다', loginLocked: '시도 횟수가 너무 많습니다. 10분 후에 다시 시도하세요.', installApp: '📲 앱 설치'
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
        /* 分类简介跟随语言重刷（防御：冷加载时序问题可能导致简介停留在默认语言） */
        try { if (typeof window.refreshCatDescs === 'function') window.refreshCatDescs(); } catch (e) {}
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
                // 替换 q/s/a，保留 id 等；o 字段：经文出处不翻译（保持原文用于 bible_verses 查询），
                // 但 single/multiple 的 o 是选项，需要用翻译
                for (var i = 0; i < qs.length; i++) {
                    if (d.quizzes[i].q) qs[i].q = d.quizzes[i].q;
                    if (d.quizzes[i].s) qs[i].s = d.quizzes[i].s;
                    if (d.quizzes[i].a) qs[i].a = d.quizzes[i].a;
                    if (d.quizzes[i].o && (qs[i].type === 'single' || qs[i].type === 'multiple')) qs[i].o = d.quizzes[i].o;
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
            /* 分类数据优先用服务端内联的 BOOT.categories（绕过接口缓存问题），无内联时才调接口 */
            var catP = (BOOT.categories && BOOT.categories.length)
                ? Promise.resolve(BOOT.categories)
                : fetch('/api/categories').then(function(r) { return r.json(); }).catch(function() { return []; });
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
                try { if (typeof checkInitHint === 'function') checkInitHint(); } catch (e) {}
                try { if (typeof enforcePwChange === 'function') enforcePwChange(); } catch (e) {}
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
                            + (subDescL(cat, sk) ? '<p class="text-xs text-slate-500 mb-3 ml-6 leading-relaxed" data-catdesc2="' + esc(cat) + '" data-subdesc="' + esc(sk) + '">' + hlVerse(esc(stripMd(subDescL(cat, sk)))) + '</p>' : '')
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
                    + (catDescL(cat) ? '<p class="text-sm text-slate-500 mt-2 ml-[52px] leading-relaxed" data-catdesc="' + esc(cat) + '">' + hlVerse(esc(stripMd(catDescL(cat)))) + '</p>' : '')
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
        function retryLesson(btn) { startLesson(btn.dataset.rid); }
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
            if (!item || item.quizzes_json === undefined) {
                /* 课件按需拉取失败：给出明确错误提示 + 重试（原先静默 return，骨架屏"加载中"永远不消失） */
                var _bodyElE = document.getElementById('lessonBody');
                if (_bodyElE) _bodyElE.innerHTML = '<div class="flex flex-col items-center justify-center py-24 text-slate-400"><div class="text-4xl mb-4">⚠️</div><div class="text-sm mb-6">' + tr("netErr") + '</div><button data-rid="' + id + '" onclick="retryLesson(this)" class="px-6 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-bold hover:opacity-95 active:scale-[.98] transition">' + tr("retry") + '</button></div>';
                return;
            }
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
            if (!p) { showAdminErr(tr('adminPwEmpty')); return; }
            var r = await fetch('/api/verify', { method: 'POST', body: JSON.stringify({ password: p }) });
            var j = await r.json().catch(function(){ return {}; });
            if (j.ok) {
                try {
                    sessionStorage.setItem('TQ_ADMIN_OK', '1');
                    if (j.mustChange) sessionStorage.setItem('TQ_MUST_CHANGE_PW', '1');
                    else sessionStorage.removeItem('TQ_MUST_CHANGE_PW');
                } catch (e) {}
                location.reload();
            }
            else if (r.status === 429) showAdminErr(tr('loginLocked'));
            else showAdminErr(tr('tchPwWrong'));
        }
        /* 全新数据库：登录页一次性展示随机初始密码 */
        async function checkInitHint() {
            try {
                var r = await fetch('/api/admin/init-hint');
                var j = await r.json();
                var e = document.getElementById('adminInitHint');
                if (!e) return;
                if (j && j.isDefault && j.initPw) {
                    e.classList.remove('hidden');
                    document.getElementById('adminInitPw').textContent = j.initPw;
                } else e.classList.add('hidden');
            } catch (e) {}
        }
        /* 初始密码强制修改：不改不让用后台 */
        function enforcePwChange() {
            try {
                if (sessionStorage.getItem('TQ_MUST_CHANGE_PW') !== '1') return;
                if (!document.getElementById('pwModal')) return;
                document.getElementById('pw_old').value = "";
                document.getElementById('pw_new').value = "";
                var cb = document.getElementById('pwCancelBtn');
                if (cb) cb.style.display = 'none';
                var t = document.getElementById('pwModalTitle');
                if (t) t.textContent = tr('pwMustChangeT');
                document.getElementById('pwModal').classList.remove('hidden');
            } catch (e) {}
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
        function openPwModal() { document.getElementById('pw_old').value = ""; document.getElementById('pw_new').value = ""; var cb = document.getElementById('pwCancelBtn'); if (cb) cb.style.display = ""; var t = document.getElementById('pwModalTitle'); if (t) t.textContent = tr('pwChangeT'); toggleModal('pwModal'); }
        async function adminLogout() { if (!confirm("确定退出管理端登录？")) return; await fetch('/api/admin/logout', { method: 'POST' }); location.reload(); }
        async function doChangePassword() {
            var o = document.getElementById('pw_old').value, n = document.getElementById('pw_new').value;
            var r = await fetch('/api/change-password', { method: 'POST', body: JSON.stringify({ oldPassword: o, newPassword: n }) });
            var j = await r.json().catch(function(){ return {}; });
            if (j.ok) { try { sessionStorage.removeItem('TQ_MUST_CHANGE_PW'); } catch (e) {} alert(tr("pwChanged")); toggleModal('pwModal'); }
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
        /* PWA 安装按钮：浏览器判定可安装时触发 beforeinstallprompt，显示安装入口 */
        var _pwaDeferredPrompt = null;
        window.addEventListener('beforeinstallprompt', function(e) {
            try { e.preventDefault(); } catch (err) {}
            _pwaDeferredPrompt = e;
            var b = document.getElementById('pwaInstallFab');
            if (b) b.classList.remove('hidden');
        });
        window.addEventListener('appinstalled', function() {
            _pwaDeferredPrompt = null;
            var b = document.getElementById('pwaInstallFab');
            if (b) b.classList.add('hidden');
        });
        async function pwaInstall() {
            if (!_pwaDeferredPrompt) return;
            try { _pwaDeferredPrompt.prompt(); await _pwaDeferredPrompt.userChoice; } catch (e) {}
            _pwaDeferredPrompt = null;
            var b = document.getElementById('pwaInstallFab');
            if (b) b.classList.add('hidden');
        }
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
    <div id="pwaInstallFab" class="hidden">
        <button id="pwaInstallBtn" onclick="pwaInstall()" data-i18n="installApp">📲 安装应用</button>
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
/* 路径课程数：统一从 course_count 取，缺失时从 course_ids 计算（全站通用） */
function pathCourseCount(p) {
if (!p) return 0;
if (p.course_count) return p.course_count;
if (p.course_ids) {
try {
var cids = typeof p.course_ids === "string" ? JSON.parse(p.course_ids) : p.course_ids;
if (cids && cids.length) return cids.length;
} catch (e) {}
}
return 0;
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
var paths = null;
try { if (typeof BOOT !== "undefined" && BOOT.paths && BOOT.paths.length) paths = BOOT.paths; } catch (e) {}
try {
if (!paths) {
var username = pathUser();
var url = "/api/paths" + (username ? "?username=" + encodeURIComponent(username) : "");
var r = await fetch(url);
var j = await r.json();
paths = j.paths || [];
}
var html = '<div class="flex items-center justify-between mb-5">'
+ '<h2 class="text-xl font-bold text-slate-900">🗺 ' + escP(tr("path_title")) + '</h2>'
+ '<button onclick="renderCertificatesPage()" class="px-4 py-2 text-sm font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl hover:bg-amber-100 transition">🏆 ' + escP(tr("path_myCerts")) + '</button>'
+ '</div>';
if (!paths.length) {
html += '<div class="text-center text-slate-400 py-12">' + escP(tr("path_empty")) + '</div>';
} else {
html += paths.map(function (p) {
var total = pathCourseCount(p), done = p.done_count || 0;
var pct = total > 0 ? Math.round(done / total * 100) : 0;
var finished = total > 0 && done >= total;
var btnLabel = done > 0 ? tr("path_continue") : tr("path_start");
return '<div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 mb-4">'
+ '<div class="flex items-center justify-between gap-2">'
+ '<div class="text-lg font-bold text-slate-900">' + pathIcon(p) + ' ' + escP(pathTitleL(p)) + '</div>'
+ '<button data-pid="' + escP(p.id) + '" onclick="copyPathLink(this.dataset.pid)" title="' + escP(tr("copyLinkT")) + '" class="text-slate-300 hover:text-violet-600 transition text-base shrink-0">🔗</button></div>'
+ (pathDescrL(p) ? '<div class="text-sm text-slate-500 mt-1 leading-relaxed">' + escP(pathDescrL(p)) + '</div>' : '')
+ '<div class="mt-3 h-2 bg-slate-100 rounded-full overflow-hidden"><div class="h-2 rounded-full transition-all ' + (finished ? 'bg-amber-500' : 'bg-emerald-500') + '" style="width:' + pct + '%"></div></div>'
+ '<div class="flex items-center justify-between mt-2 gap-2">'
+ '<span class="text-xs text-slate-500">' + escP(tf("path_doneOf", { a: done, b: total })) + '</span>'
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
var sd = (typeof subDescL === "function") ? subDescL(cat, sk) : (info.subDesc[sk] || "");
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
+ (function(){ var _sd2 = (typeof catDescL === "function") ? catDescL(cat) : info.description; return _sd2 ? '<p class="text-sm text-slate-500 mt-2 mb-1 ml-8 leading-relaxed">' + escP(String(_sd2).split("**").join("").split(String.fromCharCode(10)).join(" ").trim()) + "</p>" : ""; })()
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
+ '<div class="text-xs text-slate-400">' + pathCourseCount(p) + ' 门课程</div></div>' 
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
