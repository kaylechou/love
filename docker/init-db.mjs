/* Docker/NAS 首次启动建表：补上 worker.js migrate() 未覆盖的 courses 表 */
export async function ensureSchema(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    category TEXT,
    title TEXT,
    content TEXT,
    quizzes_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    video_url TEXT,
    mode TEXT DEFAULT 'quiz',
    sort_order INTEGER DEFAULT 0,
    subcategory TEXT DEFAULT '',
    guide_json TEXT,
    instructions TEXT
  )`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_courses_cat ON courses(category, subcategory, sort_order)`);
}
