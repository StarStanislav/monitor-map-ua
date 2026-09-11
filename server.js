const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ============================================================
// CONFIG
// ============================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const TEST_CHANNEL_USERNAME = "radaronlinetest";

const KATOTTG_URL =
  "https://raw.githubusercontent.com/0G3RA/ua-geo-set/main/data/kattog.json";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// ============================================================
// STATE
// ============================================================

const events = new Map();

const clients = new Set();

let geoDatabase = null;
let geoReady = false;

const geocodeCache = new Map();

const TEST_EVENT_ID = "telegram-test";

const TEST_EVENT_TTL = 10 * 60 * 1000;

// ============================================================
// BASIC
// ============================================================

app.get("/", (req, res) => {
  res.json({
    name: "ONLINE RADAR backend",
    status: "online",
    version: "2.0.0",
    testChannel: `@${TEST_CHANNEL_USERNAME}`,
    geoDatabase: geoReady ? "ready" : "loading"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    geoDatabase: geoReady,
    events: events.size
  });
});

// ============================================================
// EVENTS
// ============================================================

app.get("/events", (req, res) => {
  cleanupExpiredEvents();

  res.json({
    events: Array.from(events.values())
  });
});

app.post("/events", (req, res) => {
  const body = req.body || {};

  if (
    typeof body.lat !== "number" ||
    typeof body.lon !== "number"
  ) {
    return res.status(400).json({
      ok: false,
      error: "lat and lon are required numbers"
    });
  }

  const event = {
    id: body.id || `event-${Date.now()}`,
    type: body.type || "test",
    color: body.color || "red",
    label: body.label || "TEST",
    lat: body.lat,
    lon: body.lon,
    createdAt: Date.now(),
    expiresAt:
      typeof body.expiresAt === "number"
        ? body.expiresAt
        : Date.now() + TEST_EVENT_TTL
  };

  events.set(event.id, event);

  broadcastState();

  res.json({
    ok: true,
    event
  });
});

