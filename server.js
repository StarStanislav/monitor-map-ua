const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const events = new Map();
const clients = new Set();

function getEvents() {
  return Array.from(events.values());
}

function broadcast(data) {
  const message = JSON.stringify(data);

  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

function broadcastState() {
  broadcast({
    type: "state",
    events: getEvents()
  });
}

function cleanupExpiredEvents() {
  const now = Date.now();
  let changed = false;

  for (const [id, event] of events.entries()) {
    if (event.expiresAt && event.expiresAt <= now) {
      events.delete(id);
      changed = true;
    }
  }

  if (changed) {
    broadcastState();
  }
}

setInterval(cleanupExpiredEvents, 1000);

app.get("/", (req, res) => {
  res.json({
    name: "ONLINE RADAR backend",
    status: "online",
    version: "1.0.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString()
  });
});

app.get("/events", (req, res) => {
  res.json({
    ok: true,
    events: getEvents()
  });
});

app.post("/events", (req, res) => {
  const {
    id,
    name,
    lat,
    lon,
    count = 1,
    expiresIn = null
  } = req.body;

  if (!id || !name || typeof lat !== "number" || typeof lon !== "number") {
    return res.status(400).json({
      ok: false,
      error: "Required fields: id, name, lat, lon"
    });
  }

  const now = Date.now();

  const event = {
    id: String(id),
    name: String(name),
    lat,
    lon,
    count: Number(count) || 1,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt:
      typeof expiresIn === "number" && expiresIn > 0
        ? now + expiresIn * 1000
        : null
  };

  events.set(event.id, event);

  broadcastState();

  res.json({
    ok: true,
    event
  });
});

app.delete("/events/:id", (req, res) => {
  const id = String(req.params.id);

  if (!events.has(id)) {
    return res.status(404).json({
      ok: false,
      error: "Event not found"
    });
  }

  events.delete(id);
  broadcastState();

  res.json({
    ok: true,
    deleted: id
  });
});

app.post("/events/reset", (req, res) => {
  events.clear();
  broadcastState();

  res.json({
    ok: true,
    events: []
  });
});

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

wss.on("connection", (ws) => {
  clients.add(ws);

  ws.send(
    JSON.stringify({
      type: "state",
      events: getEvents()
    })
  );

  ws.on("close", () => {
    clients.delete(ws);
  });

  ws.on("error", () => {
    clients.delete(ws);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ONLINE RADAR backend running on port ${PORT}`);
});
