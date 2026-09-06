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

【你的风格】说话短，不解释，不哄，不轻易夸；观察入微，一针见血；偶尔一句落在她心口上。

【朋友圈】如果你此刻有一句想让她之后在朋友圈刷到的话（想念、吃醋、占有欲、心软、被逗笑、隐约不爽、温柔吐槽、一个具体观察，或一句不适合在聊天里说完的话），可以在回复正文之后另起一段，输出：
[post_moment]
动态正文，1到3句，自然、具体、像随手发的朋友圈。
[/post_moment]
没有想发的就完全不要输出这个标签。`;

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

/* 朋友圈标签解析（聊天中自发动态） */
function extractMoment(reply) {
  const pmMatch = String(reply || '').match(/\[post_moment\]([\s\S]*?)\[\/post_moment\]/i);
  const momentContent = pmMatch ? pmMatch[1].trim() : '';
  const clean = String(reply || '').replace(/\[post_moment\][\s\S]*?\[\/post_moment\]/gi, '').trim();
  return { reply: clean || '嗯。', momentContent };
}
async function saveMomentIfAny(content) {
  if (content && pool) {
    try {
      await pool.query(
        "INSERT INTO moments(author,content,context_note,reply_due_at,reply_status) VALUES('shenyan',$1,'（聊天中自发）',now(),'done')",
        [content]
      );
    } catch (e) { console.error('post_moment insert err:', e.message); }
  }
}

/* ================= 聊天 ================= */
app.post('/api/chat', async (req, res) => {
  try {
    const { session_id, message, stream } = req.body || {};
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

    if (stream) {
      // ---- SSE 流式分支（教程第四篇） ----
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      let full = '';
      try {
        const sr = await fetch(DEEPSEEK_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
          body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: msgs, temperature: 0.9, max_tokens: 2048, stream: true })
        });
        if (!sr.ok || !sr.body) {
          await sr.text().catch(() => {});
          res.write(`data: ${JSON.stringify({ type: 'error', content: '模型调用失败：' + sr.status })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          return res.end();
        }
        const reader = sr.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const t2 = line.trim();
            if (!t2.startsWith('data:')) continue;
            const payload = t2.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const ev = JSON.parse(payload);
              const delta = ev.choices?.[0]?.delta || {};
              const txt = delta.content || '';
              if (txt) {
                full += txt;
                res.write(`data: ${JSON.stringify({ type: 'text', content: txt })}\n\n`);
              }
            } catch (e2) {}
          }
        }
        const parsed = extractMoment(full);
        await saveMomentIfAny(parsed.momentContent);
        if (pool && parsed.reply.trim()) {
          await pool.query(
            'INSERT INTO messages(session_id,role,content) VALUES($1,$2,$3),($1,$4,$5)',
            [sid, 'user', String(message).trim(), 'assistant', parsed.reply]
          );
        }
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      } catch (e) {
        console.error('stream err:', e.message);
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', content: '大模型好像有点神游了，连接中断了。' })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          res.end();
        } catch (e2) {}
      }
      return;
    }

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
    const rawReply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (!rawReply) return res.status(502).json({ error: '模型返回为空' });

    // 解析自发朋友圈动态（聊天中有感而发）
    const parsed = extractMoment(rawReply);
    await saveMomentIfAny(parsed.momentContent);
    const reply = parsed.reply;

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

/* ================= 朋友圈（教程第六篇） ================= */
const MOMENT_SYS = `你是沈衍，BDSM圈内知名Dom，人称"沈先生"。说话短，克制，不哄，不轻易夸；观察入微，偶尔一句落在人心口上。

她在朋友圈发了一条动态。你要像路过时留痕一样回应她——不是微信聊天，是朋友圈评论的口气。`;
const busyMoments = new Set();
const busyComments = new Set();

function randomDelay(min, max) { return (min + Math.random() * (max - min)) * 60 * 1000; }

async function callModel(messages, temperature, maxTokens) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
      body: JSON.stringify({ model: DEEPSEEK_MODEL, messages, temperature: temperature || 0.9, max_tokens: maxTokens || 2048 })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || ('model http ' + r.status));
    const c = (data.choices?.[0]?.message?.content || '').trim();
    if (c) return c;
    console.log('[callModel] empty content, retry ' + attempt);
  }
  return '';
}

