const http = require("http");
const WebSocket = require("ws");

const store = {
  status: { text: "", emoji: "", updatedAt: null },
  notes: [],
  links: [],
};

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
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") return cors(res);

  // Status
  if (path === "/api/status" && method === "GET") {
    return json(res, store.status);
  }
  if (path === "/api/status" && method === "PUT") {
    const body = await parseBody(req);
    store.status.text = body.text ?? store.status.text;
    store.status.emoji = body.emoji ?? store.status.emoji;
    store.status.updatedAt = new Date().toISOString();
    broadcast(wss, { type: "status", data: store.status });
    return json(res, store.status);
  }

  // Notes
  if (path === "/api/notes" && method === "GET") {
    return json(res, store.notes);
  }
  if (path === "/api/notes" && method === "POST") {
    const body = await parseBody(req);
    const note = {
      id: genId(),
      text: body.text || "",
      createdAt: new Date().toISOString(),
    };
    store.notes.unshift(note);
    broadcast(wss, { type: "note_added", data: note });
    return json(res, note, 201);
  }
  if (path.startsWith("/api/notes/") && method === "DELETE") {
    const id = path.split("/").pop();
    const idx = store.notes.findIndex((n) => n.id === id);
    if (idx === -1) return json(res, { error: "Not found" }, 404);
    store.notes.splice(idx, 1);
    broadcast(wss, { type: "note_deleted", data: { id } });
    return json(res, { ok: true });
  }

  // Links
  if (path === "/api/links" && method === "GET") {
    return json(res, store.links);
  }
  if (path === "/api/links" && method === "POST") {
    const body = await parseBody(req);
    const link = {
      id: genId(),
      title: body.title || "",
      url: body.url || "",
      createdAt: new Date().toISOString(),
    };
    store.links.unshift(link);
    broadcast(wss, { type: "link_added", data: link });
    return json(res, link, 201);
  }
  if (path.startsWith("/api/links/") && method === "DELETE") {
    const id = path.split("/").pop();
    const idx = store.links.findIndex((l) => l.id === id);
    if (idx === -1) return json(res, { error: "Not found" }, 404);
    store.links.splice(idx, 1);
    broadcast(wss, { type: "link_deleted", data: { id } });
    return json(res, { ok: true });
  }

  // All data (for iOS app initial sync)
  if (path === "/api/sync" && method === "GET") {
    return json(res, store);
  }

  return json(res, { error: "Not found" }, 404);
}

