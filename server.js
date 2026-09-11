const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDER_URL = "https://monitor-map-ua.onrender.com";

app.use(cors());
app.use(express.json());

const events = new Map();
const clients = new Set();

/* =========================================================
   EVENTS
========================================================= */

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

/* =========================================================
   BASIC
========================================================= */

app.get("/", (req, res) => {
  res.json({
    name: "ONLINE RADAR backend",
    status: "online",
    version: "1.1.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    telegram: Boolean(TELEGRAM_BOT_TOKEN)
  });
});

/* =========================================================
   EVENTS API
========================================================= */

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

  if (
    !id ||
    !name ||
    typeof lat !== "number" ||
    typeof lon !== "number"
  ) {
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

/* =========================================================
   TEST EVENT
========================================================= */

app.get("/test-event", (req, res) => {
  const now = Date.now();

  const event = {
    id: "test-point-1",
    name: "TEST",
    lat: 50.4501,
    lon: 30.5234,
    count: 1,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: now + 10 * 60 * 1000
  };

  events.set(event.id, event);

  broadcastState();

  res.json({
    ok: true,
    message: "Test event created",
    event
  });
});

/* =========================================================
   TELEGRAM WEBHOOK
   Працює тільки з нейтральними TEST-повідомленнями.
========================================================= */

app.post("/telegram/webhook", (req, res) => {

  try {

    const update = req.body;

    /*
      Telegram channel message:
      update.channel_post
    */

    const message = update?.channel_post;

    if (!message) {
      return res.json({
        ok: true,
        ignored: true
      });
    }

    const text = String(message.text || "").trim();

    console.log(
      "Telegram channel message:",
      text
    );

    /*
      Безпечний тестовий режим.

      Тільки повідомлення, які починаються з TEST,
      створюють нейтральну TEST-точку.

      Координати навмисно фіксовані:
      Kyiv.
    */

    if (!text.toUpperCase().startsWith("TEST")) {

      return res.json({
        ok: true,
        ignored: true,
        reason: "Not a TEST message"
      });

    }

    const now = Date.now();

    const event = {
      id: "telegram-test",
      name: "TEST",
      lat: 50.4501,
      lon: 30.5234,
      count: 1,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: now + 10 * 60 * 1000
    };

    events.set(event.id, event);

    broadcastState();

    console.log(
      "TEST event created from Telegram"
    );

    return res.json({
      ok: true,
      event
    });

  } catch (error) {

    console.error(
      "Telegram webhook error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "Webhook error"
    });

  }

});

/* =========================================================
   TELEGRAM WEBHOOK SETUP
========================================================= */

async function setupTelegramWebhook() {

  if (!TELEGRAM_BOT_TOKEN) {

    console.log(
      "TELEGRAM_BOT_TOKEN is not configured."
    );

    return;
  }

  try {

    const webhookUrl =
      `${RENDER_URL}/telegram/webhook`;

    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ["channel_post"]
        })
      }
    );

    const data = await response.json();

    console.log(
      "Telegram webhook setup:",
      data
    );

  } catch (error) {

    console.error(
      "Telegram webhook setup failed:",
      error
    );

  }

}

/* =========================================================
   WEBSOCKET
========================================================= */

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

/* =========================================================
   START SERVER
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  async () => {

    console.log(
      `ONLINE RADAR backend running on port ${PORT}`
    );

    await setupTelegramWebhook();

  }
);
