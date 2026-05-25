const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

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

  return json(res, { error: "Not found" }, 404);
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    try {
      await handleApi(req, res, wss);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
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
