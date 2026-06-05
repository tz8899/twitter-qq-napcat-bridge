#!/usr/bin/env node
/**
 * X/Twitter → QQ 转发桥
 * 通过 twapi 抓取推特 → Napcat 推送到 QQ
 * 支持文字 + 图片
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "config.json");
const STATE_FILE = path.join(__dirname, "state.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error("缺少 config.json，请先复制 config.example.json 并填写运行配置。");
      process.exit(1);
    }
    throw error;
  }
}

const cfg = loadConfig();
const IMG_CACHE = cfg.imageCacheHostPath || path.join(__dirname, "cache");
const IMG_CONTAINER = cfg.imageCacheContainerPath || IMG_CACHE;

fs.mkdirSync(IMG_CACHE, { recursive: true });

let state = loadState();

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { lastIds: {} }; }
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// 通过 twapi 获取用户推文
function fetchTweets(username) {
  return new Promise((resolve, reject) => {
    http.get(`${cfg.twapiUrl}/api/user/${username}/tweets?count=${cfg.fetchCount}`, (res) => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.detail) reject(new Error(json.detail));
          else resolve(json.tweets || []);
        } catch(e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// 下载图片（Twitter CDN 需要特殊 headers）
function normalizeTwitterImageUrl(url) {
  const mediaUrl = url.replace("/orig/media/", "/media/");
  if (mediaUrl.includes("?")) return mediaUrl;
  if (/\/media\/[^/?]+\.[a-zA-Z0-9]+$/.test(mediaUrl)) return mediaUrl;
  return `${mediaUrl}?format=jpg&name=medium`;
}

function imageExtensionFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\.(jpg|jpeg|png|gif|webp)$/i);
    if (!match) return ".jpg";
    return match[1].toLowerCase() === "jpeg" ? ".jpg" : `.${match[1].toLowerCase()}`;
  } catch {
    return ".jpg";
  }
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const imgUrl = normalizeTwitterImageUrl(url);
    const filename = "tw_" + Date.now() + "_" + Math.random().toString(36).slice(2,8) + imageExtensionFromUrl(imgUrl);
    const destPath = path.join(IMG_CACHE, filename);

    const requestImage = (targetUrl, redirectCount = 0) => {
      const client = targetUrl.startsWith("https") ? https : http;
      const req = client.get(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": "https://twitter.com/",
          "Origin": "https://twitter.com",
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= 5) {
            res.resume();
            reject(new Error("图片下载失败: 重定向过多"));
            return;
          }
          const nextUrl = new URL(res.headers.location, targetUrl).toString();
          res.resume();
          requestImage(nextUrl, redirectCount + 1);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`图片下载失败: HTTP ${res.statusCode}`));
          return;
        }

        const contentType = String(res.headers["content-type"] || "");
        if (!contentType.startsWith("image/")) {
          res.resume();
          reject(new Error(`图片下载失败: 返回类型不是图片 ${contentType || "unknown"}`));
          return;
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            fs.stat(destPath, (err, stat) => {
              if (err) {
                reject(err);
                return;
              }
              if (!stat.size) {
                fs.rm(destPath, { force: true }, () => reject(new Error("图片下载失败: 空文件")));
                return;
              }
              resolve(path.join(IMG_CONTAINER, filename));
            });
          });
        });
        file.on("error", err => fs.rm(destPath, { force: true }, () => reject(err)));
      });

      req.setTimeout(15000, () => req.destroy(new Error("图片下载超时")));
      req.on("error", err => fs.rm(destPath, { force: true }, () => reject(err)));
    };

    requestImage(imgUrl);
  });
}

// 推送到 QQ
function sendQQ(targetType, targetId, message) {
  return new Promise((resolve, reject) => {
    const apiPath = targetType === "group" ? "/send_group_msg" : "/send_private_msg";
    const idField = targetType === "group" ? "group_id" : "user_id";
    const body = JSON.stringify({ [idField]: parseInt(targetId), message, auto_escape: false });
    const apiUrl = new URL(cfg.napcatApiUrl + apiPath + "?access_token=" + cfg.napcatToken);
    const client = apiUrl.protocol === "https:" ? https : http;
    const req = client.request({
      hostname: apiUrl.hostname, port: apiUrl.port, path: apiUrl.pathname + apiUrl.search, method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (j.status === "ok") {
            resolve();
            return;
          }
          reject(new Error(j.wording || j.message || j.msg || d));
        } catch { reject(new Error("parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function formatTweetText(username, tweet) {
  const time = tweet.date ? tweet.date.replace("UTC", "北京时间") : "未知";
  let text = tweet.text || "";
  if (text.length > 500) text = text.substring(0, 500) + "...";
  return `🐦 @${username} (${tweet.display_name || ""})\n${text}\n🕐 ${time}\n❤️ ${tweet.likes || 0}  💬 ${tweet.replies || 0}  🔄 ${tweet.retweets || 0}\n🔗 https://x.com/${username}/status/${tweet.id}`;
}

async function pushTweet(username, tweet, targetType, targetId) {
  const timeStr = new Date().toLocaleTimeString("zh-CN", {timeZone:"Asia/Shanghai"});
  const preview = tweet.text ? tweet.text.substring(0, 50) : "";
  console.log(`[${timeStr}] 🐦 @${username}: ${preview}...`);

  try {
    const images = tweet.images || [];
    const textMsg = formatTweetText(username, tweet);
    const message = [
      { type: "text", data: { text: textMsg + (images.length ? "\n" : "") } },
    ];

    for (const imgUrl of images) {
      try {
        console.log(`  📷 下载图片: ${imgUrl.substring(0,60)}...`);
        const localPath = await downloadImage(imgUrl);
        message.push({ type: "image", data: { file: localPath } });
      } catch(e) {
        console.log(`  ⚠️ 图片失败: ${e.message}`);
      }
    }

    await sendQQ(targetType, targetId, message);
    const imageCount = message.filter(segment => segment.type === "image").length;
    console.log(imageCount > 0 ? `  ✅ 图文发送成功（${imageCount}张图片）` : `  ✅ 文字发送成功`);
  } catch(e) {
    console.log(`  ❌ 推送失败: ${e.message}`);
  }
}

async function checkUser(username, targetType, targetId) {
  try {
    const tweets = await fetchTweets(username);
    if (!tweets.length) return;

    const lastId = state.lastIds[username] || 0;
    const newTweets = tweets.filter(t => {
      const id = parseInt(t.id) || 0;
      return id > lastId;
    });

    if (!newTweets.length) return;

    // 按时间正序推送
    newTweets.sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));

    for (const tweet of newTweets) {
      await pushTweet(username, tweet, targetType, targetId);
      state.lastIds[username] = Math.max(state.lastIds[username] || 0, parseInt(tweet.id) || 0);
      saveState();
      // 间隔避免限流
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch(e) {
    console.log(`❌ @${username} 抓取失败: ${e.message}`);
  }
}

async function main() {
  console.log("🚀 X/Twitter → QQ 转发桥启动！");
  console.log(`🔗 twapi: ${cfg.twapiUrl}`);
  console.log(`📡 Napcat: ${cfg.napcatApiUrl}`);
  console.log(`⏰ 检查间隔: ${cfg.intervalSeconds}秒`);
  console.log(`📋 监控: ${cfg.monitors.map(m => `@${m.username}`).join(", ")}`);
  console.log(`📅 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n`);

  // 初始化
  for (const m of cfg.monitors) {
    try {
      const tweets = await fetchTweets(m.username);
      if (tweets.length > 0) {
        state.lastIds[m.username] = Math.max(...tweets.map(t => parseInt(t.id) || 0));
        console.log(`📌 @${m.username} 初始化，最新ID: ${state.lastIds[m.username]}`);
      }
    } catch(e) { console.log(`⚠️ @${m.username} 初始化失败: ${e.message}`); }
  }
  saveState();
  console.log("📌 等待新推文...\n");

  setInterval(async () => {
    for (const m of cfg.monitors) {
      await checkUser(m.username, m.targetType, m.targetId);
    }
  }, cfg.intervalSeconds * 1000);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