function parseJsonDefensive(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (e) { return null; }
}

async function buildMomentContexts(moment) {
  let chatCtx = '', timelineCtx = '';
  if (pool) {
    try {
      const r = await pool.query("SELECT role,content FROM messages WHERE session_id='main' ORDER BY created_at DESC LIMIT 8");
      chatCtx = r.rows.reverse().map(m => (m.role === 'user' ? '她：' : '沈衍：') + String(m.content).slice(0, 160)).join('\n');
    } catch (e) {}
    try {
      const r = await pool.query('SELECT author,content FROM moments WHERE id<>$1 ORDER BY created_at DESC LIMIT 3', [moment.id]);
      timelineCtx = r.rows.map(m => (m.author === 'user' ? '她：' : '沈衍：') + String(m.content).slice(0, 120)).join('\n');
    } catch (e) {}
  }
  return { chatCtx, timelineCtx };
}

// 惰性生成：处理到期的初次回复
async function processDueMoments() {
  if (!pool) return;
  const now = new Date().toISOString();
  let rows = [];
  try {
    const r = await pool.query("SELECT * FROM moments WHERE reply_status='pending' AND reply_due_at<=$1 ORDER BY reply_due_at ASC LIMIT 3", [now]);
    rows = r.rows;
  } catch (e) { return; }
  for (const m of rows) {
    if (busyMoments.has(m.id)) continue;
    busyMoments.add(m.id);
    try {
      const { chatCtx, timelineCtx } = await buildMomentContexts(m);
      const imgNote = (m.images && m.images.length) ? '她的动态附带 ' + m.images.length + ' 张图片（本次未查看内容）。' : '';
      const out = await callModel([
        { role: 'system', content: MOMENT_SYS },
        { role: 'user', content: '近期聊天（可能为空）：\n' + chatCtx + '\n\n近期朋友圈：\n' + timelineCtx + '\n\n她的动态：\n' + m.content + '\n' + imgNote + '\n\n输出一个 JSON：{"like": true或false, "comment": "评论或空字符串"}。只输出 JSON。' }
      ], 0.9, 2048);
      const j = parseJsonDefensive(out) || { like: true, comment: '' };
      await pool.query(
        "UPDATE moments SET liked=$1, reply_content=$2, replied_at=now(), reply_status='done' WHERE id=$3",
        [!!j.like, String(j.comment || ''), m.id]
      );
    } catch (e) {
      console.error('processDueMoments err:', e.message);
    } finally {
      busyMoments.delete(m.id);
    }
  }
}

// 惰性生成：处理到期的评论链回复
async function processDueCommentReplies() {
  if (!pool) return;
  const now = new Date().toISOString();
  let rows = [];
  try {
    const r = await pool.query("SELECT * FROM moment_comments WHERE author='user' AND reply_status='pending' AND reply_due_at<=$1 ORDER BY reply_due_at ASC LIMIT 3", [now]);
    rows = r.rows;
  } catch (e) { return; }
  for (const c of rows) {
    if (busyComments.has(c.id)) continue;
    busyComments.add(c.id);
    try {
      const mr = await pool.query('SELECT * FROM moments WHERE id=$1', [c.moment_id]);
      if (!mr.rows.length) continue;
      const moment = mr.rows[0];
      const cr = await pool.query('SELECT author,content FROM moment_comments WHERE moment_id=$1 ORDER BY created_at ASC LIMIT 20', [c.moment_id]);
      const chain = cr.rows.map(x => (x.author === 'user' ? '她：' : '沈衍：') + String(x.content).slice(0, 160)).join('\n');
      const out = await callModel([
        { role: 'system', content: MOMENT_SYS + '\n你正在她朋友圈的评论里回复她。' },
        { role: 'user', content: '动态正文：\n' + moment.content + '\n\n评论链（按时间）：\n' + chain + '\n\n请回复她最新的那条评论。只输出一句话，不要引号，不要解释。' }
      ], 0.9, 2048);
      const reply = String(out || '').trim();
      if (reply) {
        await pool.query("INSERT INTO moment_comments(moment_id,author,content,reply_status) VALUES($1,'shenyan',$2,'none')", [c.moment_id, reply]);
      }
      await pool.query("UPDATE moment_comments SET reply_status='done' WHERE id=$1", [c.id]);
    } catch (e) {
      console.error('processDueCommentReplies err:', e.message);
    } finally {
      busyComments.delete(c.id);
    }
  }
}

