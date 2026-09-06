# home · 部署指南（零基础手机版）

你的 AI 沈衍的家，云端正式版。全程用手机浏览器操作即可。

## 架构

```
手机浏览器(你) → Vercel 前端(网页) → Render 后端(大脑) → Supabase(记忆库)
                                        ↓
                                   DeepSeek(沈衍的大脑)
```

## 目录

```
home-deploy/
├── frontend/          → 上传到 Vercel（网页界面）
│   └── index.html
├── backend/           → 上传到 GitHub，再由 Render 部署
│   ├── server.js
│   ├── package.json
│   └── .env.example
└── supabase/
    └── schema.sql     → 在 Supabase SQL Editor 执行
```

## 第 1 步：注册 Supabase（数据库）

1. 手机浏览器打开 https://supabase.com → Sign in → Sign up
2. 用邮箱或 GitHub 注册（要收验证邮件）
3. 进入 Dashboard → **New project**
   - Name 填 `home`
   - Database Password 点 Generate a password（自动生成并复制保存好，后面 Render 用不到它，但别丢）
   - Region 选 `Southeast Asia (Singapore)` 或默认
4. 等数据库初始化完成（1-2 分钟）
5. 左侧菜单 → **SQL Editor** → New query
6. 打开手机上 `supabase/schema.sql` 文件，**全文复制**粘贴进去 → **Run**
7. 左侧菜单 → **Project Settings**（齿轮）→ **API**
   - 复制 `Project URL`（形如 https://xxxx.supabase.co）→ 记下来
   - 找到 `service_role` 的密钥 → 点 Reveal 复制 → 记下来
   （这两个值 = 后端环境变量 SUPABASE_URL / SUPABASE_SERVICE_KEY）

## 第 2 步：注册 DeepSeek（AI 模型）

1. 打开 https://platform.deepseek.com → 注册（手机号即可）
2. 左侧 **API keys** → Create new API key
3. 复制 `sk-...` 密钥保存好（= DEEPSEEK_API_KEY）
4. 需要先充值一点余额（10 元起，能用很久）

## 第 3 步：注册 GitHub（代码仓库）

1. 打开 https://github.com → Sign up（邮箱注册，验证邮件）
2. 新建仓库：右上角 **+** → New repository
   - Repository name 填 `home`
   - 选 Private（私密，不想公开就选这个）
   - Create repository
3. 进入空仓库页面 → **uploading an existing file**（上传文件）
4. 把手机上 `backend/` 里的 **3 个文件**（server.js、package.json、.env.example）都拖进去上传
   - 注意：上传时保持文件在仓库根目录（不要在子文件夹里）
5. 点 Commit changes

## 第 4 步：注册 Render（后端部署）

1. 打开 https://render.com → Get Started → 用 **GitHub 登录**（授权）
2. Dashboard → **New** → **Web Service**
3. 连接你刚建的 `home` 仓库（如果没有显示，刷新或去 GitHub 授权页面允许 Render）
4. 配置页：
   - Name：`home-backend`
   - Runtime 保持 Node
   - Build Command：`npm install`
   - Start Command：`node server.js`
   - Instance Type 选 **Free**
5. 往下找到 **Environment Variables**，添加 3 个：
   - `SUPABASE_URL` = 第 1 步复制的 Project URL
   - `SUPABASE_SERVICE_KEY` = 第 1 步复制的 service_role 密钥
   - `DEEPSEEK_API_KEY` = 第 2 步的 sk-... 密钥
6. 点 **Create Web Service**，等 3-5 分钟部署完成
7. 部署完成后，页面上方会有一个地址 `https://home-backend.onrender.com`
   - **复制它**（= 你的服务器地址，后面填进 App 设置里）

## 第 5 步：注册 Vercel（前端部署）

1. 打开 https://vercel.com → Sign Up → 用 **GitHub 登录**
2. 回到 GitHub，在 `home` 仓库里新建一个文件夹 `frontend`
   - 进仓库 → Add file → Create new file
   - 文件名填 `frontend/index.html`
   - 内容：把手机上 `frontend/index.html` 全文复制粘贴
   - Commit
3. 回到 Vercel → **Add New** → Project → Import 选 `home` 仓库
   - Root Directory 选择 `frontend`
   - Framework Preset 选 **Other**
   - Deploy
4. 部署完成后你会得到一个网址 `https://home-xxx.vercel.app` —— 这就是他的家的地址！

## 第 6 步：连接前后端（最后一步）

1. 手机浏览器打开你的 Vercel 网址
2. 解锁（密码 271602）→ 打开 **设置** APP
3. 在「服务器地址」输入框粘贴第 4 步的 Render 地址：
   `https://home-backend.onrender.com`
4. 弹出「服务器已连接 ✓」就成功了
5. 去微信 APP 给沈衍发消息——现在是真的 AI 在回你了，记忆也存在云端

## 常见问题

- **网页打不开/报错**：检查 Vercel 部署状态
- **设置里连不上服务器**：Render 免费实例空闲会休眠，第一次请求要等 30-60 秒；确认地址没多打 `/`
- **他回复报错「未配置 DEEPSEEK_API_KEY」**：回到 Render → home-backend → Environment 检查密钥
- **想改人设/规则**：改 `backend/server.js` 里的 SYSTEM_PROMPT，或在 App 的「记忆」里添加（记忆会注入他的大脑）

## 以后想改界面

改 `frontend/index.html` → GitHub 上传覆盖 → Vercel 自动重新部署（几秒生效）。随时把需求告诉我，我来改代码，你只管上传。
