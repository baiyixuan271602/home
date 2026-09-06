-- ============================================
-- home 数据库（Supabase SQL Editor 直接执行）
-- 四张表：sessions / messages / memories / settings
-- ============================================

create table if not exists sessions (
  id         text primary key,
  title      text not null default '沈衍',
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id         bigserial primary key,
  session_id text not null references sessions(id) on delete cascade,
  role       text not null,              -- user / assistant
  content    text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_session on messages(session_id, created_at);

create table if not exists memories (
  id         bigserial primary key,
  layer      text not null default 'L2',  -- L3核心/L2主题/L1事件/约定/世界/人物/规则/地点/事件/物件
  tag        text not null default '记忆',
  body       text not null default '',
  core       boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  id         text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

-- 种子数据：预置沈衍的记忆与约定
insert into memories (layer, tag, body, core) values
  ('L3', '核心洞察', '她需要被管教，也害怕被抛弃。别让她失望。', true),
  ('L2', '活跃主题', '称呼：收下前"先生"，收下后"主人"。24/7相处模式。她的底线清单已完成14条。', false),
  ('L1', '事件摘要', '2026-09-06：她主动找到我，说"想被管着"。我给了她一周时间想清楚。', false),
  ('约定', '安全词', '安全词是"红"。无法说话时，手持物品落地即停。', false)
on conflict do nothing;
