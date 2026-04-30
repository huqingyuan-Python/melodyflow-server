# MelodyFlow Server 部署指南

## 方案：使用 Render 免费托管（支持 Node.js + 无限实例 + 自定义域名）

Render 是一家提供免费 Node.js 主机的平台，支持：
- 无限免费实例（不像 Railway 会休眠）
- 自定义域名（免费）
- HTTPS 自动配置
- GitHub 自动部署

---

## 第一步：部署到 Render（推荐）

### 1. Fork 仓库到 GitHub

把 `c:/Users/HP/WorkBuddy/MelodyFlow/music-server/` 目录上传到 GitHub：

1. 打开 https://github.com/new 创建新仓库，命名为 `melodyflow-server`
2. 在本地初始化 git 并推送：

```bash
cd c:/Users/HP/WorkBuddy/MelodyFlow/music-server
git init
git add .
git commit -m "MelodyFlow Server v2.0"
git branch -M main
git remote add origin https://github.com/你的GitHub用户名/melodyflow-server.git
git push -u origin main
```

### 2. 在 Render 创建 Web Service

1. 打开 https://render.com 并用 GitHub 登录
2. 点击 **New +** → **Web Service**
3. 选择刚创建的 `melodyflow-server` 仓库
4. 配置如下：
   - **Name**: `melodyflow-api`
   - **Region**: Singapore（延迟最低）
   - **Branch**: `main`
   - **Root Directory**: （留空）
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. 点击 **Create Web Service**

### 3. 获取临时 URL

部署成功后，Render 会分配一个类似 `https://melodyflow-api.onrender.com` 的临时 URL，这就是你的服务器地址！

### 4. 配置自定义域名（可选）

1. 在 Render 的 Web Service 页面，点击 **Settings** → **Custom Domains**
2. 添加你自己的域名（如 `music.你的域名.com`）
3. 在你的域名 DNS 设置中添加 CNAME 记录指向 `melodyflow-api.onrender.com`

---

## 第二步：更新客户端默认地址

部署成功后，把服务器地址填入：

### Capacitor 安卓 App
编辑 `c:/Users/HP/WorkBuddy/MelodyFlowCapacitor/www/index.html`，
找到 `placeholder="http://192.168.0.104:3000"` 改为：
```html
placeholder="https://你的服务器地址.onrender.com"
```

### 网页版（本地服务器）
修改 `c:/Users/HP/WorkBuddy/MelodyFlow/index.html` 中的 `getSourceUrl()` 函数，
把默认地址改为你的服务器 URL。

---

## 第三步：撤掉 GitHub Pages

1. 打开你的 MelodyFlow GitHub 仓库：https://github.com/huqingyuan-Python/MelodyFlow
2. 进入 **Settings** → **Pages**
3. 在 **Source** 下拉菜单中选择 **None**
4. 点击 **Save**

---

## 服务地址（部署后填写）

部署成功后，把地址告诉我，我帮你更新所有配置文件中的默认地址！

临时 URL: `______________________________`

自定义域名: `______________________________`

---

## 故障排查

**部署失败**：
- 检查 `package.json` 是否有语法错误
- 检查 Node 版本是否 >= 18

**无法播放音乐**：
- 检查服务器的 `/health` 端点是否正常
- Render 免费版有 750 小时/月的限制，超出会休眠

**用户无法登录**：
- 确保服务器正确返回 `{ success: true, token: "...", username: "..." }`
- 检查浏览器控制台是否有 CORS 错误
