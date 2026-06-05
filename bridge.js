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

function normalizeTarget(target) {
  const targetType = target && target.targetType;
  const targetId = target && target.targetId !== undefined ? String(target.targetId).trim() : "";
  if (!["group", "private"].includes(targetType) || !targetId) return null;
  return { targetType, targetId };
}

function normalizeMonitorTargets(monitor) {
  const targets = Array.isArray(monitor.targets) ? monitor.targets.map(normalizeTarget).filter(Boolean) : [];
  const singleTarget = normalizeTarget(monitor);
  if (singleTarget) targets.push(singleTarget);
  return targets;
}

function dedupeTargets(targets) {
  return [...new Map(targets.map(target => [`${target.targetType}:${target.targetId}`, target])).values()];
}

function buildMonitorJobs(monitors) {
  const jobs = new Map();
  for (const monitor of monitors || []) {
    if (!monitor.username) continue;
    if (!jobs.has(monitor.username)) jobs.set(monitor.username, { username: monitor.username, targets: [] });
    jobs.get(monitor.username).targets.push(...normalizeMonitorTargets(monitor));
  }
  return [...jobs.values()].map(job => ({ ...job, targets: dedupeTargets(job.targets) }));
}

function targetLabel(target) {
  return target.targetType === "group" ? `群 ${target.targetId}` : `私聊 ${target.targetId}`;
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

async function buildTweetMessage(username, tweet) {
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

  return message;
}

async function pushTweet(username, tweet, targets) {
  const timeStr = new Date().toLocaleTimeString("zh-CN", {timeZone:"Asia/Shanghai"});
  const preview = tweet.text ? tweet.text.substring(0, 50) : "";
  console.log(`[${timeStr}] 🐦 @${username}: ${preview}...`);

  const validTargets = dedupeTargets((targets || []).map(normalizeTarget).filter(Boolean));
  if (!validTargets.length) {
    console.log("  ⚠️ 没有可用推送目标");
    return [];
  }

  const message = await buildTweetMessage(username, tweet);
  const imageCount = message.filter(segment => segment.type === "image").length;
  const results = [];

  for (const target of validTargets) {
    try {
      await sendQQ(target.targetType, target.targetId, message);
      results.push({ target, ok: true });
      console.log(imageCount > 0 ? `  ✅ ${targetLabel(target)} 图文发送成功（${imageCount}张图片）` : `  ✅ ${targetLabel(target)} 文字发送成功`);
    } catch(e) {
      results.push({ target, ok: false });
      console.log(`  ❌ ${targetLabel(target)} 推送失败: ${e.message}`);
    }
  }

  return results;
}

function stateKey(username, target) {
  return `${username}:${target.targetType}:${target.targetId}`;
}

function getLastId(username, target) {
  return state.lastIds[stateKey(username, target)] || state.lastIds[username] || 0;
}

function setLastId(username, target, tweetId) {
  const key = stateKey(username, target);
  state.lastIds[key] = Math.max(state.lastIds[key] || 0, tweetId);
}

async function checkUser(job) {
  try {
    const tweets = await fetchTweets(job.username);
    if (!tweets.length) return;
    if (!job.targets.length) {
      console.log(`⚠️ @${job.username} 没有配置推送目标`);
      return;
    }

    const newTweets = tweets
      .filter(tweet => job.targets.some(target => (parseInt(tweet.id) || 0) > getLastId(job.username, target)))
      .sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));

    for (const tweet of newTweets) {
      const tweetId = parseInt(tweet.id) || 0;
      const pendingTargets = job.targets.filter(target => tweetId > getLastId(job.username, target));
      const results = await pushTweet(job.username, tweet, pendingTargets);
      for (const result of results) {
        if (result.ok) setLastId(job.username, result.target, tweetId);
      }
      saveState();
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch(e) {
    console.log(`❌ @${job.username} 抓取失败: ${e.message}`);
  }
}

async function main() {
  const monitorJobs = buildMonitorJobs(cfg.monitors);
  console.log("🚀 X/Twitter → QQ 转发桥启动！");
  console.log(`🔗 twapi: ${cfg.twapiUrl}`);
  console.log(`📡 Napcat: ${cfg.napcatApiUrl}`);
  console.log(`⏰ 检查间隔: ${cfg.intervalSeconds}秒`);
  console.log(`📋 监控: ${monitorJobs.map(job => `@${job.username} → ${job.targets.map(targetLabel).join("、") || "未配置目标"}`).join("；")}`);
  console.log(`📅 ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n`);

  for (const job of monitorJobs) {
    try {
      const tweets = await fetchTweets(job.username);
      if (tweets.length > 0) {
        const latestId = Math.max(...tweets.map(t => parseInt(t.id) || 0));
        for (const target of job.targets) setLastId(job.username, target, latestId);
        console.log(`📌 @${job.username} 初始化，最新ID: ${latestId}`);
      }
    } catch(e) { console.log(`⚠️ @${job.username} 初始化失败: ${e.message}`); }
  }
  saveState();
  console.log("📌 等待新推文...\n");

  setInterval(async () => {
    for (const job of monitorJobs) {
      await checkUser(job);
    }
  }, cfg.intervalSeconds * 1000);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
