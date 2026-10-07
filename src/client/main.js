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
/*@@I18N@@*/
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
                // 只替换 q/s/o/h，保留 a（答案）和 id 等
                for (var i = 0; i < qs.length; i++) {
                    if (d.quizzes[i].q) qs[i].q = d.quizzes[i].q;
                    if (d.quizzes[i].s) qs[i].s = d.quizzes[i].s;
                    // o（经文出处）不翻译，保持原文用于 bible_verses 查询
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
        var BIBLE_BOOKS_JA = 'サムエル記第一|サムエル記第二|列王記第一|列王記第二|歴代誌第一|歴代誌第二|コリント人への第一の手紙|コリント人への第二の手紙|テサロニケ人への第一の手紙|テサロニケ人への第二の手紙|テモテへの第一の手紙|テモテへの第二の手紙|ペテロの第一の手紙|ペテロの第二の手紙|ヨハネの第一の手紙|ヨハネの第二の手紙|ヨハネの第三の手紙|創世記|出エジプト記|レビ記|民数記|申命記|ヨシュア記|士師記|ルツ記|エズラ記|ネヘミヤ記|エステル記|ヨブ記|詩篇|箴言|伝道者の書|雅歌|イザヤ書|エレミヤ書|哀歌|エゼキエル書|ダニエル書|ホセア書|ヨエル書|アモス書|オバデヤ書|ヨナ書|ミカ書|ナホム書|ハバクク書|ゼパニヤ書|ハガイ書|ゼカリヤ書|マラキ書|マタイの福音書|マルコの福音書|ルカの福音書|ヨハネの福音書|使徒の働き|ローマ人への手紙|ガラテヤ人への手紙|エペソ人への手紙|ピリピ人への手紙|コロサイ人への手紙|テトスへの手紙|ピレモンへの手紙|ヘブル人への手紙|ヤコブの手紙|ユダの手紙|黙示録';
        /* 韩文书名 */
        var BIBLE_BOOKS_KO = '사무엘상|사무엘하|열왕기상|열왕기하|역대상|역대하|고린도전서|고린도후서|데살로니가전서|데살로니가후서|디모데전서|디모데후서|베드로전서|베드로후서|요한1서|요한2서|요한3서|창세기|출애굽기|레위기|민수기|신명기|여호수아|사사기|룻기|에스라|느헤미야|에스더|욥기|시편|잠언|전도서|아가|이사야|예레미야|예레미야애가|에스겔|다니엘|호세아|요엘|아모스|오바댜|요나|미가|나훔|하박국|스바냐|학개|스가랴|말라기|마태복음|마가복음|누가복음|요한복음|사도행전|로마서|갈라디아서|에베소서|빌립보서|골로새서|디도서|빌레몬서|히브리서|야고보서|유다서|요한계시록';
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
            }
            var sid = new URLSearchParams(window.location.search).get('id');
            if (!sid) {
                var pm = window.location.pathname.match(/^\\/(ID-[A-Za-z0-9_-]+)$/);
                if (pm) sid = pm[1];
            }
            if (sid && allData.length > 0) startLesson(sid);
            if (!sid) {
                var _qs = new URLSearchParams(window.location.search);
                var _qSeries = _qs.get('series'), _qSub = _qs.get('sub');
                if (_qSeries && allData.length > 0) setTimeout(function() { jumpToSeries(_qSeries, _qSub); }, 350);
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
                    + (catDescL(cat) ? '<p class="text-sm text-slate-500 mt-2 ml-[52px] leading-relaxed">' + hlVerse(esc(catDescL(cat))) + '</p>' : '')
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
                    body: JSON.stringify({ username: name, course_id: activeLessonId, courseTitle: activeCourseTitle, answers: answers, token: (function(){ try { return localStorage.getItem(STUDENT_TOKEN_KEY) || ""; } catch(e) { return ""; } })() })
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
            if (curLang() === 'tw' && !BOOT.isAdmin) item = twCourse(item);
            if (!BOOT.isAdmin) item = i18nCourse(item);
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
