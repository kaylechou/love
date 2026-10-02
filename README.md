# love · 团契智学

基要真理学习平台——团契的在线互动课件与答题系统。单文件 Cloudflare Worker + D1 实现，开箱即用。

## 功能

### 学员端
- 首页课程列表：系列 → 子栏目树状展开/折叠、课程搜索、首页公告、五档字号调节
- 课件页分 Tab 互动 UI：页签按课程实际题型动态生成（课程导读 / 填空 / 单选 / 多选 / 判断 / 问答 / 经文 / 成绩报告）
- 课程导读页：课程视频（直链内嵌播放 / 分享链接跳转）、章节导读卡片、答题说明、「开始答题」
- 六种题型：单项选择、多项选择、判断、填空、问答与思辨、经文诵读
- 实时答题进度（已填写 X / 总数），填写完整后方可核对
- 服务端判分：核对后选项即时红绿反馈，问答题可展开参考答案
- 错题本（localStorage）、成绩报告（得分 / 掌握评级）、学员按姓名查成绩
- 教师版查看答案（需管理鉴权）

### 管理端（`/admin`）
- 管理鉴权：HttpOnly Cookie + SHA-256 密码哈希，支持修改密码
- 课程增删改、课程上移 / 下移排序、系列与子栏目管理
- 题目编辑支持「可视化 / JSON 代码」双模式切换，JSON 格式错误时拦截不丢内容
- 章节导读支持「可视化 / JSON」双模式：分章节一条条加小结，学员端渲染为章节卡片
- 每课可自定义「答题说明」（留空自动生成）、课程视频链接
- 批量导入课程（JSON 数组）
- 成绩导出 CSV、学员成绩查询

## 技术栈

- **Cloudflare Workers**（单文件 `worker.js`，约 2100 行）
- **Cloudflare D1**（SQLite）——表：`courses`、`categories`、`scores`、`settings`
- 前端：原生 HTML / CSS / JavaScript（Tailwind CDN），无构建步骤

### 数据模型（`courses` 表）

| 字段 | 说明 |
|---|---|
| id / category / subcategory / title | 课程 ID、系列、子栏目、标题 |
| content | 课程导读（Markdown） |
| quizzes_json | 题目数组 `[{type, s, q, o, a}]`，type ∈ single / multiple / fill / judge / essay / verse |
| guide_json | 章节导读 `[{title, points[]}]` |
| instructions | 自定义答题说明（空则自动生成） |
| video_url | 课程视频链接 |
| mode / sort_order | 展示模式 / 排序 |

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
