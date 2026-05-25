const http = require("http");
const WebSocket = require("ws");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("WebSocket server is running. Connect via wss://ws.babylettuce.net");
});

const wss = new WebSocket.Server({ server });

const clients = new Map();

wss.on("connection", (ws, req) => {
  const id = req.headers["x-client-id"] || `client-${Date.now()}`;
  clients.set(id, ws);
  console.log(`${id} connected (${clients.size} total)`);

  ws.on("message", (data) => {
    const msg = data.toString();
    console.log(`${id}: ${msg}`);
    for (const [cid, client] of clients) {
      if (cid !== id && client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  });

  ws.on("close", () => {
    clients.delete(id);
    console.log(`${id} disconnected`);
  });
});

server.listen(8080, () => {
  console.log("Server running on http://0.0.0.0:8080");
});