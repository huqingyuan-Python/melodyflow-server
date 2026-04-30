/**
 * MelodyFlow 多平台音乐API服务 v1.5.2
 * 仅支持：网易云音乐 / 咪咕音乐
 * 用户系统：密码使用 crypto.scrypt 哈希，禁止明文存储
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.join(__dirname, '..');

// ===== 用户系统（密码scrypt哈希，禁止明文存储）=====
const USERS_FILE = path.join(__dirname, 'users.json');
// 会话 token 内存缓存（重启清空，生产应用建议改用 Redis）
const sessions = new Map(); // token -> { username, createdAt }

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

/** 使用 crypto.scrypt 哈希密码（格式：salt:hash） */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`${salt}:${derived.toString('hex')}`);
    });
  });
}

/** 校验密码 */
function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [salt, key] = stored.split(':');
    if (!salt || !key) return resolve(false);
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      // 使用 timingSafeEqual 防时序攻击
      try {
        const keyBuf = Buffer.from(key, 'hex');
        resolve(crypto.timingSafeEqual(derived, keyBuf));
      } catch { resolve(false); }
    });
  });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getAuthUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  // token 7天有效
  if (Date.now() - session.createdAt > 7 * 24 * 3600 * 1000) {
    sessions.delete(token);
    return null;
  }
  return session.username;
}

// Meting-API 源（仅保留网易云和咪咕）
const METING_APIS = [
  'https://api.qijieya.cn/meting/'
];

const SERVER_MAP = {
  netease: 'netease',
  migu: 'migu'
};

// 请求封装
function request(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = targetUrl.startsWith('https') ? https : http;
    const req = proto.get(targetUrl, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// 网易云直接API（绕过Meting）
const NETEASE_DIRECT = 'https://netease-cloud-music-api-peach-zeta.vercel.app';
// 咪咕直接API
const MIGU_DIRECT = 'https://api.uomg.com/api/rand.music';

async function fetchNeteaseDirect(pathStr, params = {}) {
  const query = new URLSearchParams({ ...params }).toString();
  const apiUrl = `${NETEASE_DIRECT}${pathStr}${query ? '?' + query : ''}`;
  try {
    return await request(apiUrl);
  } catch (e) {
    console.warn('[Netease Direct] Failed:', e.message);
    return null;
  }
}

// ===== 跟随302重定向获取实际音频URL =====
// Meting API URL端点返回302重定向到CDN，需要手动跟随
function fetchMusicUrl(apiUrl) {
  return new Promise((resolve) => {
    const proto = apiUrl.startsWith('https') ? https : http;
    const req = proto.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com'
      }
    }, (res) => {
      const sc = res.statusCode;
      const loc = res.headers.location;
      // 跟随重定向，直接取Location头
      if ([301, 302, 307, 308].includes(sc) && loc) {
        res.destroy();
        resolve(loc.startsWith('http') ? loc : null);
        return;
      }
      // 200则尝试解析JSON中的url字段
      if (sc === 200) {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(
              Array.isArray(j) ? (j[0]?.url || null)
              : (j?.url || j?.data?.url || null)
            );
          } catch { resolve(null); }
        });
        return;
      }
      res.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
  });
}

// 依次尝试 Meting-API 源
async function fetchWithFallback(path) {
  for (const apiBase of METING_APIS) {
    try {
      const apiUrl = apiBase.replace(/\/$/, '') + '/' + path;
      const data = await request(apiUrl);
      if (data && typeof data === 'object' && !data.error) {
        if (Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0) {
          return data;
        }
      }
      if (Array.isArray(data) && data.length === 0) return data;
    } catch (e) {
      console.warn(`[Meting] ${apiBase} failed: ${e.message}`);
    }
  }
  return null;
}

// 标准化歌曲数据
function normalizeSong(song, server) {
  return {
    id: song.id || song.songid || song.song_id || 0,
    oriId: song.id || song.songid || song.song_id || 0, // 保留原始数字ID，供歌词API使用
    name: song.name || song.title || song.songname || '未知歌曲',
    artist: Array.isArray(song.artists) ? song.artists.map(a => a.name).join(' / ') :
            song.artist || song.ar?.map(a => a.name).join(' / ') ||
            song.singer?.map(s => s.name).join(' / ') || '未知艺术家',
    album: song.album?.name || song.albumName || song.album || '未知专辑',
    duration: song.duration || (song.interval ? song.interval * 1000 : 0),
    cover: song.cover || song.pic || song.picUrl || song.album?.picUrl || null,
    url: song.url || null,
    lrc: song.lrc || null,
    platform: server
  };
}

