const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync, exec, execFile } = require("child_process");
const WebSocket = require("ws");

// Admin auth
// Secrets live OUTSIDE this checkout: the repo is public and the Pi resets it from GitHub every
// minute, so nothing secret may be tracked here. Default directory ~/caelpi-config (override with
// CAELPI_CONFIG_DIR):
//   admin-config.json        {"password": "..."}              read on every login attempt; no file = no admin login
//   spotify.json             client_id / client_secret / redirect_uri / refresh_token
//   wordnik.json             {"api_key": "..."}
//   claude-trade.auth.json   {"user": "...", "password": "..."}   also optional "bin"/"cwd" (see below)
//   mining.json              {"token": "..."}   read-only GitHub token for the /mining downloads (see below)
const CONFIG_DIR = process.env.CAELPI_CONFIG_DIR || path.join(require("os").homedir(), "caelpi-config");
const ADMIN_CONFIG = path.join(CONFIG_DIR, "admin-config.json");

// Paused 2026-09-28 at the user's request (the trading jobs' systemd timers are stopped too): the
// homepage tile hides itself when /api/claude-trade isn't ok, and the dashboard page shows a notice
// instead of the last snapshot. Delete this block (and its use below) to unpause.
const CLAUDE_TRADE_PAUSED = true;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// Compare a secret without leaking it through timing. Hashing both sides first gives two buffers of
// the same length whatever was typed, so timingSafeEqual can never throw (it did on non-ASCII input
// whose bytes outnumber its characters) and the comparison says nothing about the secret's length.
function secretEquals(given, expected) {
  const h = function(s) { return crypto.createHash("sha256").update(String(s), "utf8").digest(); };
  return crypto.timingSafeEqual(h(given), h(expected));
}

// Deliberately no default password: with no config file the admin login never succeeds.
function readAdminPassword() {
  const cfg = readJson(ADMIN_CONFIG);
  return cfg && typeof cfg.password === "string" && cfg.password.length > 0 ? cfg.password : null;
}
const adminSessions = new Set();

function generateSession() {
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.add(token);
  return token;
}

function isAdminAuthed(req) {
  const cookies = (req.headers.cookie || "").split(";").reduce(function(acc, c) {
    var parts = c.trim().split("=");
    if (parts.length === 2) acc[parts[0]] = parts[1];
    return acc;
  }, {});
  return adminSessions.has(cookies.admin_session);
}

// claudetrade sign-in. Schwab's refresh token dies every 7 days and only a person can renew it, so
// /claude-trade/login serves a phone-sized page that asks the trading agent on this Pi for an
// authorization URL and pipes the address Schwab redirects to back into it. This site never holds
// the token: claudetrade writes it. Override the paths with "bin" and "cwd" in claude-trade.auth.json.
const CLAUDETRADE_HOME = path.join(require("os").homedir(), "claudetrade");

function claudeTradeConfig() {
  const c = readJson(path.join(CONFIG_DIR, "claude-trade.auth.json"))
    || readJson(path.join(__dirname, "claude-trade.auth.json")) || {};
  return {
    user: c.user, password: c.password,
    bin: c.bin || path.join(CLAUDETRADE_HOME, ".venv", "bin", "claudetrade"),
    cwd: c.cwd || CLAUDETRADE_HOME,
  };
}

// The dashboard's own HTTP Basic credentials, deliberately not the admin session. Returns false
// having already answered the request.
function claudeTradeAuthed(req, res) {
  const conf = claudeTradeConfig();
  if (!conf.user || !conf.password) {
    res.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("claude-trade is not configured yet: create claude-trade.auth.json on the Pi");
    return false;
  }
  const expected = "Basic " + Buffer.from(conf.user + ":" + conf.password).toString("base64");
  if (!secretEquals(req.headers.authorization || "", expected)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="claude-trade", charset="UTF-8"',
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    });
    res.end("login required");
    return false;
  }
  return true;
}

// Another Mining Game downloads at /mining (unlisted: nothing on the site links to it). The builds are
// release assets in a PRIVATE GitHub repo, uploaded by Tools/publish/publish.py in the game project.
// mining.json in CONFIG_DIR: {"token": "<fine-grained token: that repo only, Contents read-only>"},
// optionally "repo" and "password" (asks for it before the page or any download). A download is
// answered with a redirect to GitHub's own short-lived signed link: no file passes through the Pi and
// the token never reaches the browser.
const MINING_ASSETS = {
  windows: "AnotherMiningGame-Windows.zip",
  mac: "AnotherMiningGame-Mac.zip",
  "mac-server": "AnotherMiningGame-MacServer.zip",
  "windows-server": "AnotherMiningGame-WindowsServer.zip",
  "spoken-chat": "AnotherMiningGame-SpokenChat-Windows.zip",
};
let miningCache = { at: 0, data: null };

function miningConfig() {
  const c = readJson(path.join(CONFIG_DIR, "mining.json")) || {};
  return { token: c.token, repo: c.repo || "babylettuce22/another-mining-game-builds", password: c.password };
}

// The /mining and /mining-reports password (only when one is set). The browser signs in once on a
// password-only page (mining-login.html, POST /mining/login) and keeps a cookie for MINING_SIGNIN_DAYS. The
// cookie is "<expiry>.<HMAC of it keyed by the password>", so it survives the server restarting on every deploy
// and changing the password signs everyone out. Basic auth (any user name) is still accepted, for curl.
const MINING_SIGNIN_DAYS = 60;
const miningLoginFails = new Map();

function miningCookieSig(conf, expiry) {
  return crypto.createHmac("sha256", "mining-signin:" + conf.password).update(String(expiry)).digest("hex");
}

function miningSignedIn(req, conf) {
  const given = String(req.headers.authorization || "");
  if (given.startsWith("Basic ")) {
    const decoded = Buffer.from(given.slice(6), "base64").toString("utf8");
    if (secretEquals(decoded.slice(decoded.indexOf(":") + 1), conf.password)) return true;
  }
  const m = /(?:^|;\s*)mining_auth=(\d+)\.([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || "");
  return !!m && Number(m[1]) > Date.now() && secretEquals(m[2], miningCookieSig(conf, m[1]));
}

// A page someone opened gets the sign-in page; anything else (data, downloads) a plain 401.
function miningAuthed(req, res, conf, reqUrl) {
  if (!conf.password || miningSignedIn(req, conf)) return true;
  const p = reqUrl ? reqUrl.pathname : "";
  const page = req.method === "GET" && /^\/mining(-reports)?\/?$/.test(p);
  res.writeHead(401, { "Content-Type": page ? "text/html; charset=utf-8" : "text/plain", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
  res.end(page ? fs.readFileSync(path.join(__dirname, "mining-login.html"), "utf8") : "password required");
  return false;
}

// POST /mining/login (form: password, next). At most 10 wrong tries per address per 15 minutes.
async function handleMiningLogin(req, res) {
  const raw = await new Promise(function(resolve) {
    let d = "";
    req.on("data", function(c) { if (d.length < 8192) d += c; });
    req.on("end", function() { resolve(d); });
  });
  const params = new URLSearchParams(raw);
  const next = /^\/mining(-reports)?\/?$/.test(params.get("next") || "") ? params.get("next") : "/mining";
  const conf = miningConfig();
  const address = miningReportAddress(req), since = Date.now() - 15 * 60000;
  const fails = (miningLoginFails.get(address) || []).filter(function(t) { return t > since; });
  const back = function(error) {
    res.writeHead(303, { Location: next + "?error=" + error, "Cache-Control": "no-store" });
    res.end();
  };
  if (!conf.password) { res.writeHead(303, { Location: next }); res.end(); return; }
  if (fails.length >= 10) return back("wait");
  if (!secretEquals(params.get("password") || "", conf.password)) {
    fails.push(Date.now());
    miningLoginFails.set(address, fails);
    if (miningLoginFails.size > 1000) miningLoginFails.forEach(function(t, k) { if (!t.some(function(x) { return x > since; })) miningLoginFails.delete(k); });
    return back("wrong");
  }
  miningLoginFails.delete(address);
  const expiry = Date.now() + MINING_SIGNIN_DAYS * 86400000;
  const secure = req.headers["cf-connecting-ip"] ? "; Secure" : "";   // through the tunnel = https
  res.writeHead(303, {
    Location: next,
    "Cache-Control": "no-store",
    "Set-Cookie": "mining_auth=" + expiry + "." + miningCookieSig(conf, expiry) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + MINING_SIGNIN_DAYS * 86400 + secure,
  });
  res.end();
}

function githubApi(conf, apiPath, accept) {
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: "api.github.com",
      path: apiPath,
      method: "GET",
      headers: {
        "Authorization": "Bearer " + conf.token,
        "Accept": accept || "application/vnd.github+json",
        "User-Agent": "caelpi-www",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeout: 10000,
    }, function(res) {
      let body = "";
      res.on("data", function(c) { if (body.length < 2000000) body += c; });
      res.on("end", function() { resolve({ status: res.statusCode, headers: res.headers, body: body }); });
    });
    req.on("timeout", function() { req.destroy(new Error("GitHub timed out")); });
    req.on("error", reject);
    req.end();
  });
}

