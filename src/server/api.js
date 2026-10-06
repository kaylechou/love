
export default {
async fetch(request, env) {
const { pathname, searchParams} = new URL(request.url);
const shareId = searchParams.get('id');

try {
if (!env.DB) return new Response("数据库未绑定", { status: 500});
await migrate(env);
const authed = await isAdminReq(request, env);

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
