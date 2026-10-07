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