// The newest build-* release and the fixed spoken-chat one, cached for a minute.
async function miningReleases(conf) {
  if (miningCache.data && Date.now() - miningCache.at < 60000) return miningCache.data;
  const r = await githubApi(conf, "/repos/" + conf.repo + "/releases?per_page=30");
  if (r.status !== 200) throw new Error("GitHub releases: HTTP " + r.status);
  const releases = JSON.parse(r.body).filter(function(x) { return !x.draft; });
  const build = releases
    .filter(function(x) { return x.tag_name.startsWith("build-"); })
    .sort(function(a, b) { return String(b.published_at).localeCompare(String(a.published_at)); })[0] || null;
  const chat = releases.find(function(x) { return x.tag_name === "spoken-chat"; }) || null;
  miningCache = { at: Date.now(), data: { build: build, chat: chat } };
  return miningCache.data;
}

function miningAsset(data, key) {
  const release = key === "spoken-chat" ? data.chat : data.build;
  return release && release.assets.find(function(a) { return a.name === MINING_ASSETS[key]; }) || null;
}

// Crash, error and bug reports from the game (CrashReports.cs in the game project), POSTed to /mining-report
// as a zip; X-Report-Kind says which ("crash", "errors", "bug"). Not behind the /mining password (the game
// doesn't have it); instead the game sends "reportKey" from mining.json as X-Report-Key when one is set, and
// the route caps size, rate and storage. Reports are kept outside the repo in ~/mining-reports
// (MINING_REPORTS_DIR), oldest dropped first; Tools/crash/fetch-reports.sh in the game project copies them
// down. The reply's X-Report-Id names the report (the end of its file name), so a player can quote it.
// No address is stored.
const MINING_REPORTS_DIR = process.env.MINING_REPORTS_DIR || path.join(require("os").homedir(), "mining-reports");
const MINING_REPORT_MAX = 8 * 1024 * 1024;
const MINING_REPORTS_KEEP = { bytes: 500 * 1024 * 1024, reports: 200 };
const miningReportTimes = { all: [], byAddress: new Map() };

// The sender's address, for the rate limit. Visitors arrive through cloudflared on this machine, which sets
// CF-Connecting-IP; X-Forwarded-For isn't used, as a client can write anything there.
function miningReportAddress(req) {
  const socket = String(req.socket.remoteAddress || "");
  const local = socket === "127.0.0.1" || socket === "::1" || socket === "::ffff:127.0.0.1";
  const cf = String(req.headers["cf-connecting-ip"] || "").trim();
  return local && cf ? cf : socket;
}

// At most 20 an hour from one address and 120 an hour in all.
function miningReportAllowed(address) {
  const hourAgo = Date.now() - 3600000;
  const recent = function(list) { return (list || []).filter(function(t) { return t > hourAgo; }); };
  const all = recent(miningReportTimes.all), mine = recent(miningReportTimes.byAddress.get(address));
  if (all.length >= 120 || mine.length >= 20) return false;
  all.push(Date.now()); mine.push(Date.now());
  miningReportTimes.all = all;
  miningReportTimes.byAddress.set(address, mine);
  // Forget addresses with nothing in the last hour (never everyone at once: that would reset the limit).
  if (miningReportTimes.byAddress.size > 1000)
    miningReportTimes.byAddress.forEach(function(times, key) {
      if (!times.some(function(t) { return t > hourAgo; })) miningReportTimes.byAddress.delete(key);
    });
  return true;
}

// A report is its .zip and .json together: both go when it's dropped.
function pruneMiningReports() {
  const reports = new Map();
  fs.readdirSync(MINING_REPORTS_DIR).forEach(function(name) {
    const st = fs.statSync(path.join(MINING_REPORTS_DIR, name));
    const base = name.replace(/\.(zip|json)$/, "");
    const r = reports.get(base) || { names: [], size: 0, at: 0 };
    r.names.push(name); r.size += st.size; r.at = Math.max(r.at, st.mtimeMs);
    reports.set(base, r);
  });
  let bytes = 0;
  Array.from(reports.values())
    .sort(function(a, b) { return b.at - a.at; })
    .forEach(function(r, i) {
      bytes += r.size;
      if (bytes > MINING_REPORTS_KEEP.bytes || i >= MINING_REPORTS_KEEP.reports)
        r.names.forEach(function(name) { fs.unlinkSync(path.join(MINING_REPORTS_DIR, name)); });
    });
}

