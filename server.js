const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

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
          const result = {
            temp_f: current.temp_F,
            feels_like_f: current.FeelsLikeF,
            desc: current.weatherDesc[0].value,
            humidity: current.humidity,
            wind_mph: current.windspeedMiles,
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
const SPOTIFY_FILE = path.join(__dirname, "spotify.json");
let spotifyConfig = { client_id: "", client_secret: "", redirect_uri: "", refresh_token: null };
let spotifyToken = { access_token: null, expiresAt: 0 };
let spotifyCache = { data: null, fetchedAt: 0 };
const SPOTIFY_CACHE_TTL = 60 * 1000; // 1 minute

try { spotifyConfig = JSON.parse(fs.readFileSync(SPOTIFY_FILE, "utf8")); } catch {}

function saveSpotifyConfig() {
  fs.writeFileSync(SPOTIFY_FILE, JSON.stringify(spotifyConfig, null, 2));
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

async function fetchRecentlyPlayed() {
  const token = await getSpotifyAccessToken();
  if (!token) return null;
  const result = await httpsGet("https://api.spotify.com/v1/me/player/recently-played?limit=1", {
    "Authorization": "Bearer " + token,
  });
  if (result.data && result.data.items && result.data.items.length > 0) {
    const item = result.data.items[0];
    const track = item.track;
    const data = {
      name: track.name,
      artist: track.artists.map(function(a) { return a.name; }).join(", "),
      album: track.album.name,
      image: track.album.images.length > 0 ? track.album.images[track.album.images.length > 1 ? 1 : 0].url : null,
      url: track.external_urls.spotify,
      played_at: item.played_at,
    };
    spotifyCache = { data: data, fetchedAt: Date.now() };
    return data;
  }
  return null;
}

const homepage = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
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
      const data = await fetchRecentlyPlayed();
      if (data) return json(res, data);
      return json(res, { error: "No data. Visit /login to connect Spotify." }, 401);
    } catch {
      if (spotifyCache.data) return json(res, spotifyCache.data);
      return json(res, { error: "Spotify unavailable" }, 502);
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

  return json(res, { error: "Not found" }, 404);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // Spotify OAuth: login redirect
  if (reqUrl.pathname === "/login") {
    const scope = "user-read-recently-played";
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
        res.writeHead(302, { Location: "/" });
        res.end();
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
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(homepage);
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log(`client connected (${wss.clients.size} total)`);
  ws.on("close", () => console.log(`client disconnected (${wss.clients.size} total)`));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`caelpi running on http://localhost:${PORT}`);
});