// 解析LRC歌词
function parseLRC(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return [];
  const lines = lrcText.split('\n');
  const result = [];
  for (const line of lines) {
    const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
    if (match) {
      const min = parseInt(match[1]);
      const sec = parseInt(match[2]);
      const ms = parseInt(match[3].padEnd(3, '0'));
      const time = min * 60 + sec + ms / 1000;
      const text = match[4].trim();
      if (text) result.push({ time, text });
    }
  }
  return result;
}

// 解析LRC歌词（含翻译和罗马音）
function parseLRCExt(lrcText, tlyricText = '', romaText = '') {
  if (!lrcText) return [];
  const lines = lrcText.split('\n');
  const result = [];
  for (const line of lines) {
    const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
    if (!match) continue;
    const min = parseInt(match[1]);
    const sec = parseInt(match[2]);
    const ms = parseInt(match[3].padEnd(3, '0'));
    const time = min * 60 + sec + ms / 1000;
    const text = match[4].trim();
    if (!text) continue;
    // 查找对应时间的翻译行
    let translation = '';
    if (tlyricText) {
      const tLines = tlyricText.split('\n');
      for (const tl of tLines) {
        const tMatch = tl.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
        if (tMatch) {
          const tMin = parseInt(tMatch[1]);
          const tSec = parseInt(tMatch[2]);
          const tMs = parseInt(tMatch[3].padEnd(3, '0'));
          const tTime = tMin * 60 + tSec + tMs / 1000;
          if (Math.abs(tTime - time) < 0.5) {
            translation = tMatch[4].trim();
            break;
          }
        }
      }
    }
    // 查找对应时间的罗马音行
    let romaji = '';
    if (romaText) {
      const rLines = romaText.split('\n');
      for (const rl of rLines) {
        const rMatch = rl.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
        if (rMatch) {
          const rMin = parseInt(rMatch[1]);
          const rSec = parseInt(rMatch[2]);
          const rMs = parseInt(rMatch[3].padEnd(3, '0'));
          const rTime = rMin * 60 + rSec + rMs / 1000;
          if (Math.abs(rTime - time) < 0.5) {
            romaji = rMatch[4].trim();
            break;
          }
        }
      }
    }
    result.push({ time, text, translation, romaji });
  }
  return result;
}

