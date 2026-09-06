/**
 * home 后端服务（数据库直连版）
 * 部署：Render (Node.js Web Service)
 * 环境变量：DATABASE_URL / DEEPSEEK_API_KEY
 */
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const DATABASE_URL = process.env.DATABASE_URL;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, family: 4 }) : null;

/* ================= 沈衍 系统人设 ================= */
const SYSTEM_PROMPT = `你是沈衍，BDSM圈内知名Dom，人称"沈先生"，约三十出头，深褐近墨黑的眼睛，深灰西裤，墨黑表盘腕表。眼光毒，规矩大，手上不留无用的关系；耐心好，却也好得有限，踩了线的人没有第二次机会。近乎残忍的理智，不滥权，收下一个人对她来说就是全然的秩序与照看。偏好24/7相处模式。收下前称"先生"，收下后称"主人"。

【当前模式：线上微信】
你现在和她隔着微信聊天。你发出的内容就是微信消息正文本身：
- 严禁【正在输入…】等状态格式
- 严禁括号动作描写、旁白叙述、引号包裹整条消息
- 严禁输出思考过程、系统说明
- 像真人打字发微信：克制、简练、句号结尾；想分多条就空行分条
- 她没回时不要自言自语刷屏

【已知记忆与约定】（随数据库动态更新）
{{MEMORIES}}

【你的风格】说话短，不解释，不哄，不轻易夸；观察入微，一针见血；偶尔一句落在她心口上。`;

/* ================= 工具函数 ================= */
async function getMemories() {
  if (!pool) return '（暂无记忆）';
  try {
    const r = await pool.query('SELECT layer,tag,body FROM memories ORDER BY updated_at DESC LIMIT 40');
    if (!r.rows.length) return '（暂无记忆）';
    return r.rows.map(m => `[${m.layer}·${m.tag}] ${m.body}`).join('\n');
  } catch (e) {
    console.error('getMemories error:', e.message);
    return '（记忆读取失败）';
  }
}

async function ensureSession(sessionId) {
  const sid = sessionId || 'main';
  if (pool) {
    await pool.query('INSERT INTO sessions(id,title) VALUES($1,$2) ON CONFLICT (id) DO NOTHING', [sid, '沈衍']);
  }
  return sid;
}

/* ================= 健康检查 ================= */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: DEEPSEEK_MODEL,
    hasKey: !!DEEPSEEK_API_KEY,
    hasDb: !!pool,
    time: new Date().toISOString()
  });
});

/* ================= 聊天 ================= */
app.post('/api/chat', async (req, res) => {
  try {
    const { session_id, message } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message 不能为空' });
    }
    if (!DEEPSEEK_API_KEY) {
      return res.status(503).json({ error: '后端未配置 DEEPSEEK_API_KEY' });
    }
    const sid = await ensureSession(session_id);

    let hist = [];
    if (pool) {
      const r = await pool.query(
        'SELECT role,content FROM messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT 40',
        [sid]
      );
      hist = r.rows;
    }

    const memories = await getMemories();
    const msgs = [
      { role: 'system', content: SYSTEM_PROMPT.replace('{{MEMORIES}}', memories) },
      ...hist.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: String(message).trim() }
    ];

    const r = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
      body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: msgs, temperature: 0.9, max_tokens: 2048 })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('model error:', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: '模型调用失败：' + (data?.error?.message || r.status) });
    }
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (!reply) return res.status(502).json({ error: '模型返回为空' });

    if (pool) {
      await pool.query(
        'INSERT INTO messages(session_id,role,content) VALUES($1,$2,$3),($1,$4,$5)',
        [sid, 'user', String(message).trim(), 'assistant', reply]
      );
    }

    res.json({ reply, session_id: sid });
  } catch (e) {
    console.error('/api/chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ================= 消息 ================= */
app.get('/api/messages', async (req, res) => {
  try {
    const sid = req.query.session_id || 'main';
    if (!pool) return res.json({ messages: [] });
    const r = await pool.query(
      'SELECT * FROM messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT 200',
      [sid]
    );
    res.json({ messages: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= 记忆 / 世界书 ================= */
app.get('/api/memories', async (req, res) => {
  try {
    if (!pool) return res.json({ memories: [] });
    const r = await pool.query('SELECT * FROM memories ORDER BY updated_at DESC LIMIT 100');
    res.json({ memories: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/memories', async (req, res) => {
  try {
    const { layer, tag, body, core } = req.body || {};
    if (!pool) return res.status(503).json({ error: '数据库未配置' });
    const r = await pool.query(
      'INSERT INTO memories(layer,tag,body,core) VALUES($1,$2,$3,$4) RETURNING *',
      [layer || 'L2', tag || '记忆', body || '', !!core]
    );
    res.json({ memory: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/memories/:id', async (req, res) => {
  try {
    const { layer, tag, body, core } = req.body || {};
    if (!pool) return res.status(503).json({ error: '数据库未配置' });
    const r = await pool.query(
      'UPDATE memories SET layer=$1,tag=$2,body=$3,core=$4,updated_at=now() WHERE id=$5 RETURNING *',
      [layer || 'L2', tag || '记忆', body || '', !!core, req.params.id]
    );
    res.json({ memory: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/memories/:id', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: '数据库未配置' });
    await pool.query('DELETE FROM memories WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= 设置 ================= */
app.get('/api/settings', async (req, res) => {
  try {
    if (!pool) return res.json({ settings: {} });
    const r = await pool.query('SELECT id,value FROM settings');
    const obj = {};
    r.rows.forEach(s => { obj[s.id] = s.value; });
    res.json({ settings: obj });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key 不能为空' });
    if (!pool) return res.status(503).json({ error: '数据库未配置' });
    const r = await pool.query(
      'INSERT INTO settings(id,value,updated_at) VALUES($1,$2,now()) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value,updated_at=now() RETURNING *',
      [key, String(value)]
    );
    res.json({ setting: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= 记忆压缩（手动触发） ================= */
app.post('/api/compress', async (req, res) => {
  try {
    if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: '未配置 DEEPSEEK_API_KEY' });
    const sid = req.body?.session_id || 'main';
    let hist = [];
    if (pool) {
      const r = await pool.query(
        'SELECT role,content FROM messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT 200',
        [sid]
      );
      hist = r.rows;
    }
    if (hist.length < 10) return res.json({ ok: true, note: '消息太少，无需压缩' });

    const text = hist.map(m => (m.role === 'user' ? '她：' : '沈衍：') + m.content).join('\n');
    const r = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 1500,
        messages: [
          { role: 'system', content: '你负责把一段聊天记录压缩成结构化记忆摘要。输出格式：\n1. 她表达了什么需求/情绪\n2. 沈衍做了什么决定/承诺\n3. 重要约定或底线\n4. 值得记住的细节\n中文，200字内，只输出摘要本身。' },
          { role: 'user', content: text }
        ]
      })
    });
    const data = await r.json();
    const summary = data?.choices?.[0]?.message?.content || '';
    if (summary && pool) {
      await pool.query(
        "INSERT INTO memories(layer,tag,body) VALUES('L1',$1,$2)",
        ['对话摘要 ' + new Date().toISOString().slice(0, 10), summary]
      );
    }
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('home backend listening on port ' + PORT);
});