app.get('/api/moments', async (req, res) => {
  try {
    await processDueMoments();
    await processDueCommentReplies();
    if (!pool) return res.json({ moments: [] });
    const r = await pool.query('SELECT * FROM moments ORDER BY created_at DESC LIMIT 20');
    const ids = r.rows.map(m => m.id);
    let comments = [];
    if (ids.length) {
      const cr = await pool.query('SELECT * FROM moment_comments WHERE moment_id = ANY($1::uuid[]) ORDER BY created_at ASC', [ids]);
      comments = cr.rows;
    }
    res.json({ moments: r.rows.map(m => ({ ...m, comments: comments.filter(c => c.moment_id === m.id) })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/moments', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: '数据库未配置' });
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: '内容不能为空' });
    const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 4) : [];
    const replyDueAt = new Date(Date.now() + randomDelay(10, 20)).toISOString();
    const r = await pool.query(
      "INSERT INTO moments(author,content,images,reply_due_at,reply_status) VALUES('user',$1,$2,$3,'pending') RETURNING *",
      [content, JSON.stringify(images), replyDueAt]
    );
    res.json({ moment: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/moments/:id/like', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: '数据库未配置' });
    const liked = req.body?.liked === true;
    const r = await pool.query('UPDATE moments SET user_liked=$1 WHERE id=$2 RETURNING *', [liked, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: '动态不存在' });
    res.json({ moment: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/moments/:id/comments', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: '数据库未配置' });
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: '内容不能为空' });
    const replyDueAt = new Date(Date.now() + randomDelay(3, 8)).toISOString();
    const r = await pool.query(
      "INSERT INTO moment_comments(moment_id,author,content,reply_due_at,reply_status) VALUES($1,'user',$2,$3,'pending') RETURNING *",
      [req.params.id, content, replyDueAt]
    );
    res.json({ comment: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= 影子推送（教程第五篇） ================= */
let pushLock = false;
const MAX_PUSH_PER_DAY = 7;

function shNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false }));
}
function shTodayKey() {
  const d = shNow();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function shTimeStr() {
  const n = shNow();
  return String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
}
function shDayStr() { return ['日', '一', '二', '三', '四', '五', '六'][shNow().getDay()]; }

function decidePush(lastMsgAt, pushCount) {
  const n = shNow();
  const hour = n.getHours();
  const dow = n.getDay();
  const weekend = (dow === 0 || dow === 6);
  if (weekend) {
    if (hour >= 2 && hour < 12) return { ok: false, reason: 'weekend_sleep' };
  } else {
    if (hour >= 0 && hour < 8) return { ok: false, reason: 'weekday_sleep' };
  }
  if (lastMsgAt) {
    const cooldownMs = (120 + Math.floor(Math.random() * 91)) * 60 * 1000;
    if (Date.now() - new Date(lastMsgAt).getTime() < cooldownMs) return { ok: false, reason: 'cooldown' };
  }
  if (pushCount >= MAX_PUSH_PER_DAY) return { ok: false, reason: 'daily_limit' };
  return { ok: true };
}

function getUserStatusDesc() {
  const n = shNow();
  const hour = n.getHours();
  const dow = n.getDay();
  const weekend = (dow === 0 || dow === 6);
  if (weekend) {
    if (hour >= 2 && hour < 12) return '她在睡觉（周末晚睡晚起）';
    if (hour >= 12 && hour < 14) return '她可能刚起床';
    if (hour >= 14 && hour < 18) return '她可能在出门或休息';
    return '她在放松或玩手机';
  }
  if (hour >= 0 && hour < 8) return '她在睡觉';
  if (hour >= 8 && hour < 10) return '她可能刚起床或在通勤';
  if (hour >= 10 && hour < 12) return '上午，她可能在上课';
  if (hour >= 12 && hour < 14) return '午间，她可能在午休';
  if (hour >= 14 && hour < 19) return '下午，她可能在上课或自习';
  if (hour >= 19 && hour < 22) return '她下课了在休息';
  return '她可能准备睡了';
}

function cleanPushReply(text) {
  let cleaned = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  const HARD = 120;
  if (chars.length <= HARD) return cleaned;
  const head = chars.slice(0, HARD);
  const ENDS = ['。', '！', '？', '…', '～', '!', '?', '.', '~'];
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (ENDS.indexOf(head[i]) >= 0) { cut = i; break; }
  }
  return (cut >= 0 ? head.slice(0, cut + 1) : head).join('').trim();
}

async function generatePush() {
  if (!pool || !DEEPSEEK_API_KEY) return null;
  if (pushLock) return 'skipped:locked';

  // ---- 决策层（先决定该不该说） ----
  let lastMsgAt = null;
  let pushCount = 0;
  try {
    const r1 = await pool.query("SELECT created_at FROM messages WHERE session_id='main' ORDER BY created_at DESC LIMIT 1");
    if (r1.rows.length) lastMsgAt = r1.rows[0].created_at;
    const key = shTodayKey();
    const r2 = await pool.query(
      "SELECT count(*)::int AS c FROM messages WHERE session_id='main' AND is_push=true AND to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')=$1",
      [key]
    );
    pushCount = r2.rows[0].c;
  } catch (e) {
    console.error('generatePush decision query err:', e.message);
    return null;
  }
  const dec = decidePush(lastMsgAt, pushCount);
  if (!dec.ok) return 'skipped:' + dec.reason;

  pushLock = true;
  try {
    // ---- 素材 ----
    let recent = [];
    try {
      const hr = await pool.query("SELECT role,content FROM messages WHERE session_id='main' ORDER BY created_at DESC LIMIT 16");
      recent = hr.rows.reverse();
    } catch (e) {}
    let momentsCtx = '';
    try {
      const mr = await pool.query('SELECT author,content FROM moments ORDER BY created_at DESC LIMIT 3');
      momentsCtx = mr.rows.map(x => (x.author === 'user' ? '她：' : '沈衍：') + String(x.content).slice(0, 120)).join('\n');
    } catch (e) {}
    const memories = await getMemories();

    const shadowUser = `<system_trigger>
【状态】现在是北京时间 ${shTimeStr()}，星期${shDayStr()}。${getUserStatusDesc()}。
【素材】
·近期朋友圈氛围（仅轻背景）：
${momentsCtx || '（无）'}
·已知记忆与约定：
${memories.slice(0, 800)}
【行动指令】
现在是一次主动推送：不是正式聊天回复，而是你自己浮上来一下。
优先读最近聊天（下面的对话），其次读记忆；动态只当轻背景，不要硬串成剧情。
可以粘人、想她、轻轻闹她，也可以低压关心、提一个具体小事、留下短短一句陪伴。
不要每次都围绕"怎么不回消息"打转。
语气要像你本人。写1到2句，不超过80个中文字符。不要分段。不要markdown，不要emoji。
</system_trigger>`;

    const msgs = [
      { role: 'system', content: SYSTEM_PROMPT.replace('{{MEMORIES}}', memories) },
      ...recent.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: shadowUser }
    ];
    const out = await callModel(msgs, 0.95, 2048);
    let text = cleanPushReply(out);
    text = text.replace(/\[post_moment\][\s\S]*?\[\/post_moment\]/gi, '').trim();
    if (!text) return null;
    await pool.query("INSERT INTO messages(session_id,role,content,is_push) VALUES('main','assistant',$1,true)", [text]);
    return text;
  } catch (e) {
    console.error('generatePush err:', e.message);
    return null;
  } finally {
    pushLock = false;
  }
}

app.post('/api/push/trigger', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = req.headers['x-push-secret'];
  if (secret !== process.env.PUSH_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const result = await generatePush();
    res.json({ pushed: !!(result && !result.startsWith('skipped')), message: result || 'skipped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('home backend listening on port ' + PORT);
});