app.delete("/events/:id", (req, res) => {
  const id = req.params.id;

  const existed = events.delete(id);

  broadcastState();

  res.json({
    ok: true,
    deleted: existed,
    id
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

// ============================================================
// SIMPLE TEST EVENT
// ============================================================

app.get("/test-event", (req, res) => {
  const event = {
    id: "manual-test",
    type: "test",
    color: "red",
    label: "TEST",
    lat: 49.7968,
    lon: 30.1153,
    createdAt: Date.now(),
    expiresAt: Date.now() + TEST_EVENT_TTL
  };

  events.set(event.id, event);

  broadcastState();

  res.json({
    ok: true,
    event
  });
});

// ============================================================
// GEO DATABASE
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/’/g, "'")
    .replace(/`/g, "'")
    .replace(/[.,!?;:()[\]{}"“”„]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryToType(category) {
  switch (category) {
    case "M":
      return "city";

    case "X":
      return "settlement";

    case "C":
      return "village";

    case "T":
      return "urban";

    default:
      return "other";
  }
}

function buildGeoDatabase(raw) {
  if (
    !raw ||
    !Array.isArray(raw.items) ||
    !Array.isArray(raw.indexToCode)
  ) {
    throw new Error("Invalid KATOTTG database format");
  }

  const items = raw.items;
  const indexToCode = raw.indexToCode;

  const indexMap = new Map();

  for (let i = 0; i < items.length; i++) {
    indexMap.set(i, items[i]);
  }

  // ----------------------------------------------------------
  // Find Kyiv Oblast
  // ----------------------------------------------------------

  let kyivOblastIndex = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (
      item &&
      item.category === "O" &&
      normalizeText(item.name) === normalizeText("Київська область")
    ) {
      kyivOblastIndex = i;
      break;
    }
  }

  if (kyivOblastIndex === -1) {
    throw new Error("Kyiv Oblast not found in KATOTTG database");
  }

  const kyivOblastCode = indexToCode[kyivOblastIndex];

  // ----------------------------------------------------------
  // Determine region for every item
  // ----------------------------------------------------------

  const regionCache = new Map();

  function findRegionIndex(index) {
    if (regionCache.has(index)) {
      return regionCache.get(index);
    }

    const visited = new Set();

    let currentIndex = index;

    while (
      currentIndex !== undefined &&
      currentIndex !== null &&
      !visited.has(currentIndex)
    ) {
      visited.add(currentIndex);

      const item = indexMap.get(currentIndex);

      if (!item) {
        break;
      }

      if (item.category === "O") {
        regionCache.set(index, currentIndex);
        return currentIndex;
      }

      if (
        item.category === "K" &&
        item.independent === true
      ) {
        regionCache.set(index, currentIndex);
        return currentIndex;
      }

      currentIndex = item.parent;
    }

    regionCache.set(index, null);

    return null;
  }

  // ----------------------------------------------------------
  // Build settlements list
  // ----------------------------------------------------------

  const settlements = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (!item) {
      continue;
    }

    // Only actual settlements.
    //
    // M = city
    // X = settlement
    // C = village
    // T = old urban-type settlement
    //
    if (!["M", "X", "C", "T"].includes(item.category)) {
      continue;
    }

    const regionIndex = findRegionIndex(i);

    if (regionIndex !== kyivOblastIndex) {
      continue;
    }

    const code = indexToCode[i];

    settlements.push({
      id: code,
      name: item.name,
      normalizedName: normalizeText(item.name),
      type: categoryToType(item.category),
      category: item.category,
      index: i,
      parentIndex:
        item.parent !== undefined ? item.parent : null
    });
  }

  // ----------------------------------------------------------
  // Build lookup
  // ----------------------------------------------------------

  const exact = new Map();

  for (const place of settlements) {
    const key = place.normalizedName;

    if (!exact.has(key)) {
      exact.set(key, []);
    }

    exact.get(key).push(place);
  }

  return {
    regionCode: kyivOblastCode,
    settlements,
    exact,
    items,
    indexToCode
  };
}

async function loadGeoDatabase() {
  try {
    console.log("Loading Kyiv Oblast geographic database...");

    const response = await fetch(KATOTTG_URL, {
      headers: {
        "User-Agent": "ONLINE-RADAR-Test/2.0"
      }
    });

    if (!response.ok) {
      throw new Error(
        `KATOTTG download failed: HTTP ${response.status}`
      );
    }

    const raw = await response.json();

    geoDatabase = buildGeoDatabase(raw);

    geoReady = true;

    console.log(
      `Kyiv Oblast geographic database ready: ${geoDatabase.settlements.length} settlements`
    );

    console.log(
      `Kyiv Oblast KATOTTG: ${geoDatabase.regionCode}`
    );
  } catch (error) {
    geoReady = false;

    console.error(
      "Failed to load geographic database:",
      error.message
    );
  }
}

// ============================================================
// PLACE SEARCH
// ============================================================

function findPlace(message) {
  if (!geoDatabase || !geoReady) {
    return null;
  }

  const original = String(message || "").trim();

  if (!original) {
    return null;
  }

  const normalized = normalizeText(original);

  // ----------------------------------------------------------
  // 1. Exact match
  // ----------------------------------------------------------

  const exactMatches = geoDatabase.exact.get(normalized);

  if (exactMatches && exactMatches.length > 0) {
    return exactMatches[0];
  }

  // ----------------------------------------------------------
  // 2. Remove common extra words
  // ----------------------------------------------------------

  const cleaned = normalized
    .replace(/\b(днс|центр|район|р-н)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned !== normalized) {
    const cleanedMatches = geoDatabase.exact.get(cleaned);

    if (cleanedMatches && cleanedMatches.length > 0) {
      return cleanedMatches[0];
    }
  }

  // ----------------------------------------------------------
  // 3. Message starts with settlement name
  // ----------------------------------------------------------

  let best = null;

  for (const place of geoDatabase.settlements) {
    const name = place.normalizedName;

    if (!name || name.length < 3) {
      continue;
    }

    if (
      normalized === name ||
      normalized.startsWith(name + " ")
    ) {
      if (!best || name.length > best.normalizedName.length) {
        best = place;
      }
    }
  }

  if (best) {
    return best;
  }

  // ----------------------------------------------------------
  // 4. Message contains exact settlement name
  // ----------------------------------------------------------

  for (const place of geoDatabase.settlements) {
    const name = place.normalizedName;

    if (!name || name.length < 4) {
      continue;
    }

    if (normalized.includes(name)) {
      if (!best || name.length > best.normalizedName.length) {
        best = place;
      }
    }
  }

  return best;
}

// ============================================================
// GEOCODING
// ============================================================

async function geocodePlace(place) {
  if (!place) {
    return null;
  }

  const cacheKey = place.id || place.normalizedName;

  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey);
  }

  const query =
    `${place.name}, Київська область, Україна`;

  const url =
    `${NOMINATIM_URL}?format=jsonv2&limit=1&countrycodes=ua&q=${encodeURIComponent(query)}`;

  try {
    console.log(`Geocoding: ${query}`);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "ONLINE-RADAR-Test/2.0 (Telegram test channel)"
      }
    });

    if (!response.ok) {
      throw new Error(
        `Nominatim HTTP ${response.status}`
      );
    }

    const results = await response.json();

    if (!Array.isArray(results) || results.length === 0) {
      console.log(`No coordinates found for: ${place.name}`);
      return null;
    }

    const result = results[0];

    const lat = Number(result.lat);
    const lon = Number(result.lon);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      return null;
    }

    const coordinates = {
      lat,
      lon
    };

    geocodeCache.set(cacheKey, coordinates);

    return coordinates;
  } catch (error) {
    console.error(
      `Geocoding failed for ${place.name}:`,
      error.message
    );

    return null;
  }
}

// ============================================================
// CREATE TEST EVENT FROM PLACE
// ============================================================

async function createTestEventFromPlace(place) {
  const coordinates = await geocodePlace(place);

  if (!coordinates) {
    return {
      ok: false,
      error: `Не вдалося отримати координати для ${place.name}`
    };
  }

  // ----------------------------------------------------------
  // Remove previous Telegram test point
  // ----------------------------------------------------------

  events.delete(TEST_EVENT_ID);

  // ----------------------------------------------------------
  // Create new point
  // ----------------------------------------------------------

  const now = Date.now();

  const event = {
    id: TEST_EVENT_ID,

    type: "test",

    color: "red",

    label: "TEST",

    place: place.name,

    placeType: place.type,

    katottg: place.id,

    lat: coordinates.lat,

    lon: coordinates.lon,

    createdAt: now,

    expiresAt: now + TEST_EVENT_TTL
  };

  events.set(TEST_EVENT_ID, event);

  console.log(
    `TEST event: ${place.name} (${coordinates.lat}, ${coordinates.lon})`
  );

  broadcastState();

  return {
    ok: true,
    event
  };
}

// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body || {};

    // --------------------------------------------------------
    // Only channel posts
    // --------------------------------------------------------

    const channelPost = update.channel_post;

    if (!channelPost) {
      return res.json({
        ok: true,
        ignored: true,
        reason: "not a channel_post"
      });
    }

    // --------------------------------------------------------
    // Only our test channel
    // --------------------------------------------------------

    const chat = channelPost.chat || {};

    const username = String(
      chat.username || ""
    ).replace(/^@/, "").toLowerCase();

    if (
      username !==
      TEST_CHANNEL_USERNAME.toLowerCase()
    ) {
      console.log(
        `Ignored Telegram channel: @${username || "unknown"}`
      );

      return res.json({
        ok: true,
        ignored: true,
        reason: "wrong test channel"
      });
    }

    // --------------------------------------------------------
    // Text
    // --------------------------------------------------------

    const text =
      channelPost.text ||
      channelPost.caption ||
      "";

    const message = String(text).trim();

    console.log(
      `Telegram test channel message: ${message}`
    );

    if (!message) {
      return res.json({
        ok: true,
        ignored: true,
        reason: "empty message"
      });
    }

    // --------------------------------------------------------
    // Make sure database is ready
    // --------------------------------------------------------

    if (!geoReady) {
      return res.status(503).json({
        ok: false,
        error: "Geographic database is still loading"
      });
    }

    // --------------------------------------------------------
    // Find settlement
    // --------------------------------------------------------

    const place = findPlace(message);

    if (!place) {
      console.log(
        `Settlement not found: ${message}`
      );

      return res.json({
        ok: true,
        ignored: true,
        reason: "settlement not found",
        message
      });
    }

    console.log(
      `Matched settlement: ${place.name} (${place.type})`
    );

    // --------------------------------------------------------
    // Create / move TEST marker
    // --------------------------------------------------------

    const result =
      await createTestEventFromPlace(place);

    return res.json(result);

  } catch (error) {
    console.error(
      "Telegram webhook error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ============================================================
// TELEGRAM WEBHOOK SETUP
// ============================================================

async function setupTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log(
      "TELEGRAM_BOT_TOKEN is not configured"
    );

    return;
  }

  const webhookUrl =
    `https://monitor-map-ua.onrender.com/telegram/webhook`;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          url: webhookUrl,

          allowed_updates: [
            "channel_post"
          ]
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
      error.message
    );
  }
}

// ============================================================
// WEBSOCKET
// ============================================================

const wss = new WebSocket.Server({
  server,
  path: "/ws"
});

wss.on("connection", (socket) => {
  clients.add(socket);

  console.log(
    `WebSocket client connected. Total: ${clients.size}`
  );

  socket.send(
    JSON.stringify({
      type: "state",
      events: Array.from(events.values())
    })
  );

  socket.on("close", () => {
    clients.delete(socket);

    console.log(
      `WebSocket client disconnected. Total: ${clients.size}`
    );
  });

  socket.on("error", () => {
    clients.delete(socket);
  });
});

function broadcastState() {
  const payload = JSON.stringify({
    type: "state",
    events: Array.from(events.values())
  });

  for (const socket of clients) {
    if (
      socket.readyState === WebSocket.OPEN
    ) {
      socket.send(payload);
    }
  }
}

// ============================================================
// EXPIRED EVENTS
// ============================================================

function cleanupExpiredEvents() {
  const now = Date.now();

  let changed = false;

  for (const [id, event] of events.entries()) {
    if (
      typeof event.expiresAt === "number" &&
      event.expiresAt <= now
    ) {
      events.delete(id);
      changed = true;

      console.log(
        `Expired event removed: ${id}`
      );
    }
  }

  if (changed) {
    broadcastState();
  }
}

setInterval(
  cleanupExpiredEvents,
  5000
);

// ============================================================
// START
// ============================================================

server.listen(PORT, async () => {
  console.log(
    `ONLINE RADAR backend listening on port ${PORT}`
  );

  console.log(
    `Test Telegram channel: @${TEST_CHANNEL_USERNAME}`
  );

  await loadGeoDatabase();

  await setupTelegramWebhook();
});