const homepage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>caelpi</title>
  <style>
    :root {
      --bg: #0a0a0f;
      --surface: #141420;
      --border: #1e1e30;
      --text: #e0e0e8;
      --dim: #6a6a80;
      --accent: #7c6fe0;
      --accent-dim: #5a4fb8;
      --danger: #e05050;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 0;
    }
    .container {
      max-width: 640px;
      margin: 0 auto;
      padding: 48px 24px;
    }
    header {
      margin-bottom: 48px;
    }
    header h1 {
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.5px;
    }
    header h1 span { color: var(--dim); font-weight: 400; }

    /* Status */
    .status-section {
      margin-bottom: 40px;
      padding: 20px;
      background: var(--surface);
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    .status-display {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 32px;
      cursor: pointer;
    }
    .status-display:hover { opacity: 0.8; }
    .status-emoji { font-size: 24px; }
    .status-text { font-size: 15px; color: var(--dim); }
    .status-text.empty { font-style: italic; }
    .status-form { display: none; gap: 8px; }
    .status-form.active { display: flex; }
    .status-form input {
      flex: 1;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
    }
    .status-form input:focus { border-color: var(--accent); }
    .emoji-input { width: 48px !important; flex: none !important; text-align: center; font-size: 18px; }

    /* Sections */
    .section {
      margin-bottom: 32px;
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .section-title {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--dim);
      font-weight: 600;
    }
    .add-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--dim);
      width: 28px;
      height: 28px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .add-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    /* Items */
    .item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 6px;
      transition: border-color 0.15s;
    }
    .item:hover { border-color: #2a2a40; }
    .item-text { font-size: 14px; flex: 1; }
    .item-meta { font-size: 11px; color: var(--dim); margin-left: 12px; }
    .item-delete {
      background: none;
      border: none;
      color: var(--dim);
      cursor: pointer;
      font-size: 14px;
      padding: 4px;
      margin-left: 8px;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s;
    }
    .item:hover .item-delete { opacity: 1; }
    .item-delete:hover { color: var(--danger); }

    .link-url {
      color: var(--accent);
      text-decoration: none;
      font-size: 14px;
    }
    .link-url:hover { text-decoration: underline; }
    .link-title {
      font-size: 12px;
      color: var(--dim);
      margin-top: 2px;
    }

    /* Add forms */
    .add-form {
      display: none;
      gap: 8px;
      margin-bottom: 8px;
    }
    .add-form.active { display: flex; }
    .add-form input {
      flex: 1;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
    }
    .add-form input:focus { border-color: var(--accent); }

    .empty-state {
      text-align: center;
      padding: 24px;
      color: var(--dim);
      font-size: 13px;
      font-style: italic;
    }

    /* Connection indicator */
    .conn {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--danger);
      transition: background 0.3s;
    }
    .conn.live { background: #50c878; }

    /* Time */
    .time {
      font-size: 48px;
      font-weight: 200;
      letter-spacing: -2px;
      color: var(--text);
      margin-bottom: 4px;
      font-variant-numeric: tabular-nums;
    }
    .date {
      font-size: 14px;
      color: var(--dim);
      margin-bottom: 24px;
    }
  </style>
</head>
<body>
  <div class="conn" id="conn"></div>
  <div class="container">
    <header>
      <div class="time" id="clock"></div>
      <div class="date" id="date"></div>
    </header>

    <div class="status-section">
      <div class="status-display" id="statusDisplay" onclick="editStatus()">
        <span class="status-emoji" id="statusEmoji"></span>
        <span class="status-text empty" id="statusText">set a status...</span>
      </div>
      <div class="status-form" id="statusForm">
        <input class="emoji-input" id="statusEmojiInput" maxlength="2" placeholder="😊">
        <input id="statusTextInput" placeholder="what's happening?" autofocus>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">Notes</span>
        <button class="add-btn" onclick="toggleForm('noteForm')">+</button>
      </div>
      <div class="add-form" id="noteForm">
        <input id="noteInput" placeholder="jot something down..." onkeydown="if(event.key==='Enter')addNote()">
      </div>
      <div id="notesList"></div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">Links</span>
        <button class="add-btn" onclick="toggleForm('linkForm')">+</button>
      </div>
      <div class="add-form" id="linkForm">
        <input id="linkUrlInput" placeholder="url" onkeydown="if(event.key==='Enter')document.getElementById('linkTitleInput').focus()">
        <input id="linkTitleInput" placeholder="title (optional)" onkeydown="if(event.key==='Enter')addLink()">
      </div>
      <div id="linksList"></div>
    </div>
  </div>

  <script>
    let ws;
    let state = { status: {}, notes: [], links: [] };

    function connect() {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
      ws.onopen = () => document.getElementById('conn').classList.add('live');
      ws.onclose = () => {
        document.getElementById('conn').classList.remove('live');
        setTimeout(connect, 3000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'status') { state.status = msg.data; renderStatus(); }
        if (msg.type === 'note_added') { state.notes.unshift(msg.data); renderNotes(); }
        if (msg.type === 'note_deleted') { state.notes = state.notes.filter(n => n.id !== msg.data.id); renderNotes(); }
        if (msg.type === 'link_added') { state.links.unshift(msg.data); renderLinks(); }
        if (msg.type === 'link_deleted') { state.links = state.links.filter(l => l.id !== msg.data.id); renderLinks(); }
      };
    }

    async function loadData() {
      const res = await fetch('/api/sync');
      state = await res.json();
      renderAll();
    }

    function renderAll() {
      renderStatus();
      renderNotes();
      renderLinks();
    }

    function renderStatus() {
      const s = state.status;
      const emoji = document.getElementById('statusEmoji');
      const text = document.getElementById('statusText');
      emoji.textContent = s.emoji || '';
      if (s.text) {
        text.textContent = s.text;
        text.classList.remove('empty');
      } else {
        text.textContent = 'set a status...';
        text.classList.add('empty');
      }
    }

    function editStatus() {
      const display = document.getElementById('statusDisplay');
      const form = document.getElementById('statusForm');
      display.style.display = 'none';
      form.classList.add('active');
      document.getElementById('statusEmojiInput').value = state.status.emoji || '';
      document.getElementById('statusTextInput').value = state.status.text || '';
      document.getElementById('statusTextInput').focus();
    }

    document.getElementById('statusForm').addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const emoji = document.getElementById('statusEmojiInput').value;
        const text = document.getElementById('statusTextInput').value;
        await fetch('/api/status', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji, text })
        });
        document.getElementById('statusDisplay').style.display = 'flex';
        document.getElementById('statusForm').classList.remove('active');
      }
      if (e.key === 'Escape') {
        document.getElementById('statusDisplay').style.display = 'flex';
        document.getElementById('statusForm').classList.remove('active');
      }
    });

    function renderNotes() {
      const el = document.getElementById('notesList');
      if (!state.notes.length) {
        el.innerHTML = '<div class="empty-state">no notes yet</div>';
        return;
      }
      el.innerHTML = state.notes.map(n => {
        const ago = timeAgo(n.createdAt);
        return '<div class="item"><span class="item-text">' + escHtml(n.text) + '</span><span class="item-meta">' + ago + '</span><button class="item-delete" onclick="deleteNote(\'' + n.id + '\')">&times;</button></div>';
      }).join('');
    }

    function renderLinks() {
      const el = document.getElementById('linksList');
      if (!state.links.length) {
        el.innerHTML = '<div class="empty-state">no links yet</div>';
        return;
      }
      el.innerHTML = state.links.map(l => {
        const display = l.url.replace(/^https?:\\/\\//, '').replace(/\\/$/, '');
        return '<div class="item"><div><a class="link-url" href="' + escAttr(l.url) + '" target="_blank" rel="noopener">' + escHtml(l.title || display) + '</a>' +
          (l.title ? '<div class="link-title">' + escHtml(display) + '</div>' : '') +
          '</div><button class="item-delete" onclick="deleteLink(\'' + l.id + '\')">&times;</button></div>';
      }).join('');
    }

    async function addNote() {
      const input = document.getElementById('noteInput');
      const text = input.value.trim();
      if (!text) return;
      await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      input.value = '';
    }

    async function addLink() {
      const urlInput = document.getElementById('linkUrlInput');
      const titleInput = document.getElementById('linkTitleInput');
      let url = urlInput.value.trim();
      const title = titleInput.value.trim();
      if (!url) return;
      if (!/^https?:\\/\\//.test(url)) url = 'https://' + url;
      await fetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title })
      });
      urlInput.value = '';
      titleInput.value = '';
    }

    async function deleteNote(id) {
      await fetch('/api/notes/' + id, { method: 'DELETE' });
    }

    async function deleteLink(id) {
      await fetch('/api/links/' + id, { method: 'DELETE' });
    }

    function toggleForm(id) {
      const form = document.getElementById(id);
      const isActive = form.classList.contains('active');
      form.classList.toggle('active');
      if (!isActive) form.querySelector('input').focus();
    }

    function escHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function escAttr(s) {
      return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function timeAgo(iso) {
      const diff = Date.now() - new Date(iso).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1) return 'now';
      if (m < 60) return m + 'm';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h';
      const d = Math.floor(h / 24);
      return d + 'd';
    }

    // Clock
    function updateClock() {
      const now = new Date();
      document.getElementById('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      document.getElementById('date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    }
    updateClock();
    setInterval(updateClock, 1000);

    connect();
    loadData();
  </script>
</body>
</html>`;

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