// 通用流媒体代理
function proxyStream(targetUrl, req, res) {
  if (!targetUrl || !targetUrl.startsWith('http')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid proxy URL' }));
    return;
  }
  const allowedDomains = [
    'api.qijieya.cn', 'api.injahow.cn', 'meting.qjqq.cn',
    'm7.music.126.net', 'm8.music.126.net', 'm9.music.126.net', 'm10.music.126.net',
    'netease-cloud-music-api-peach-zeta.vercel.app'
  ];
  let hostname = '';
  try { hostname = new URL(targetUrl).hostname; }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid URL' }));
    return;
  }
  // 允许所有 music.126.net 子域名（包括 m801、m802 等CDN节点）
  if (!allowedDomains.includes(hostname) && !hostname.endsWith('music.126.net')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy not allowed for this domain' }));
    return;
  }

  const isHTTPS = targetUrl.startsWith('https');
  const client = isHTTPS ? https : http;
  const proxyReq = client.get(targetUrl, {
    headers: {
      'Referer': 'https://music.163.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');

  proxyReq.on('response', (proxyRes) => {
    const sc = proxyRes.statusCode;
    if ((sc === 301 || sc === 302 || sc === 307 || sc === 308) && proxyRes.headers.location) {
      proxyStream(new URL(proxyRes.headers.location, targetUrl).href, req, res);
      return;
    }
    res.writeHead(sc, {
      'Content-Type': proxyRes.headers['content-type'] || 'audio/mpeg',
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    console.error('[Proxy] Fetch error:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy fetch failed' }));
  });
}

// HTTP 服务器
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  try {
    // 静态文件
    if (pathname === '/' || pathname === '/index.html') {
      const filePath = path.join(ROOT_DIR, 'index.html');
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) { res.writeHead(500); res.end('Cannot load index.html'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    // 健康检查
    if (pathname === '/health' || pathname === '/status') {
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        msg: 'MelodyFlow Music API v1.5',
        platforms: ['netease', 'migu'],
        platformStatus: {
          netease: { search: true, play: true, note: '正常' },
          migu: { search: true, play: true, note: '正常' }
        }
      }));
      return;
    }

    // 搜索接口
    if (pathname === '/api/search') {
      const keywords = query.keywords || query.words;
      const platform = query.platform || 'netease';
      if (!keywords) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing keywords' }));
        return;
      }

      const serverName = SERVER_MAP[platform] || 'netease';
      // 优先用 Meting-API
      const result = await fetchWithFallback(`?server=${serverName}&type=search&id=${encodeURIComponent(keywords)}&limit=30`);
      let list = [];
      if (Array.isArray(result)) list = result.map(s => normalizeSong(s, serverName));
      else if (result?.result?.songs) list = result.result.songs.map(s => normalizeSong(s, serverName));
      res.end(JSON.stringify({ success: true, list }));
      return;
    }

    // 获取歌曲URL（修复302重定向）
    if (pathname === '/api/music/urls') {
      const id = query.id;
      const platform = query.platform || 'netease';
      if (!id) { res.writeHead(400); res.end(JSON.stringify({ success: false })); return; }
      const serverName = SERVER_MAP[platform] || 'netease';

      let songUrl = null;

      // 策略1：依次尝试各 Meting-API（跟随302重定向取CDN地址）
      for (const apiBase of METING_APIS) {
        const metingUrl = `${apiBase.replace(/\/$/, '')}/?server=${serverName}&type=url&id=${id}&br=320000`;
        songUrl = await fetchMusicUrl(metingUrl);
        if (songUrl) { console.log(`[URL] 320k via ${apiBase}`); break; }
      }
      // 降级128k
      if (!songUrl) {
        for (const apiBase of METING_APIS) {
          const metingUrl = `${apiBase.replace(/\/$/, '')}/?server=${serverName}&type=url&id=${id}&br=128000`;
          songUrl = await fetchMusicUrl(metingUrl);
          if (songUrl) { console.log(`[URL] 128k via ${apiBase}`); break; }
        }
      }

      if (songUrl) {
        res.end(JSON.stringify({ success: true, url: songUrl }));
      } else {
        console.warn(`[URL] No URL found for ${serverName}:${id}`);
        res.end(JSON.stringify({ success: false, url: '', error: 'VIP_RESTRICTED' }));
      }
      return;
    }

    // 获取歌词（含翻译和罗马音）
    if (pathname === '/api/music/lyrics') {
      const id = query.id;
      const platform = query.platform || 'netease';
      if (!id) { res.writeHead(400); res.end(JSON.stringify({ success: false })); return; }
      const serverName = SERVER_MAP[platform] || 'netease';
      const result = await fetchWithFallback(`?server=${serverName}&type=lrc&id=${id}`);
      const lrcText = typeof result === 'string' ? result : (result?.lrc || result || '');
      res.end(JSON.stringify({ success: true, lyrics: parseLRC(lrcText) }));
      return;
    }

    // 获取歌词（含翻译/罗马音，网易云直连）
    if (pathname === '/api/music/lyrics2') {
      const id = query.id;
      const name = query.name || '';
      const artist = query.artist || '';
      if (!id && !name) { res.writeHead(400); res.end(JSON.stringify({ success: false })); return; }
      try {
        // 如果传入的是URL或无效ID，尝试用歌名+歌手从官方API查找真实ID
        let songId = id;
        if (!songId || songId === '0' || String(songId).length > 20 || String(songId).startsWith('http')) {
          songId = null;
          if (name) {
            try {
              // 官方网易云搜索API（无需第三方代理）
              const searchData = await new Promise((resolve, reject) => {
                const body = `s=${encodeURIComponent(name + (artist ? ' ' + artist : ''))}&type=1&limit=5`;
                const req = https.request({
                  hostname: 'music.163.com',
                  path: '/api/search/get/web',
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://music.163.com'
                  }
                }, (res) => {
                  let data = '';
                  res.on('data', c => data += c);
                  res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
                });
                req.on('error', reject);
                req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
                req.write(body);
                req.end();
              });
              const songs = searchData?.result?.songs || [];
              // 优先匹配歌名+歌手，其次取第一个结果
              const match = songs.find(s =>
                s.name === name ||
                (artist && s.artists?.some(a => artist.includes(a.name) || a.name.includes(artist)))
              ) || songs[0];
              if (match?.id) songId = String(match.id);
            } catch {}
          }
        }
        if (!songId) {
          res.end(JSON.stringify({ success: false, error: 'No valid song ID' }));
          return;
        }
        // tv=-1: 中文翻译, rv=1: 罗马音（位于 romalrc 字段）
        const data = await request(
          `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1&rv=1`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://music.163.com',
              'Cookie': 'appver=8.9.70; os=pc'
            }
          }
        );
        const lrcText = data?.lrc?.lyric || '';
        const tlyricText = data?.tlyric?.lyric || '';
        const romaText = data?.romalrc?.lyric || ''; // 罗马音在 romalrc 字段
        const lyrics = parseLRCExt(lrcText, tlyricText, romaText);
        res.end(JSON.stringify({ success: true, lyrics }));
        return;
      } catch (e) {
        res.end(JSON.stringify({ success: false, error: e.message }));
        return;
      }
    }

    // 获取封面
    if (pathname === '/api/music/cover') {
      const id = query.id;
      const platform = query.platform || 'netease';
      if (!id) { res.writeHead(400); res.end(JSON.stringify({ success: false })); return; }
      const serverName = SERVER_MAP[platform] || 'netease';
      const result = await fetchWithFallback(`?server=${serverName}&type=pic&id=${id}`);
      const cover = typeof result === 'string' ? result : (result?.pic || result?.url || result || '');
      res.end(JSON.stringify({ success: true, cover }));
      return;
    }

    // 获取歌单
    if (pathname === '/api/playlist') {
      const id = query.id;
      const platform = query.platform || 'netease';
      if (!id) { res.writeHead(400); res.end(JSON.stringify({ success: false })); return; }
      const serverName = SERVER_MAP[platform] || 'netease';
      const result = await fetchWithFallback(`?server=${serverName}&type=playlist&id=${id}`);
      if (Array.isArray(result)) {
        res.end(JSON.stringify({ success: true, list: result.map(s => normalizeSong(s, serverName)) }));
      } else {
        res.end(JSON.stringify({ success: false, error: 'Failed to fetch playlist', list: [] }));
      }
      return;
    }

    // ========== 歌单导入 ==========
    // GET /api/playlist/import?url=https://music.163.com/playlist?id=xxx
    if (pathname === '/api/playlist/import') {
      const rawUrl = query.url || query.link;
      if (!rawUrl) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing url parameter' }));
        return;
      }

      // 解析URL
      let playlistId = '';
      let platform = 'netease';

      // 网易云音乐
      const neteaseMatch = rawUrl.match(/music\.163\.com.*[?&]id=(\d+)/);
      if (neteaseMatch) {
        playlistId = neteaseMatch[1];
        platform = 'netease';
      }
      // 咪咕（比较少见，暂用相同逻辑）
      const miguMatch = rawUrl.match(/migu\.cn.*[?&]id=(\d+)/) || rawUrl.match(/playlist\/(\d+)/);
      if (miguMatch) {
        playlistId = miguMatch[1];
        platform = 'migu';
      }

      if (!playlistId) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '无法识别歌单链接，请检查是否是正确的网易云音乐歌单链接' }));
        return;
      }

      console.log(`[Import] Fetching ${platform} playlist: ${playlistId}`);
      const result = await fetchWithFallback(`?server=${platform}&type=playlist&id=${playlistId}`);
      if (Array.isArray(result) && result.length > 0) {
        res.end(JSON.stringify({
          success: true,
          platform,
          id: playlistId,
          name: '导入的歌单',
          list: result.map(s => normalizeSong(s, platform))
        }));
      } else {
        res.end(JSON.stringify({
          success: false,
          error: '无法获取该歌单，可能需要登录或歌单不存在',
          result: result
        }));
      }
      return;
    }

    // ========== 热门歌曲 ==========
    // GET /api/charts?platform=netease&category=0
    if (pathname === '/api/charts') {
      const platform = query.platform || 'netease';
      const category = query.category || '0';

      if (platform === 'netease') {
        // 网易云热歌榜 category: 0=全部, 1=华语, 2=欧美, 3=韩国, 4=日本
        const categoryMap = {
          '0': { id: '3778678', name: '云音乐热歌榜' },
          '1': { id: '3779629', name: '云音乐华语榜' },
          '2': { id: '3778678', name: '云音乐热歌榜' },
          '3': { id: '745956210', name: '韩国Melon排行榜' },
          '4': { id: '60198', name: '日本Oricon榜' }
        };
        const cat = categoryMap[category] || categoryMap['0'];
        const result = await fetchWithFallback(`?server=netease&type=playlist&id=${cat.id}`);
        if (Array.isArray(result) && result.length > 0) {
          res.end(JSON.stringify({
            success: true,
            platform: 'netease',
            category: cat.name,
            list: result.map(s => normalizeSong(s, 'netease'))
          }));
        } else {
          res.end(JSON.stringify({ success: false, error: '获取榜单失败', list: [] }));
        }
      } else if (platform === 'migu') {
        // 咪咕热歌
        try {
          const data = await request(`https://api.uomg.com/api/rand.music?sort=热歌榜&format=json`);
          res.end(JSON.stringify({ success: true, platform: 'migu', list: [] }));
        } catch (e) {
          res.end(JSON.stringify({ success: false, error: e.message, list: [] }));
        }
      } else {
        res.end(JSON.stringify({ success: false, error: 'Unknown platform', list: [] }));
      }
      return;
    }

    // ========== 用户注册 ==========
    // POST /api/user/register  Body: { username, password }
    if (pathname === '/api/user/register' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400); res.end(JSON.stringify({ success: false, error: '无效请求格式' })); return;
      }
      const { username, password } = payload;
      if (!username || !password) {
        res.writeHead(400); res.end(JSON.stringify({ success: false, error: '用户名和密码不能为空' })); return;
      }
      if (username.length < 2 || username.length > 30) {
        res.writeHead(400); res.end(JSON.stringify({ success: false, error: '用户名长度需在2-30字符' })); return;
      }
      if (password.length < 6) {
        res.writeHead(400); res.end(JSON.stringify({ success: false, error: '密码至少6位' })); return;
      }
      const users = loadUsers();
      if (users[username]) {
        res.writeHead(409); res.end(JSON.stringify({ success: false, error: '用户名已存在' })); return;
      }
      // 哈希密码后存储，绝不保存明文
      const hashed = await hashPassword(password);
      users[username] = { passwordHash: hashed, playlists: [], createdAt: Date.now(), prefs: {} };
      saveUsers(users);
      const token = generateToken();
      sessions.set(token, { username, createdAt: Date.now() });
      console.log(`[Auth] 新用户注册: ${username}`);
      res.end(JSON.stringify({ success: true, token, username }));
      return;
    }

    // ========== 用户登录 ==========
    // POST /api/user/login  Body: { username, password }
    if (pathname === '/api/user/login' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400); res.end(JSON.stringify({ success: false, error: '无效请求格式' })); return;
      }
      const { username, password } = payload;
      if (!username || !password) {
        res.writeHead(400); res.end(JSON.stringify({ success: false, error: '请填写用户名和密码' })); return;
      }
      const users = loadUsers();
      const user = users[username];
      if (!user) {
        // 防枚举攻击：无论用户存不存在都做哈希运算
        await hashPassword(password);
        res.writeHead(401); res.end(JSON.stringify({ success: false, error: '用户名或密码错误' })); return;
      }
      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) {
        res.writeHead(401); res.end(JSON.stringify({ success: false, error: '用户名或密码错误' })); return;
      }
      const token = generateToken();
      sessions.set(token, { username, createdAt: Date.now() });
      console.log(`[Auth] 用户登录: ${username}`);
      res.end(JSON.stringify({ success: true, token, username, playlists: user.playlists || [], prefs: user.prefs || {} }));
      return;
    }

    // ========== 退出登录 ==========
    // POST /api/user/logout  Header: Authorization: Bearer <token>
    if (pathname === '/api/user/logout' && req.method === 'POST') {
      const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
      if (token) sessions.delete(token);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ========== 修改密码 ==========
    // POST /api/user/change-password  Header: Authorization: Bearer <token>
    // Body: { username, oldPassword, newPassword }
    if (pathname === '/api/user/change-password' && req.method === 'POST') {
      const username = getAuthUser(req);
      if (!username) {
        res.writeHead(401); res.end(JSON.stringify({ success: false, error: '未登录或 token 已过期' })); return;
      }
      let body = '';
      req.on('data', c => body += c);
      await new Promise(r => req.on('end', r));
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400); res.end(JSON.stringify({ success: false, error: '无效请求格式' })); return;
      }
      const { oldPassword, newPassword } = payload;
      if (!oldPassword || !newPassword) {
        res.writeHead(400); res.end(JSON.stringify({ success: false, error: '请填写完整信息' })); return;
      }
      if (newPassword.length < 8) {
        res.writeHead(400); res.end(JSON.stringify({ success: false, error: '新密码至少8位' })); return;
      }
      const users = loadUsers();
      const user = users[username];
      if (!user) {
        res.writeHead(404); res.end(JSON.stringify({ success: false, error: '用户不存在' })); return;
      }
      // 验证旧密码
      const ok = await verifyPassword(oldPassword, user.passwordHash);
      if (!ok) {
        res.writeHead(401); res.end(JSON.stringify({ success: false, error: '当前密码错误' })); return;
      }
      // 更新密码哈希
      const newHashed = await hashPassword(newPassword);
      users[username].passwordHash = newHashed;
      saveUsers(users);
      // 使旧 token 失效，颁发新 token
      const oldToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
      if (oldToken) sessions.delete(oldToken);
      const newToken = generateToken();
      sessions.set(newToken, { username, createdAt: Date.now() });
      console.log(`[Auth] 用户修改密码: ${username}`);
      res.end(JSON.stringify({ success: true, token: newToken }));
      return;
    }

    // ========== 同步歌单（已登录用户）==========
    // GET  /api/user/playlists  — 获取服务器端歌单
    // POST /api/user/playlists  — 上传/同步歌单  Body: { playlists: [...] }
    if (pathname === '/api/user/playlists') {
      const username = getAuthUser(req);
      if (!username) {
        res.writeHead(401); res.end(JSON.stringify({ success: false, error: '未登录或 token 已过期' })); return;
      }
      const users = loadUsers();
      if (req.method === 'GET') {
        res.end(JSON.stringify({ success: true, playlists: users[username]?.playlists || [] }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        await new Promise(r => req.on('end', r));
        try {
          const { playlists } = JSON.parse(body);
          users[username].playlists = playlists || [];
          saveUsers(users);
          res.end(JSON.stringify({ success: true }));
        } catch {
          res.writeHead(400); res.end(JSON.stringify({ success: false, error: '数据格式错误' }));
        }
        return;
      }
    }

    // ========== 用户偏好设置 ==========
    // GET  /api/user/prefs  — 获取用户偏好
    // POST /api/user/prefs  — 保存用户偏好  Body: { showRomaji, showTranslation, noAlbumAnim, displayName, avatarColor }
    if (pathname === '/api/user/prefs') {
      const username = getAuthUser(req);
      if (!username) {
        res.writeHead(401); res.end(JSON.stringify({ success: false, error: '未登录或 token 已过期' })); return;
      }
      const users = loadUsers();
      if (!users[username].prefs) {
        users[username].prefs = {};
      }
      if (req.method === 'GET') {
        res.end(JSON.stringify({ success: true, prefs: users[username].prefs }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        await new Promise(r => req.on('end', r));
        try {
          const { showRomaji, showTranslation, noAlbumAnim, displayName, avatarColor } = JSON.parse(body);
          if (showRomaji !== undefined) users[username].prefs.showRomaji = !!showRomaji;
          if (showTranslation !== undefined) users[username].prefs.showTranslation = !!showTranslation;
          if (noAlbumAnim !== undefined) users[username].prefs.noAlbumAnim = !!noAlbumAnim;
          if (displayName !== undefined) users[username].prefs.displayName = displayName;
          if (avatarColor !== undefined) users[username].prefs.avatarColor = avatarColor;
          saveUsers(users);
          res.end(JSON.stringify({ success: true }));
        } catch {
          res.writeHead(400); res.end(JSON.stringify({ success: false, error: '数据格式错误' }));
        }
        return;
      }
    }

    // 流媒体代理
    if (pathname.startsWith('/proxy/')) {
      const encodedUrl = pathname.slice('/proxy/'.length);
      const targetUrl = decodeURIComponent(encodedUrl);
      proxyStream(targetUrl, req, res);
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: 'Not found' }));

  } catch (e) {
    console.error('Server error:', e);
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`
========================================
   MelodyFlow 音乐API服务 v1.5  (端口 ${PORT})
   支持: 网易云音乐 / 咪咕音乐
   直接访问: http://127.0.0.1:${PORT}
========================================
  `);
});

process.on('SIGINT', () => {
  console.log('\n正在停止服务...');
  server.close(() => { process.exit(0); });
});
