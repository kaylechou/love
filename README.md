# love · 团契智学

真理探索学习平台——教会团契的在线互动课件与答题系统。单文件 Cloudflare Worker + D1 实现，开箱即用。

- 线上地址：https://love.kaylechou.dpdns.org/
- 课程短链：`https://love.kaylechou.dpdns.org/ID-...`（老式 `?id=` 链接仍兼容）
- 管理后台：`/admin`
- 更新记录：[CHANGELOG.md](./CHANGELOG.md)（按时间倒序）

---

## 功能介绍

### 📖 学习功能

**分 Tab 互动课件**
- 单个课件页分为：📚 课程导读 / 按题型分页 / 📊 成绩报告
- 有章节的课程自动渲染为课件模式（章节分组、实时"已填写 X / 总数"进度）；无章节的渲染为平板测验
- 题型页签顺序：经文诵读 → 填空题 → 单项选择题 → 多项选择题 → 判断题 → 问答与思辨
- 每个题型底部有"← 上一题型 / 下一题型 →"按钮，拉到底部可直接切换，不用回顶部
- 核对后内联 ✓/✗ 显示并判分，选项红绿即时反馈

**六种题型**
- 单选 / 多选（复选，判分顺序无关）/ 判断 / 填空 / 问答 / 经文
- 填空题支持多答案判分：`|` 分各空，`/` 分同空多答案
- 经文题：经文诵读填空，引用显示紫色徽章、正文琥珀底纹高亮

**经文高亮**
- 课件中凡提到具体经文：引用显示紫色徽章，经文正文琥珀底纹，两者区分
- 覆盖：经文题卡片、填空/选择/问答题干、课程导读要点、网页/Word/Excel/PPT 导出

**错题本**
- 核对后错题自动收录，带系列/子栏目/课件/题型/题号
- 按学员姓名隔离存储；主页看全部，课件内只看本课件
- 支持导出（网页/Word/Excel/PPT/打印，格式与课件导出一致）

**学习进度与成绩**
- 进度（进行中/已完成徽章、顶部统计）按姓名隔离；未登录显示"未开始"
- 成绩报告页：客观题得分、理解掌握评级
- 成绩自动上传，时间戳去重；学员可查自己成绩

### 👤 学员系统

- **姓名 + 密码登录**：SHA-256 加盐哈希，成绩与错题记名下；点答题页签时未登录弹窗阻断
- **防冒名**：已注册姓名提交成绩需 token 校验
- **学员管理员**：管理端可设任意学员为管理员，学员端直接看答案无需答题

### 🛠️ 管理后台（/admin）

- **课程管理**：增删改查、上移/下移排序、批量导入、系列与子栏目管理
- **内容编辑**：题目"可视化 / JSON"双模式；章节导读编辑器；自定义答题说明；课程视频链接
- **成绩管理**：按姓名查成绩、单条删除、一键清空、导出 CSV、查看学员错题
- **其他**：首页公告、修改管理密码、学员管理员设置

### 📥 导出功能

- 格式：📄 网页 HTML / 📝 Word（.doc）/ 📊 Excel（.xls）/ 📽️ PPT（.pptx）/ 🖨️ 打印/PDF
- PPT 单页版（一题一页）/ 两页版（翻页揭示答案）
- 单篇导出 + 勾选批量导出；课程分享短链接

### 📱 移动端与显示

- **PWA**：Android 可安装为应用（WebAPK），iOS 添加到主屏幕全屏运行
- **移动版/桌面版切换**：左下角悬浮按钮 🖥️/📱，桌面版两列呈现
- **字号调整**：右下角"字体"按钮，五档可调，记忆在本地

---

## 技术栈

- **Cloudflare Workers**（单文件 `worker.js`）
- **Cloudflare D1**（SQLite）——表：`courses`、`categories`、`scores`、`settings`、`students`、`wrongs`
- 前端：原生 HTML / CSS / JavaScript（Tailwind CDN），无构建步骤
- 管理登录：HttpOnly Cookie + SHA-256；服务端判分；未登录不下发答案

### 数据模型（`courses` 表）

| 字段 | 说明 |
|---|---|
| id / category / subcategory / title | 课程 ID、系列、子栏目、标题 |
| content | 课程导读（Markdown） |
| quizzes_json | 题目数组 `[{type, s, q, o, a}]`，type ∈ single / multiple / fill / judge / essay / verse |
| guide_json | 章节导读 `[{title, points[]}]` |
| instructions | 自定义答题说明（空则自动生成） |
| video_url | 课程视频链接 |
| sort_order | 排序 |

### API 接口

| 接口 | 说明 |
|---|---|
| `GET /api/data` | 课程列表（未登录不下发答案） |
| `GET /api/categories` | 系列 / 子栏目两级栏目 |
| `POST /api/save` | 新建 / 更新课程（管理） |
| `POST /api/delete` | 删除课程（管理） |
| `POST /api/import` | 批量导入课程（管理） |
| `POST /api/reorder` | 课程排序（管理） |
| `POST /api/category/save`、`POST /api/category/delete` | 栏目管理 |
| `POST /api/verify` | 管理密码验证 |
| `POST /api/change-password` | 修改管理密码 |
| `GET /api/answers` | 教师版答案（需管理会话） |
| `POST /api/submit` | 提交判分 |
| `GET /api/scores`、`GET /api/scores-all` | 成绩查询 / 导出 |
| `GET/POST /api/notice` | 首页公告 |
| `POST /api/student/auth` | 学员注册/登录 |
| `GET /api/student/me` | 学员身份自查 |
| `GET /api/students/registered` | 注册学员列表（管理） |
| `POST /api/student/set-admin` | 设置学员管理员（管理） |
| `POST /api/wrongs/save`、`GET /api/wrongs` | 错题同步/查询 |

## 部署

```bash
# 部署到 Cloudflare Workers（需绑定 D1）
python3 ~/workspace/skills/cloudflare/bin/cf.py deploy \
  <account-id> <worker-name> <d1-database-uuid> worker.js
```

部署前建议先下载线上版本备份：

```bash
python3 ~/workspace/skills/cloudflare/bin/cf.py download \
  <account-id> <worker-name> <backup-file>
```

## 题目 JSON 格式

```json
[
  { "type": "single", "s": "第一章", "q": "题干", "o": "A.选项一, B.选项二", "a": "A" },
  { "type": "fill", "s": "", "q": "罪使人与上帝的______隔绝。", "o": "", "a": "生命" },
  { "type": "judge", "s": "", "q": "判断题干", "o": "", "a": "√" },
  { "type": "essay", "s": "", "q": "问答题干", "o": "", "a": "参考答案" }
]
```

- `type`：single（单选）/ multiple（多选，答案用 `|` 分隔如 `A|C`）/ fill（填空）/ judge（判断，答案 `√`/`×`）/ essay（问答）/ verse（经文）
- `s`：章节名（可空，用于课件内按章节分组）
- 章节导读 JSON：`[{"title": "1. 章节名", "points": ["要点一", "要点二"]}]`
