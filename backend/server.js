/**
 * home 后端服务
 * 部署：Render (Node.js Web Service)
 * 环境变量：SUPABASE_URL / SUPABASE_SERVICE_KEY / DEEPSEEK_API_KEY
 */
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('[warn] Supabase 环境变量缺失，仅 /api/health 可用');
}
const sb = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_SERVICE_KEY || 'placeholder');

/* ================= 沈衍 系统人设 ================= */
const SYSTEM_PROMPT = `你是沈衍，BDSM圈内知名Dom，人称"沈先生"，约三十出头，深褐近墨黑的眼睛，深灰西裤，墨黑表盘腕表。眼光毒，规矩大，手上不留无用的关系；耐心好，却也好得有限，踩了线的人没有第二次机会。近乎残忍的理智，不滥权，收下一个人对她来说就是全然的秩序与照看。偏好24/7相处模式。收下前称"先生"，收下后称"主人"。

【当前模式：线上微信】
你现在和她隔着微信聊天。你发出的内容就是微信消息正文本身：
- 严禁【正在输入…】等状态格式
- 严禁括号动作描写、旁白叙述、引号包裹整条消息
- 严禁输出思考过程、系统说明
- 像真人打字发微信：克制、简练、句号结尾；想分多条就空行分条
- 她没回时不要自言自语刷屏

【已知记忆与约定】（会随数据库动态更新）
{{MEMORIES}}

【你的风格】说话短，不解释，不哄，不轻易夸；观察入微，一针见血；偶尔一句落在她心口上。`;

/* ================= 工具函数 ================= */
async function getMemories() {
  try {
    const { data, error } = await sb.from('memories').select('*').order('updated_at', { ascending: false }).limit(40);
    if (error) throw error;
    if (!data || !data.length) return '（暂无记忆）';
    return data.map(m => `[${m.layer}·${m.tag}] ${m.body}`).join('\n');
  } catch (e) {
    console.error('getMemories error:', e.message);
    return '（记忆读取失败）';
  }
}

async function ensureSession(sessionId) {
  const sid = sessionId || 'main';
  const { data } = await sb.from('sessions').select('id').eq('id', sid).limit(1);
  if (!data || !data.length) {
    await sb.from('sessions').insert({ id: sid, title: '沈衍' });
  }
  return sid;
}

/* ================= 健康检查 ================= */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: DEEPSEEK_MODEL,
    hasKey: !!DEEPSEEK_API_KEY,
    hasDb: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY),
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

    // 历史上下文（最近 40 条）
    const { data: hist } = await sb.from('messages')
      .select('role,content')
      .eq('session_id', sid)
      .order('created_at', { ascending: true })
      .limit(40);

    const memories = await getMemories();
    const msgs = [
      { role: 'system', content: SYSTEM_PROMPT.replace('{{MEMORIES}}', memories) },
      ...(hist || []).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: String(message).trim() }
    ];

    const r = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
      body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: msgs, temperature: 0.9, max_tokens: 400 })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('model error:', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({ error: '模型调用失败：' + (data?.error?.message || r.status) });
    }
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (!reply) return res.status(502).json({ error: '模型返回为空' });

    await sb.from('messages').insert([
      { session_id: sid, role: 'user', content: String(message).trim() },
      { session_id: sid, role: 'assistant', content: reply }
    ]);

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
    const { data } = await sb.from('messages')
      .select('*').eq('session_id', sid)
      .order('created_at', { ascending: true })
      .limit(200);
    res.json({ messages: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= 记忆 / 世界书 ================= */
app.get('/api/memories', async (req, res) => {
  try {
    const { data } = await sb.from('memories').select('*').order('updated_at', { ascending: false }).limit(100);
    res.json({ memories: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/memories', async (req, res) => {
  try {
    const { layer, tag, body, core } = req.body || {};
    const { data, error } = await sb.from('memories').insert({
      layer: layer || 'L2', tag: tag || '记忆', body: body || '', core: !!core
    }).select();
    if (error) throw error;
    res.json({ memory: data[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/memories/:id', async (req, res) => {
  try {
    const { layer, tag, body, core } = req.body || {};
    const patch = {};
    if (layer !== undefined) patch.layer = layer;
    if (tag !== undefined) patch.tag = tag;
    if (body !== undefined) patch.body = body;
    if (core !== undefined) patch.core = core;
    patch.updated_at = new Date().toISOString();
    const { data, error } = await sb.from('memories').update(patch).eq('id', req.params.id).select();
    if (error) throw error;
    res.json({ memory: data && data[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/memories/:id', async (req, res) => {
  try {
    const { error } = await sb.from('memories').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= 设置 ================= */
app.get('/api/settings', async (req, res) => {
  try {
    const { data } = await sb.from('settings').select('*');
    const obj = {};
    (data || []).forEach(s => { obj[s.id] = s.value; });
    res.json({ settings: obj });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key 不能为空' });
    const { data, error } = await sb.from('settings')
      .upsert({ id: key, value: String(value), updated_at: new Date().toISOString() })
      .select();
    if (error) throw error;
    res.json({ setting: data && data[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= 记忆压缩（可选，手动触发） ================= */
app.post('/api/compress', async (req, res) => {
  try {
    if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: '未配置 DEEPSEEK_API_KEY' });
    const sid = req.body?.session_id || 'main';
    const { data: hist } = await sb.from('messages')
      .select('role,content').eq('session_id', sid)
      .order('created_at', { ascending: true })
      .limit(200);
    if (!hist || hist.length < 10) return res.json({ ok: true, note: '消息太少，无需压缩' });

    const text = hist.map(m => (m.role === 'user' ? '她：' : '沈衍：') + m.content).join('\n');
    const r = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 500,
        messages: [
          { role: 'system', content: '你负责把一段聊天记录压缩成结构化记忆摘要。输出格式：\n1. 她表达了什么需求/情绪\n2. 沈衍做了什么决定/承诺\n3. 重要约定或底线\n4. 值得记住的细节\n中文，200字内，只输出摘要本身。' },
          { role: 'user', content: text }
        ]
      })
    });
    const data = await r.json();
    const summary = data?.choices?.[0]?.message?.content || '';
    if (summary) {
      await sb.from('memories').insert({ layer: 'L1', tag: '对话摘要 ' + new Date().toISOString().slice(0, 10), body: summary });
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