async function handleMiningReport(req, res) {
  const reply = function(status, text, headers) {
    res.writeHead(status, Object.assign({ "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }, headers));
    res.end(text);
  };
  if (req.method !== "POST") return reply(405, "POST a report");
  const conf = readJson(path.join(CONFIG_DIR, "mining.json")) || {};
  if (conf.reportKey && !secretEquals(req.headers["x-report-key"] || "", conf.reportKey)) return reply(403, "wrong key");
  if (Number(req.headers["content-length"] || 0) > MINING_REPORT_MAX) return reply(413, "too large");
  if (!miningReportAllowed(miningReportAddress(req))) return reply(429, "too many reports; try later");

  const chunks = [];
  let size = 0;
  const body = await new Promise(function(resolve, reject) {
    req.on("data", function(c) {
      size += c.length;
      if (size > MINING_REPORT_MAX) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on("end", function() { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
  if (!body) return reply(413, "too large");
  if (body.length < 22 || body.readUInt32LE(0) !== 0x04034b50) return reply(400, "not a zip");

  const clean = function(s, n) { return String(s || "").replace(/[^A-Za-z0-9 ._()-]/g, "").slice(0, n); };
  const kind = /^[a-z]{1,16}$/.test(req.headers["x-report-kind"] || "") ? req.headers["x-report-kind"] : "report";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = crypto.randomBytes(3).toString("hex");
  const base = stamp + "_" + kind + "_" + id;
  fs.mkdirSync(MINING_REPORTS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(MINING_REPORTS_DIR, base + ".zip"), body, { mode: 0o600 });
  fs.writeFileSync(path.join(MINING_REPORTS_DIR, base + ".json"), JSON.stringify({
    kind: kind,
    build: clean(req.headers["x-report-build"], 120),
    platform: clean(req.headers["x-report-platform"], 40),
    received: new Date().toISOString(),
    bytes: body.length,
  }, null, 2) + "\n", { mode: 0o600 });
  pruneMiningReports();
  console.log("mining report:", base, body.length, "bytes");
  reply(200, "thanks", { "X-Report-Id": id });
}

// /mining-reports: a page listing the stored reports, behind the /mining password (and refused outright
// when no password is set, as the logs hold players' machine details). The list reads each zip's index and
// its small text entries only; one entry can be opened on its own (/mining-reports/file/<report>/<entry>)
// or the whole zip downloaded (/mining-reports/file/<report>.zip).
const MINING_REPORT_NAME = /^[0-9TZ-]+_[a-z]{1,16}_[0-9a-f]{6}$/;

// The entries of a zip (name, sizes, where the data starts), from its central directory. Reads only the end
// of the file and the directory, not the data. Null if it isn't a readable zip.
function zipEntries(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size) return null;
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const entries = [];
    for (let p = 0, n = 0; n < count && p + 46 <= cdSize && cd.readUInt32LE(p) === 0x02014b50; n++) {
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      entries.push({
        name: cd.toString("utf8", p + 46, p + 46 + nameLen),
        method: cd.readUInt16LE(p + 10),
        compressed: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

// One entry's bytes (stored or deflated), or null.
function zipRead(file, entry) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.offset);
    if (head.readUInt32LE(0) !== 0x04034b50) return null;
    const data = Buffer.alloc(entry.compressed);
    fs.readSync(fd, data, 0, entry.compressed, entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28));
    if (entry.method === 0) return data;
    if (entry.method === 8) return require("zlib").inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function miningReportList() {
  let names = [];
  try { names = fs.readdirSync(MINING_REPORTS_DIR); } catch { return []; }
  return names
    .filter(function(n) { return n.endsWith(".zip") && MINING_REPORT_NAME.test(n.slice(0, -4)); })
    .sort().reverse()
    .map(function(n) {
      const base = n.slice(0, -4), zip = path.join(MINING_REPORTS_DIR, n);
      const meta = readJson(path.join(MINING_REPORTS_DIR, base + ".json")) || {};
      const r = { name: base, kind: base.split("_")[1], id: base.split("_")[2], build: meta.build || "",
                  platform: meta.platform || "", received: meta.received || "", bytes: meta.bytes || 0, files: [] };
      try {
        (zipEntries(zip) || []).forEach(function(e) {
          r.files.push({ name: e.name, size: e.size });
          if ((e.name === "bug.txt" || e.name === "report.txt") && e.size <= 64 * 1024) {
            const text = zipRead(zip, e);
            if (text) r[e.name === "bug.txt" ? "bug" : "report"] = text.toString("utf8");
          }
        });
      } catch (err) {
        r.error = "couldn't read this zip";
      }
      return r;
    });
}

function handleMiningReports(req, res, reqUrl) {
  const conf = miningConfig();
  const noIndex = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };
  const send = function(status, type, body, headers) {
    res.writeHead(status, Object.assign({ "Content-Type": type }, noIndex, headers));
    res.end(body);
  };
  if (!conf.password) return send(503, "text/plain", "Set a password in mining.json first.");
  if (!miningAuthed(req, res, conf, reqUrl)) return;
  const p = reqUrl.pathname;
  if (p === "/mining-reports" || p === "/mining-reports/")
    return send(200, "text/html; charset=utf-8", fs.readFileSync(path.join(__dirname, "mining-reports.html"), "utf8"));
  if (p === "/mining-reports/list.json") return send(200, "application/json", JSON.stringify(miningReportList()));
  // Deletes the reports the page listed (sent as {"names": [...]}), so one that arrived since isn't lost
  // unseen. The custom header keeps another site from posting here with the browser's saved password: a
  // cross-site request can only carry it after a preflight this server never answers.
  if (p === "/mining-reports/clear") {
    if (req.method !== "POST" || req.headers["x-clear-reports"] !== "yes") return send(400, "text/plain", "bad request");
    const chunks = [];
    req.on("data", function(c) { chunks.push(c); });
    req.on("end", function() {
      let names = [];
      try { names = JSON.parse(Buffer.concat(chunks).toString("utf8")).names; } catch {}
      let removed = 0;
      (Array.isArray(names) ? names : []).forEach(function(base) {
        if (typeof base !== "string" || !MINING_REPORT_NAME.test(base)) return;
        [".zip", ".json"].forEach(function(ext) {
          try { fs.unlinkSync(path.join(MINING_REPORTS_DIR, base + ext)); if (ext === ".zip") removed++; } catch {}
        });
      });
      console.log("mining reports cleared:", removed);
      send(200, "application/json", JSON.stringify({ removed: removed }));
    });
    return;
  }

  const m = /^\/mining-reports\/file\/([^/]+?)(\.zip|\/(.+))$/.exec(p);
  const base = m && decodeURIComponent(m[1]);
  if (!m || !MINING_REPORT_NAME.test(base)) return send(404, "text/plain", "not found");
  const zip = path.join(MINING_REPORTS_DIR, base + ".zip");
  if (!fs.existsSync(zip)) return send(404, "text/plain", "not found");
  if (m[2] === ".zip")
    return send(200, "application/zip", fs.readFileSync(zip), { "Content-Disposition": 'attachment; filename="' + base + '.zip"' });

  const entryName = decodeURIComponent(m[3]);
  const entry = (zipEntries(zip) || []).find(function(e) { return e.name === entryName; });
  const data = entry && zipRead(zip, entry);
  if (!data) return send(404, "text/plain", "not found");
  const ext = path.extname(entryName).toLowerCase();
  const type = { ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8", ".json": "text/plain; charset=utf-8",
                 ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" }[ext];
  const file = base + "_" + path.basename(entryName).replace(/[^A-Za-z0-9._-]/g, "_");
  send(200, type || "application/octet-stream", data,
       { "Content-Disposition": (type ? "inline" : "attachment") + '; filename="' + file + '"', "X-Content-Type-Options": "nosniff" });
}

// Run one half of `claudetrade login` and return the JSON it prints. The redirect address goes in
// on stdin, so the single-use code it carries never appears in the process list.
function claudetradeLogin(args, stdin) {
  return new Promise(function(resolve) {
    const conf = claudeTradeConfig();
    if (!fs.existsSync(conf.bin)) {
      resolve({ error: "the trading agent is not installed where this site expects it" });
      return;
    }
    const child = execFile(conf.bin, args, { cwd: conf.cwd, timeout: 90000, maxBuffer: 1 << 20 },
      function(err, stdout) {
        const lines = String(stdout || "").trim().split("\n");
        try {
          resolve(JSON.parse(lines[lines.length - 1]));
        } catch {
          resolve({ error: err && err.killed ? "the sign-in helper timed out"
                                             : "the sign-in helper could not be run" });
        }
      });
    child.stdin.end(stdin === undefined ? "" : stdin + "\n");
  });
}

// Days left on the refresh token. Reads the creation timestamp only; the token itself is never
// read here and never leaves the Pi.
function claudeTradeTokenDays() {
  const t = readJson(path.join(claudeTradeConfig().cwd, "data", "token.json"));
  if (!t || typeof t.creation_timestamp !== "number") return null;
  return 7 - (Date.now() / 1000 - t.creation_timestamp) / 86400;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function renderClaudeTradeLogin(res, opts) {
  const days = claudeTradeTokenDays();
  const status = days === null ? "No token on file yet."
    : days > 0 ? "The token on the Pi expires in " + days.toFixed(1) + " days."
    : "The token on the Pi expired " + Math.abs(days).toFixed(1) + " days ago.";
  const banner = opts.banner
    ? '<div class="banner ' + (opts.ok ? "ok" : "bad") + '">' + escapeHtml(opts.banner) + "</div>" : "";
  const link = opts.authUrl
    ? '<a class="button" href="' + escapeHtml(opts.authUrl) + '" target="_blank" rel="noopener">Sign in at Schwab</a>'
    : '<a class="button" href="/claude-trade/login">Start again</a>';
  let page;
  try {
    page = fs.readFileSync(path.join(__dirname, "claude-trade-login.html"), "utf8");
  } catch {
    res.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("the sign-in page is missing from this checkout");
    return;
  }
  page = page
    .replace("{{STATUS}}", function() { return escapeHtml(status); })
    .replace("{{BANNER}}", function() { return banner; })
    .replace("{{LINK}}", function() { return link; });
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.end(page);
}

// claudetrade mode switch. `claudetrade set-mode --json` does the work, including every check it
// makes at the terminal: a live mode needs Schwab data, a live token, no HALT file, and the exact
// confirmation phrase, which goes in on stdin. Every change is announced in Telegram.
function claudetradeRun(args, stdin) {
  return new Promise(function(resolve) {
    const conf = claudeTradeConfig();
    if (!fs.existsSync(conf.bin)) {
      resolve({ error: "the trading agent is not installed where this site expects it" });
      return;
    }
    const child = execFile(conf.bin, args, { cwd: conf.cwd, timeout: 60000, maxBuffer: 1 << 20 },
      function(err, stdout) {
        const lines = String(stdout || "").trim().split("\n");
        try {
          resolve(JSON.parse(lines[lines.length - 1]));
        } catch {
          resolve({ error: err && err.killed ? "claudetrade timed out" : "claudetrade could not be run" });
        }
      });
    child.stdin.end(stdin === undefined ? "" : stdin + "\n");
  });
}

// The browser resends Basic credentials on any request to this host, including a form another site
// submits, so a POST that changes the mode must come from a page on this site.
function sameOriginPost(req) {
  const site = req.headers["sec-fetch-site"];
  if (site) return site === "same-origin";
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const CLAUDETRADE_MODES = {
  report: ["Report only", "Analysis and reports. No orders at all, not even simulated ones."],
  paper: ["Paper", "Orders are simulated against a paper account. No real money moves."],
  live_approve: ["Live, with approval", "Real orders at Schwab, each one waiting for your yes in Telegram. Unapproved orders expire."],
  live_auto: ["Live, automatic", "Real orders at Schwab, placed at 12:30 ET inside the risk limits with no approval step."],
};

function renderClaudeTradeMode(res, state, opts) {
  opts = opts || {};
  let page;
  try {
    page = fs.readFileSync(path.join(__dirname, "claude-trade-mode.html"), "utf8");
  } catch {
    res.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("the mode page is missing from this checkout");
    return;
  }
  const current = state.mode || "";
  const problems = state.live_problems || [];
  const banner = opts.banner
    ? '<div class="banner ' + (opts.ok ? "ok" : "bad") + '">' + escapeHtml(opts.banner)
      + (opts.details && opts.details.length
        ? "<ul>" + opts.details.map(function(d) { return "<li>" + escapeHtml(d) + "</li>"; }).join("") + "</ul>" : "")
      + "</div>" : "";
  const options = (state.modes || []).map(function(m) {
    const label = CLAUDETRADE_MODES[m] || [m, ""];
    const live = m.indexOf("live") === 0;
    const blocked = live && problems.length > 0;
    return '<label class="mode' + (live ? " live" : "") + (m === current ? " current" : "")
      + (blocked ? " blocked" : "") + '">'
      + '<input type="radio" name="mode" value="' + escapeHtml(m) + '"'
      + (m === current ? " checked" : "") + (blocked ? " disabled" : "") + ">"
      + '<span><strong>' + escapeHtml(label[0]) + "</strong>"
      + (m === current ? ' <em>current</em>' : "")
      + '<code>' + escapeHtml(m) + "</code><br>" + escapeHtml(label[1]) + "</span></label>";
  }).join("");
  const blockers = problems.length
    ? '<div class="banner bad">Live modes are unavailable until these are fixed:<ul>'
      + problems.map(function(p) { return "<li>" + escapeHtml(p) + "</li>"; }).join("") + "</ul></div>" : "";
  page = page
    .replace("{{STATUS}}", function() {
      return escapeHtml(current ? "Current mode: " + ((CLAUDETRADE_MODES[current] || [current])[0]) : "Mode unknown");
    })
    .replace("{{BANNER}}", function() { return banner; })
    .replace("{{BLOCKERS}}", function() { return blockers; })
    .replace("{{OPTIONS}}", function() { return options; })
    .replace("{{GUARDRAILS}}", function() { return escapeHtml(state.guardrails || ""); })
    .replace(/\{\{PHRASE\}\}/g, function() { return escapeHtml(state.confirm_phrase || ""); });
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.end(page);
}

// claudetrade home-page tile. The trading jobs write claude-trade/stats.json (public numbers only:
// percentages, counts, flags) beside the private snapshot. Market hours are computed here so the
// tile stays right between job runs. Full-day NYSE closures mirror claudetrade/data/calendar.py;
// early closes still count as open days.
const NYSE_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03",
  "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05",
  "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04",
  "2028-11-23", "2028-12-25",
]);
const MARKET_OPEN_MIN = 9 * 60 + 30, MARKET_CLOSE_MIN = 16 * 60;
const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23", weekday: "short",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function etParts(d) {
  const o = {};
  for (const p of etFmt.formatToParts(d)) o[p.type] = p.value;
  return { ymd: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute), weekday: o.weekday };
}
function isTradingDay(p) {
  return p.weekday !== "Sat" && p.weekday !== "Sun" && !NYSE_HOLIDAYS.has(p.ymd);
}
// The instant of an Eastern wall-clock time: pretend the wall clock is UTC, then correct by the
// offset Intl reports for that guess (twice, so DST edges settle).
function etDate(ymd, minutes) {
  const [y, m, d] = ymd.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const p = etParts(new Date(t));
    const [py, pm, pd] = p.ymd.split("-").map(Number);
    t = wall - (Date.UTC(py, pm - 1, pd, 0, p.minutes) - t);
  }
  return new Date(t);
}
function marketState(now = new Date()) {
  const p = etParts(now);
  const tradingDay = isTradingDay(p);
  const open = tradingDay && p.minutes >= MARKET_OPEN_MIN && p.minutes < MARKET_CLOSE_MIN;
  let q = p;
  if (!(tradingDay && p.minutes < MARKET_OPEN_MIN)) {
    // walk forward from noon ET so a DST change cannot land the step on the same date
    let d = etDate(p.ymd, 12 * 60);
    do { d = new Date(d.getTime() + 86400000); q = etParts(d); } while (!isTradingDay(q));
  }
  return {
    open,
    trading_day: tradingDay,
    closes_at: open ? etDate(p.ymd, MARKET_CLOSE_MIN).toISOString() : null,
    next_open: open ? null : etDate(q.ymd, MARKET_OPEN_MIN).toISOString(),
  };
}

// Word of the Day cache
const WORDNIK_KEY = ((readJson(path.join(CONFIG_DIR, "wordnik.json")) || {}).api_key) || "";
let wotdCache = { data: null, fetchedAt: 0 };
const WOTD_TTL = 60 * 60 * 1000; // 1 hour (word changes daily, but check hourly)

function fetchWotd() {
  return new Promise((resolve, reject) => {
    https.get("https://api.wordnik.com/v4/words.json/wordOfTheDay?api_key=" + WORDNIK_KEY, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const def = data.definitions && data.definitions.length > 0 ? data.definitions[0] : null;
          const result = {
            word: data.word,
            definition: def ? def.text : "",
            partOfSpeech: def ? def.partOfSpeech : "",
            note: data.note || "",
          };
          wotdCache = { data: result, fetchedAt: Date.now() };
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

// Fetch on startup
fetchWotd().catch(() => {});

// Medical term of the day. The pearls are authored locally rather than
// fetched: encyclopedia summaries define a disease, which is not what Step 2
// asks. No upstream call, so nothing here can fail or rate-limit.
const MEDTERMS = (function () {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "medterms.json"), "utf8"));
  } catch {
    return [];
  }
})();

// Local-date day number, so the term turns over at local midnight.
function localDayNumber() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
}

// Weather cache
let weatherCache = { data: null, fetchedAt: 0 };
const WEATHER_ZIP = "95817";
const WEATHER_TTL = 30 * 60 * 1000; // 30 minutes

function fetchWeather() {
  return new Promise((resolve, reject) => {
    https.get(`https://wttr.in/${WEATHER_ZIP}?format=j1`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const current = data.current_condition[0];
          // Guarded: a missing astronomy block should cost us sunrise/sunset,
          // not the whole weather readout.
          const astro =
            (data.weather && data.weather[0] && data.weather[0].astronomy &&
              data.weather[0].astronomy[0]) || {};
          const result = {
            temp_f: current.temp_F,
            feels_like_f: current.FeelsLikeF,
            desc: current.weatherDesc[0].value,
            humidity: current.humidity,
            wind_mph: current.windspeedMiles,
            uv_index: current.uvIndex,
            sunrise: astro.sunrise,
            sunset: astro.sunset,
            moonrise: astro.moonrise,
            moonset: astro.moonset,
            moon_phase: astro.moon_phase,
            moon_illumination: astro.moon_illumination,
            cloudcover: current.cloudcover,
          };
          weatherCache = { data: result, fetchedAt: Date.now() };
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

// Fetch on startup
fetchWeather().catch(() => {});

// --- Spotify ---
const SPOTIFY_FILE = path.join(CONFIG_DIR, "spotify.json");
let spotifyConfig = { client_id: "", client_secret: "", redirect_uri: "", refresh_token: null };
let spotifyToken = { access_token: null, expiresAt: 0 };
let spotifyCache = { data: null, fetchedAt: 0 };
const SPOTIFY_CACHE_TTL = 60 * 1000; // 1 minute

try { spotifyConfig = JSON.parse(fs.readFileSync(SPOTIFY_FILE, "utf8")); } catch {}

function saveSpotifyConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SPOTIFY_FILE, JSON.stringify(spotifyConfig, null, 2), { mode: 0o600 });
}

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function getSpotifyAccessToken() {
  if (spotifyToken.access_token && Date.now() < spotifyToken.expiresAt) {
    return spotifyToken.access_token;
  }
  if (!spotifyConfig.refresh_token) return null;

  const auth = Buffer.from(spotifyConfig.client_id + ":" + spotifyConfig.client_secret).toString("base64");
  const body = "grant_type=refresh_token&refresh_token=" + encodeURIComponent(spotifyConfig.refresh_token);
  const result = await httpsPost("https://accounts.spotify.com/api/token", {
    "Content-Type": "application/x-www-form-urlencoded",
    "Authorization": "Basic " + auth,
  }, body);

  if (result.data.access_token) {
    spotifyToken.access_token = result.data.access_token;
    spotifyToken.expiresAt = Date.now() + (result.data.expires_in - 60) * 1000;
    if (result.data.refresh_token) {
      spotifyConfig.refresh_token = result.data.refresh_token;
      saveSpotifyConfig();
    }
    return spotifyToken.access_token;
  }
  return null;
}

function trackFromData(track, is_playing) {
  return {
    name: track.name,
    artist: track.artists.map(function(a) { return a.name; }).join(", "),
    album: track.album.name,
    image: track.album.images.length > 0 ? track.album.images[track.album.images.length > 1 ? 1 : 0].url : null,
    url: track.external_urls.spotify,
    is_playing: is_playing || false,
  };
}

async function fetchNowPlaying() {
  const token = await getSpotifyAccessToken();
  if (!token) return null;

  // Try currently playing first
  const current = await httpsGet("https://api.spotify.com/v1/me/player/currently-playing", {
    "Authorization": "Bearer " + token,
  });
  if (current.status === 200 && current.data && current.data.item) {
    const data = trackFromData(current.data.item, current.data.is_playing);
    spotifyCache = { data: data, fetchedAt: Date.now() };
    return data;
  }

  // Fall back to recently played
  const recent = await httpsGet("https://api.spotify.com/v1/me/player/recently-played?limit=1", {
    "Authorization": "Bearer " + token,
  });
  if (recent.data && recent.data.items && recent.data.items.length > 0) {
    const data = trackFromData(recent.data.items[0].track, false);
    spotifyCache = { data: data, fetchedAt: Date.now() };
    return data;
  }
  return null;
}

// Commit date of the deployed revision, injected into the homepage so a
// push is visibly confirmable. Falls back to the file mtime if git is
// unavailable (e.g. the service user can't read the repo).
function lastUpdatedISO() {
  try {
    return execSync("git log -1 --format=%cI", { cwd: __dirname, encoding: "utf8" }).trim();
  } catch {}
  try {
    return fs.statSync(path.join(__dirname, "index.html")).mtime.toISOString();
  } catch {}
  return "";
}

const homepage = fs
  .readFileSync(path.join(__dirname, "index.html"), "utf8")
  .replace("__LAST_UPDATED__", lastUpdatedISO());
const DATA_FILE = path.join(__dirname, "data.json");

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { status: { text: "", emoji: "", updatedAt: null }, notes: [], links: [] };
  }
}

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

const store = loadStore();

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function broadcast(wss, msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function cors(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end();
}

async function handleApi(req, res, wss) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") return cors(res);

  // Reads are public; every write (status, notes, links, admin) needs the admin session.
  // The site is public and data.json lives on the Pi, so nothing may be writable anonymously.
  if (method !== "GET" && !isAdminAuthed(req)) {
    return json(res, { error: "Unauthorized" }, 401);
  }

  if (pathname === "/api/status" && method === "GET") {
    return json(res, store.status);
  }
  if (pathname === "/api/status" && method === "PUT") {
    const body = await parseBody(req);
    store.status.text = body.text ?? store.status.text;
    store.status.emoji = body.emoji ?? store.status.emoji;
    store.status.updatedAt = new Date().toISOString();
    saveStore();
    broadcast(wss, { type: "status", data: store.status });
    return json(res, store.status);
  }

  if (pathname === "/api/notes" && method === "GET") {
    return json(res, store.notes);
  }
  if (pathname === "/api/notes" && method === "POST") {
    const body = await parseBody(req);
    const note = {
      id: genId(),
      text: body.text || "",
      createdAt: new Date().toISOString(),
    };
    store.notes.unshift(note);
    saveStore();
    broadcast(wss, { type: "note_added", data: note });
    return json(res, note, 201);
  }
  if (pathname.startsWith("/api/notes/") && method === "DELETE") {
    const id = pathname.split("/").pop();
    const idx = store.notes.findIndex((n) => n.id === id);
    if (idx === -1) return json(res, { error: "Not found" }, 404);
    store.notes.splice(idx, 1);
    saveStore();
    broadcast(wss, { type: "note_deleted", data: { id } });
    return json(res, { ok: true });
  }

  if (pathname === "/api/links" && method === "GET") {
    return json(res, store.links);
  }
  if (pathname === "/api/links" && method === "POST") {
    const body = await parseBody(req);
    const link = {
      id: genId(),
      title: body.title || "",
      url: body.url || "",
      createdAt: new Date().toISOString(),
    };
    store.links.unshift(link);
    saveStore();
    broadcast(wss, { type: "link_added", data: link });
    return json(res, link, 201);
  }
  if (pathname.startsWith("/api/links/") && method === "DELETE") {
    const id = pathname.split("/").pop();
    const idx = store.links.findIndex((l) => l.id === id);
    if (idx === -1) return json(res, { error: "Not found" }, 404);
    store.links.splice(idx, 1);
    saveStore();
    broadcast(wss, { type: "link_deleted", data: { id } });
    return json(res, { ok: true });
  }

  if (pathname === "/api/sync" && method === "GET") {
    return json(res, store);
  }

  if (pathname === "/api/recently-played" && method === "GET") {
    try {
      if (spotifyCache.data && Date.now() - spotifyCache.fetchedAt < SPOTIFY_CACHE_TTL) {
        return json(res, spotifyCache.data);
      }
      const data = await fetchNowPlaying();
      if (data) return json(res, data);
      return json(res, { error: "No data. Visit /login to connect Spotify." }, 401);
    } catch {
      if (spotifyCache.data) return json(res, spotifyCache.data);
      return json(res, { error: "Spotify unavailable" }, 502);
    }
  }

  if (pathname === "/api/medterm" && method === "GET") {
    if (!MEDTERMS.length) return json(res, { error: "No terms loaded" }, 503);
    const entry = MEDTERMS[localDayNumber() % MEDTERMS.length];
    return json(res, entry);
  }

  if (pathname === "/api/wotd" && method === "GET") {
    try {
      if (wotdCache.data && Date.now() - wotdCache.fetchedAt < WOTD_TTL) {
        return json(res, wotdCache.data);
      }
      const data = await fetchWotd();
      return json(res, data);
    } catch {
      if (wotdCache.data) return json(res, wotdCache.data);
      return json(res, { error: "Word of the Day unavailable" }, 502);
    }
  }

  if (pathname === "/api/weather" && method === "GET") {
    try {
      if (weatherCache.data && Date.now() - weatherCache.fetchedAt < WEATHER_TTL) {
        return json(res, weatherCache.data);
      }
      const data = await fetchWeather();
      return json(res, data);
    } catch {
      if (weatherCache.data) return json(res, weatherCache.data);
      return json(res, { error: "Weather unavailable" }, 502);
    }
  }

  if (pathname === "/api/claude-trade" && method === "GET") {
    if (CLAUDE_TRADE_PAUSED) return json(res, { error: "claudetrade is paused" }, 503);
    const stats = readJson(path.join(__dirname, "claude-trade", "stats.json"));
    if (!stats) return json(res, { error: "claudetrade stats not generated yet" }, 503);
    // Real money only: paper-mode numbers never leave the Pi, and the tile stays hidden.
    if (stats.broker !== "schwab") return json(res, { error: "claudetrade is not trading a real account" }, 404);
    const out = Object.assign({}, stats, { market: marketState() });
    if (out.pending_approvals > 0 && out.today && /^\d\d:\d\d$/.test(out.execute_time || "")) {
      const [h, m] = out.execute_time.split(":").map(Number);
      out.approval_deadline = etDate(out.today, h * 60 + m).toISOString();
    }
    // Dollar figures stay behind the admin login; the percentages are what the public tile shows.
    if (!isAdminAuthed(req)) delete out.pnl_since_start;
    return json(res, out);
  }

  // --- Admin API (auth required) ---
  if (pathname.startsWith("/api/admin/") && !isAdminAuthed(req)) {
    return json(res, { error: "Unauthorized" }, 401);
  }

  if (pathname === "/api/admin/system" && method === "GET") {
    try {
      var info = { platform: process.platform, arch: process.arch, nodeVersion: process.version };
      info.uptime = process.uptime();
      info.memUsed = process.memoryUsage().rss;
      if (process.platform === "linux") {
        try { info.systemUptime = parseFloat(execSync("cat /proc/uptime", { encoding: "utf8" }).split(" ")[0]); } catch {}
        try {
          var meminfo = execSync("cat /proc/meminfo", { encoding: "utf8" });
          var total = meminfo.match(/MemTotal:\s+(\d+)/);
          var avail = meminfo.match(/MemAvailable:\s+(\d+)/);
          if (total) info.memTotal = parseInt(total[1]) * 1024;
          if (avail) info.memAvail = parseInt(avail[1]) * 1024;
        } catch {}
        try { info.cpuTemp = parseFloat(execSync("cat /sys/class/thermal/thermal_zone0/temp", { encoding: "utf8" })) / 1000; } catch {}
        try {
          var df = execSync("df -B1 / | tail -1", { encoding: "utf8" }).trim().split(/\s+/);
          info.diskTotal = parseInt(df[1]);
          info.diskUsed = parseInt(df[2]);
        } catch {}
        try { info.ip = execSync("hostname -I", { encoding: "utf8" }).trim().split(" ")[0]; } catch {}
        try { info.hostname = execSync("hostname", { encoding: "utf8" }).trim(); } catch {}
      }
      return json(res, info);
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  if (pathname === "/api/admin/wifi/list" && method === "GET") {
    try {
      var networks = execSync("sudo iwlist wlan0 scan 2>/dev/null | grep -E 'ESSID|Signal'", { encoding: "utf8", timeout: 15000 });
      var lines = networks.trim().split("\n");
      var results = [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.startsWith("ESSID:")) {
          var ssid = line.replace('ESSID:"', "").replace('"', "");
          if (ssid) results.push({ ssid: ssid, signal: "" });
        }
        if (line.startsWith("Signal level=") || line.indexOf("Signal level=") !== -1) {
          var match = line.match(/Signal level=(-?\d+)/);
          if (match && results.length > 0) results[results.length - 1].signal = match[1] + " dBm";
        }
      }
      return json(res, results);
    } catch {
      return json(res, []);
    }
  }

  if (pathname === "/api/admin/wifi/current" && method === "GET") {
    try {
      var ssid = execSync("iwgetid -r 2>/dev/null", { encoding: "utf8" }).trim();
      var ip = execSync("hostname -I 2>/dev/null", { encoding: "utf8" }).trim().split(" ")[0];
      return json(res, { ssid: ssid, ip: ip });
    } catch {
      return json(res, { ssid: "", ip: "" });
    }
  }

  if (pathname === "/api/admin/wifi/add" && method === "POST") {
    try {
      var body = await parseBody(req);
      if (!body.ssid) return json(res, { error: "SSID required" }, 400);
      var entry = '\nnetwork={\n  ssid="' + body.ssid + '"\n';
      if (body.password) {
        entry += '  psk="' + body.password + '"\n';
      } else {
        entry += '  key_mgmt=NONE\n';
      }
      entry += '}\n';
      execSync("echo '" + entry.replace(/'/g, "'\\''") + "' | sudo tee -a /etc/wpa_supplicant/wpa_supplicant.conf > /dev/null", { encoding: "utf8" });
      exec("sudo wpa_cli -i wlan0 reconfigure");
      return json(res, { ok: true, message: "Network added. Reconfiguring..." });
    } catch (err) {
      return json(res, { error: err.message }, 500);
    }
  }

  if (pathname === "/api/admin/restart" && method === "POST") {
    json(res, { ok: true, message: "Restarting server..." });
    setTimeout(function() { process.exit(0); }, 500);
    return;
  }

  if (pathname === "/api/admin/reboot" && method === "POST") {
    json(res, { ok: true, message: "Rebooting Pi..." });
    setTimeout(function() { exec("sudo reboot"); }, 500);
    return;
  }

  if (pathname === "/api/admin/logs" && method === "GET") {
    try {
      var logs = execSync("journalctl -u caelpi -n 50 --no-pager 2>/dev/null || echo 'No systemd logs available'", { encoding: "utf8" });
      return json(res, { logs: logs });
    } catch {
      return json(res, { logs: "Could not retrieve logs" });
    }
  }

  return json(res, { error: "Not found" }, 404);
}

// Every route runs inside this catch. The handler is async, so a throw anywhere in it (a malformed
// Host header, a bad body) used to become an unhandled rejection, which ends the whole process:
// one crafted request could take the site down. Now that request gets an error and the site stays up.
const server = http.createServer(function(req, res) {
  handleRequest(req, res).catch(function(err) {
    console.error("request failed:", req.method, String(req.url).slice(0, 120), "-", err && err.message);
    if (!res.headersSent) {
      res.writeHead(err instanceof TypeError ? 400 : 500, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    }
    res.end("request failed");
  });
});

// The Long Cave's Discord invite for /thelongcave/discord/join. THELONGCAVE_INVITE (a never-expiring invite; public, not
// a secret) wins; empty, the route follows the invite in the server's widget JSON, which Discord replaces on its own,
// cached for 5 minutes. Links on itch and elsewhere point at the route, so changing the invite never breaks them.
const THELONGCAVE_INVITE = "";
const THELONGCAVE_GUILD = "1560790489416863827";
let theLongCaveInvite = { at: 0, url: null };

function theLongCaveInviteUrl() {
  if (THELONGCAVE_INVITE) return Promise.resolve(THELONGCAVE_INVITE);
  if (theLongCaveInvite.url && Date.now() - theLongCaveInvite.at < 300000) return Promise.resolve(theLongCaveInvite.url);
  return new Promise(function(resolve) {
    const req = https.get({
      hostname: "discord.com",
      path: "/api/guilds/" + THELONGCAVE_GUILD + "/widget.json",
      headers: { "User-Agent": "caelpi-www" },
      timeout: 5000,
    }, function(res) {
      let body = "";
      res.on("data", function(c) { body += c; });
      res.on("end", function() {
        let url = null;
        try { url = JSON.parse(body).instant_invite || null; } catch (e) {}
        if (url && /^https:\/\/discord\.(com|gg)\//.test(url)) theLongCaveInvite = { at: Date.now(), url: url };
        resolve(theLongCaveInvite.url);  // a stale invite beats none
      });
    });
    req.on("timeout", function() { req.destroy(); });
    req.on("error", function() { resolve(theLongCaveInvite.url); });
  });
}

async function handleRequest(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // Spotify OAuth: login redirect
  if (reqUrl.pathname === "/login") {
    const scope = "user-read-recently-played user-read-currently-playing";
    const authUrl = "https://accounts.spotify.com/authorize?" +
      "response_type=code" +
      "&client_id=" + encodeURIComponent(spotifyConfig.client_id) +
      "&scope=" + encodeURIComponent(scope) +
      "&redirect_uri=" + encodeURIComponent(spotifyConfig.redirect_uri);
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // Spotify OAuth: callback
  if (reqUrl.pathname === "/callback") {
    const code = reqUrl.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing code");
      return;
    }
    const auth = Buffer.from(spotifyConfig.client_id + ":" + spotifyConfig.client_secret).toString("base64");
    const body = "grant_type=authorization_code" +
      "&code=" + encodeURIComponent(code) +
      "&redirect_uri=" + encodeURIComponent(spotifyConfig.redirect_uri);
    try {
      const result = await httpsPost("https://accounts.spotify.com/api/token", {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + auth,
      }, body);
      if (result.data.refresh_token) {
        spotifyConfig.refresh_token = result.data.refresh_token;
        saveSpotifyConfig();
        spotifyToken.access_token = result.data.access_token;
        spotifyToken.expiresAt = Date.now() + (result.data.expires_in - 60) * 1000;
        // Show the token so it can be saved to the repo permanently
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h2>Spotify connected!</h2><p>Send this refresh token to save it permanently:</p><pre>" + result.data.refresh_token + "</pre><p><a href='/'>Go to homepage</a></p>");
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("No refresh token received: " + JSON.stringify(result.data));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Token exchange failed: " + err.message);
    }
    return;
  }

  if (req.url.startsWith("/api/")) {
    try {
      await handleApi(req, res, wss);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }
  // claudetrade dashboard: a static snapshot that the trading jobs on this Pi rewrite after every
  // run (claude-trade/index.html, git-ignored). Guarded by its own HTTP Basic credentials, read from
  // claude-trade.auth.json in CONFIG_DIR (created on the Pi by hand):
  //   {"user": "cael", "password": "a long random string"}
  // It deliberately does not reuse the admin session. The live dashboard server on port 8181 is LAN-only.
  if (reqUrl.pathname === "/claude-trade" || reqUrl.pathname === "/claude-trade/") {
    if (!claudeTradeAuthed(req, res)) return;
    if (CLAUDE_TRADE_PAUSED) {
      res.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("claudetrade is paused for now");
      return;
    }
    let snapshot;
    try {
      snapshot = fs.readFileSync(path.join(__dirname, "claude-trade", "index.html"), "utf8");
    } catch {
      res.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("claudetrade snapshot not generated yet; the next trading job writes it");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
    res.end(snapshot);
    return;
  }
  // Schwab sign-in, phone sized: one tap to Schwab, paste the address it bounces you to. The
  // authorization state lives on the Pi for 20 minutes, so the two halves can be minutes apart.
  if (reqUrl.pathname === "/claude-trade/login") {
    if (!claudeTradeAuthed(req, res)) return;
    if (req.method === "GET") {
      const started = await claudetradeLogin(["login", "--begin", "--json"]);
      renderClaudeTradeLogin(res, {
        authUrl: started.auth_url,
        banner: started.auth_url ? "" : (started.error || "could not start a sign-in"),
      });
      return;
    }
    if (req.method === "POST") {
      const raw = await new Promise(function(resolve) {
        var d = "";
        req.on("data", function(c) { if (d.length < 8192) d += c; });
        req.on("end", function() { resolve(d); });
      });
      const pasted = (new URLSearchParams(raw).get("url") || "").replace(/[\r\n]/g, "").trim();
      const done = await claudetradeLogin(["login", "--finish", "-", "--json"], pasted);
      renderClaudeTradeLogin(res, done.ok
        ? { ok: true, banner: "Signed in. The token is good for " + done.days_left +
                              " days, and the trading jobs can reach Schwab again." }
        : { ok: false, banner: done.error || "the sign-in did not complete" });
      return;
    }
    res.writeHead(405, { "Content-Type": "text/plain", "Allow": "GET, POST" });
    res.end("method not allowed");
    return;
  }
  // Mode switch, phone sized. Stepping down (to paper or report) takes one tap; stepping up to a
  // live mode needs the same typed phrase the terminal asks for.
  if (reqUrl.pathname === "/claude-trade/mode") {
    if (!claudeTradeAuthed(req, res)) return;
    if (req.method === "GET") {
      const state = await claudetradeRun(["set-mode", "--json"]);
      if (state.error) {
        res.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end(state.error);
        return;
      }
      renderClaudeTradeMode(res, state);
      return;
    }
    if (req.method === "POST") {
      if (!sameOriginPost(req)) {
        res.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("mode changes must come from this site's own page");
        return;
      }
      const raw = await new Promise(function(resolve) {
        var d = "";
        req.on("data", function(c) { if (d.length < 8192) d += c; });
        req.on("end", function() { resolve(d); });
      });
      const form = new URLSearchParams(raw);
      const mode = form.get("mode") || "";
      const phrase = (form.get("confirm") || "").replace(/[\r\n]/g, "").trim();
      let result;
      if (!Object.prototype.hasOwnProperty.call(CLAUDETRADE_MODES, mode)) {
        result = { ok: false, banner: "Pick a mode first." };
      } else {
        const done = await claudetradeRun(["set-mode", mode, "--json"], phrase);
        if (done.error) result = { ok: false, banner: done.error };
        else if (done.ok && done.previous === mode) result = { ok: true, banner: "Already in that mode; nothing changed." };
        else if (done.ok) result = { ok: true, banner: "Mode changed from " + done.previous + " to " + mode
                                                       + ". It takes effect at the next job run." };
        else if ((done.messages || []).some(function(m) { return m.indexOf("Cancelled") === 0; }))
          result = { ok: false, banner: "The confirmation phrase did not match, so nothing changed." };
        else result = { ok: false, banner: "Nothing changed.",
                        details: (done.messages || []).filter(function(m) {
                          return /^(  - |mode must|could not)/.test(m);
                        }).map(function(m) { return m.trim().replace(/^- /, ""); }) };
      }
      const state = await claudetradeRun(["set-mode", "--json"]);
      if (state.error) {
        res.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end(state.error);
        return;
      }
      renderClaudeTradeMode(res, state, result);
      return;
    }
    res.writeHead(405, { "Content-Type": "text/plain", "Allow": "GET, POST" });
    res.end("method not allowed");
    return;
  }
  if (reqUrl.pathname === "/admin") {
    if (!isAdminAuthed(req)) {
      res.writeHead(302, { Location: "/admin/login" });
      res.end();
      return;
    }
    const adminPage = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(adminPage);
    return;
  }
  if (reqUrl.pathname === "/admin/login" && req.method === "GET") {
    const loginPage = fs.readFileSync(path.join(__dirname, "admin-login.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(loginPage);
    return;
  }
  if (reqUrl.pathname === "/admin/login" && req.method === "POST") {
    const raw = await new Promise(function(resolve) {
      var d = "";
      req.on("data", function(c) { if (d.length < 8192) d += c; });   // a password form is tiny
      req.on("end", function() { resolve(d); });
    });
    var params = new URLSearchParams(raw);
    const adminPassword = readAdminPassword();
    const given = params.get("password") || "";
    const ok = adminPassword !== null && secretEquals(given, adminPassword);
    if (ok) {
      const token = generateSession();
      res.writeHead(302, {
        Location: "/admin",
        "Set-Cookie": "admin_session=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400",
      });
      res.end();
    } else {
      res.writeHead(302, { Location: "/admin/login?error=1" });
      res.end();
    }
    return;
  }
  if (reqUrl.pathname === "/admin/logout") {
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": "admin_session=; Path=/; HttpOnly; Max-Age=0",
    });
    res.end();
    return;
  }
  if (reqUrl.pathname === "/mining-report") return handleMiningReport(req, res);
  if (reqUrl.pathname === "/mining-reports" || reqUrl.pathname.startsWith("/mining-reports/")) return handleMiningReports(req, res, reqUrl);
  if (reqUrl.pathname === "/mining/login" && req.method === "POST") return handleMiningLogin(req, res);
  if (reqUrl.pathname === "/mining" || reqUrl.pathname.startsWith("/mining/")) {
    const conf = miningConfig();
    if (!miningAuthed(req, res, conf, reqUrl)) return;
    const noIndex = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };
    if (reqUrl.pathname === "/mining" || reqUrl.pathname === "/mining/") {
      const page = fs.readFileSync(path.join(__dirname, "mining.html"), "utf8");
      res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, noIndex));
      res.end(page);
      return;
    }
    if (!conf.token) {
      res.writeHead(503, Object.assign({ "Content-Type": "application/json" }, noIndex));
      res.end(JSON.stringify({ error: "Downloads aren't set up yet." }));
      return;
    }
    if (reqUrl.pathname === "/mining/latest.json") {
      const data = await miningReleases(conf);
      const size = function(key) { const a = miningAsset(data, key); return a ? a.size : null; };
      res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, noIndex));
      res.end(JSON.stringify({
        build: data.build && { name: data.build.name, date: data.build.published_at },
        windows: size("windows"), mac: size("mac"), macServer: size("mac-server"), windowsServer: size("windows-server"), spokenChat: size("spoken-chat"),
      }));
      return;
    }
    const key = reqUrl.pathname.slice("/mining/download/".length);
    if (reqUrl.pathname.startsWith("/mining/download/") && Object.prototype.hasOwnProperty.call(MINING_ASSETS, key)) {
      const asset = miningAsset(await miningReleases(conf), key);
      if (!asset) {
        res.writeHead(404, Object.assign({ "Content-Type": "text/plain" }, noIndex));
        res.end("That download isn't available yet.");
        return;
      }
      // GitHub answers an octet-stream request for a private asset with a redirect to a signed URL
      // that works for a few minutes without credentials; pass that redirect on.
      const r = await githubApi(conf, "/repos/" + conf.repo + "/releases/assets/" + asset.id, "application/octet-stream");
      if (r.status !== 302 || !r.headers.location) throw new Error("GitHub asset " + asset.id + ": HTTP " + r.status);
      res.writeHead(302, Object.assign({ "Location": r.headers.location }, noIndex));
      res.end();
      return;
    }
    res.writeHead(404, Object.assign({ "Content-Type": "text/plain" }, noIndex));
    res.end("not found");
    return;
  }
  // The Long Cave's Discord join card (thelongcave-discord.html), public on purpose: the itch.io page iframes it.
  // /join redirects to the current invite (see theLongCaveInviteUrl); banner.png is the clickable sign for the itch page.
  if (reqUrl.pathname === "/thelongcave/discord/join") {
    const invite = await theLongCaveInviteUrl();
    res.writeHead(302, { "Location": invite || "/thelongcave/discord", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (reqUrl.pathname === "/thelongcave/discord/banner.png") {
    const bannerPath = path.join(__dirname, "thelongcave-discord-banner.png");
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": fs.statSync(bannerPath).size, "Cache-Control": "public, max-age=3600" });
    fs.createReadStream(bannerPath).pipe(res);
    return;
  }
  // The page reads Discord's widget JSON in the browser, so the server only hands out the file.
  if (reqUrl.pathname === "/thelongcave/discord") {
    const widgetPage = fs.readFileSync(path.join(__dirname, "thelongcave-discord.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(widgetPage);
    return;
  }
  if (reqUrl.pathname === "/minesweeper") {
    const minesweeperPage = fs.readFileSync(path.join(__dirname, "minesweeper.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
    res.end(minesweeperPage);
    return;
  }
  if (req.url === "/happy.gif") {
    const gifPath = path.join(__dirname, "happy.gif");
    const stat = fs.statSync(gifPath);
    res.writeHead(200, {
      "Content-Type": "image/gif",
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=3600",
    });
    fs.createReadStream(gifPath).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
  res.end(homepage);
}

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log(`client connected (${wss.clients.size} total)`);
  ws.on("close", () => console.log(`client disconnected (${wss.clients.size} total)`));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`caelpi running on http://localhost:${PORT}`);
});
