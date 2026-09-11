const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "";

const TEST_CHANNEL_USERNAME =
  "radaronlinetest";

const TEST_EVENT_TTL =
  10 * 60 * 1000;

const NOMINATIM_URL =
  "https://nominatim.openstreetmap.org/search";

const events = new Map();
const clients = new Set();
const geocodeCache = new Map();


// ============================================================
// BASIC
// ============================================================

app.get("/", (req, res) => {
  res.json({
    name: "ONLINE RADAR backend",
    status: "online",
    version: "4.0.0",
    testChannel: `@${TEST_CHANNEL_USERNAME}`
  });
});


app.get("/health", (req, res) => {
  cleanupExpiredEvents();

  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
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
      error: "lat and lon must be numbers"
    });
  }

  const now = Date.now();

  const event = {
    id:
      body.id ||
      `event-${now}`,

    type:
      body.type ||
      "test",

    color:
      "red",

    label:
      "",

    place:
      body.place || "",

    lat:
      body.lat,

    lon:
      body.lon,

    createdAt:
      now,

    expiresAt:
      body.expiresAt ||
      now + TEST_EVENT_TTL
  };

  events.set(
    event.id,
    event
  );

  broadcastState();

  res.json({
    ok: true,
    event
  });
});


app.delete("/events/:id", (req, res) => {
  const deleted =
    events.delete(req.params.id);

  broadcastState();

  res.json({
    ok: true,
    deleted
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
// MANUAL TEST
// ============================================================

app.get("/test-event", (req, res) => {
  const now = Date.now();

  const event = {
    id: "manual-test",

    type: "test",

    color: "red",

    label: "",

    place: "Біла Церква",

    lat: 49.7968,

    lon: 30.1153,

    createdAt: now,

    expiresAt:
      now + TEST_EVENT_TTL
  };

  events.set(
    event.id,
    event
  );

  broadcastState();

  res.json({
    ok: true,
    event
  });
});


// ============================================================
// NORMALIZATION
// ============================================================

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[’`]/g, "'")
    .replace(/[.,!?;:()[\]{}"“”„]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


// ============================================================
// EXTRACT TEST ID
//
// Supported:
//
// 1 Біла Церква
// 1 Трушки
// 2 Яготин
//
// Also:
//
// TEST-1 Біла Церква
// TEST 1 Біла Церква
//
// ============================================================

function parseMessage(text) {
  let value =
    String(text || "").trim();

  let id = null;

  let match =
    value.match(
      /^(?:test[-\s]*)?(\d+)\s+(.+)$/iu
    );

  if (match) {
    id =
      Number(match[1]);

    value =
      match[2].trim();
  }

  return {
    id,
    text: value
  };
}


// ============================================================
// CLEAN LOCATION TEXT
// ============================================================

function cleanLocationText(text) {
  let value =
    normalizeText(text);

  value =
    value.replace(
      /^(заходить|заходить на|йде|летить|рухається|рухається на|рух на|напрямок|напрямку)\s+/iu,
      ""
    );

  value =
    value.replace(
      /^(від|з|із|зі|на|до|біля|коло|через|у|в|в напрямку)\s+/iu,
      ""
    );

  value =
    value.replace(
      /^(заходить|йде|летить|рухається)\s+/iu,
      ""
    );

  value =
    value.replace(
      /\b(один|одна|одне)\b/giu,
      ""
    );

  value =
    value
      .replace(/\s+/g, " ")
      .trim();

  return value;
}


// ============================================================
// SEARCH VARIANTS
// ============================================================

function buildVariants(text) {
  const original =
    normalizeText(text);

  const cleaned =
    cleanLocationText(original);

  const variants = [];

  function add(value) {
    value =
      normalizeText(value);

    if (
      value &&
      !variants.includes(value)
    ) {
      variants.push(value);
    }
  }

  add(cleaned);
  add(original);

  const words =
    cleaned.split(" ");

  // Try the whole phrase and shorter endings.
  for (
    let count = 1;
    count <= Math.min(4, words.length);
    count++
  ) {
    add(
      words
        .slice(
          words.length - count
        )
        .join(" ")
    );
  }

  return variants;
}


// ============================================================
// NOMINATIM
// ============================================================

async function searchNominatim(query) {
  const url =
    `${NOMINATIM_URL}` +
    `?format=jsonv2` +
    `&limit=8` +
    `&countrycodes=ua` +
    `&addressdetails=1` +
    `&accept-language=uk` +
    `&q=${encodeURIComponent(
      query +
      ", Київська область, Україна"
    )}`;

  const response =
    await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "ONLINE-RADAR-Test/4.0"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `Nominatim HTTP ${response.status}`
    );
  }

  return await response.json();
}


// ============================================================
// KYIV OBLAST CHECK
// ============================================================

function isKyivOblast(result) {
  const address =
    result.address || {};

  const state =
    normalizeText(
      address.state || ""
    );

  const display =
    normalizeText(
      result.display_name || ""
    );

  if (
    state.includes(
      "київська область"
    )
  ) {
    return true;
  }

  if (
    state === "київська"
  ) {
    return true;
  }

  if (
    display.includes(
      "київська область"
    )
  ) {
    return true;
  }

  return false;
}


// ============================================================
// SETTLEMENT CHECK
// ============================================================

function isSettlement(result) {
  const type =
    String(
      result.type || ""
    ).toLowerCase();

  const address =
    result.address || {};

  const settlement =
    address.city ||
    address.town ||
    address.village ||
    address.hamlet ||
    "";

  if (
    settlement
  ) {
    return true;
  }

  return [
    "city",
    "town",
    "village",
    "hamlet"
  ].includes(type);
}


// ============================================================
// PLACE NAME
// ============================================================

function getPlaceName(result) {
  const address =
    result.address || {};

  return (
    address.city ||
    address.town ||
    address.village ||
    address.hamlet ||
    result.name ||
    ""
  );
}


// ============================================================
// FIND PLACE
// ============================================================

async function findPlace(text) {
  const variants =
    buildVariants(text);

  console.log(
    "Search variants:",
    variants
  );

  for (
    const variant of variants
  ) {
    const cacheKey =
      variant;

    if (
      geocodeCache.has(cacheKey)
    ) {
      const cached =
        geocodeCache.get(cacheKey);

      if (cached) {
        console.log(
          `CACHE MATCH: ${cached.name}`
        );

        return cached;
      }

      continue;
    }

    try {
      console.log(
        `Geocoding: "${variant}"`
      );

      const results =
        await searchNominatim(
          variant
        );

      for (
        const result of results
      ) {
        if (
          !isKyivOblast(result)
        ) {
          continue;
        }

        if (
          !isSettlement(result)
        ) {
          continue;
        }

        const lat =
          Number(result.lat);

        const lon =
          Number(result.lon);

        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon)
        ) {
          continue;
        }

        const place = {
          name:
            getPlaceName(result),

          lat,

          lon,

          displayName:
            result.display_name || ""
        };

        if (
          !place.name
        ) {
          continue;
        }

        geocodeCache.set(
          cacheKey,
          place
        );

        console.log(
          `MATCHED: ${place.name}`
        );

        console.log(
          `Coordinates: ${lat}, ${lon}`
        );

        return place;
      }

      geocodeCache.set(
        cacheKey,
        null
      );

    } catch (error) {
      console.error(
        `Geocoding error: ${error.message}`
      );
    }
  }

  return null;
}


// ============================================================
// CREATE / MOVE POINT
// ============================================================

async function createOrMovePoint(
  pointId,
  place,
  originalMessage
) {
  const now =
    Date.now();

  const eventId =
    `telegram-test-${pointId}`;

  const event = {
    id:
      eventId,

    pointId:
      pointId,

    type:
      "test",

    color:
      "red",

    // NO TEST TEXT
    label:
      "",

    place:
      place.name,

    sourceMessage:
      originalMessage,

    lat:
      place.lat,

    lon:
      place.lon,

    createdAt:
      events.has(eventId)
        ? events.get(eventId).createdAt
        : now,

    updatedAt:
      now,

    expiresAt:
      now + TEST_EVENT_TTL
  };

  events.set(
    eventId,
    event
  );

  console.log(
    "================================"
  );

  console.log(
    `POINT ${pointId}`
  );

  console.log(
    `Message: ${originalMessage}`
  );

  console.log(
    `Place: ${place.name}`
  );

  console.log(
    `Coordinates: ${place.lat}, ${place.lon}`
  );

  console.log(
    "Action: CREATED / MOVED"
  );

  console.log(
    "================================"
  );

  broadcastState();

  return event;
}


// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

app.post(
  "/telegram/webhook",
  async (req, res) => {
    try {
      const update =
        req.body || {};

      const channelPost =
        update.channel_post;

      if (
        !channelPost
      ) {
        return res.json({
          ok: true,
          ignored: true,
          reason:
            "not channel_post"
        });
      }

      const chat =
        channelPost.chat || {};

      const username =
        String(
          chat.username || ""
        )
          .replace(/^@/, "")
          .toLowerCase();

      // ONLY TEST CHANNEL
      if (
        username !==
        TEST_CHANNEL_USERNAME
      ) {
        console.log(
          `Ignored channel: @${username}`
        );

        return res.json({
          ok: true,
          ignored: true,
          reason:
            "wrong channel"
        });
      }

      const message =
        String(
          channelPost.text ||
          channelPost.caption ||
          ""
        ).trim();

      console.log(
        "--------------------------------"
      );

      console.log(
        `Telegram test channel message: ${message}`
      );

      if (
        !message
      ) {
        return res.json({
          ok: true,
          ignored: true,
          reason:
            "empty message"
        });
      }

      const parsed =
        parseMessage(message);

      console.log(
        `Point ID: ${
          parsed.id !== null
            ? parsed.id
            : "AUTO"
        }`
      );

      console.log(
        `Location text: ${parsed.text}`
      );

      const place =
        await findPlace(
          parsed.text
        );

      if (
        !place
      ) {
        console.log(
          `NO MATCH: ${parsed.text}`
        );

        return res.json({
          ok: true,
          matched: false,
          reason:
            "settlement not found"
        });
      }

      // ------------------------------------------------------
      // If a number is supplied, use it as the point ID.
      //
      // Example:
      //
      // 1 Біла Церква
      // 1 Трушки
      //
      // Otherwise create an automatic unique point.
      // ------------------------------------------------------

      let pointId =
        parsed.id;

      if (
        pointId === null
      ) {
        pointId =
          Date.now();
      }

      const event =
        await createOrMovePoint(
          pointId,
          place,
          message
        );

      return res.json({
        ok: true,
        matched: true,
        event
      });

    } catch (error) {
      console.error(
        "Telegram webhook error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);


// ============================================================
// TELEGRAM WEBHOOK SETUP
// ============================================================

async function setupTelegramWebhook() {
  if (
    !TELEGRAM_BOT_TOKEN
  ) {
    console.log(
      "TELEGRAM_BOT_TOKEN is not configured"
    );

    return;
  }

  const webhookUrl =
    "https://monitor-map-ua.onrender.com/telegram/webhook";

  try {
    const response =
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              url:
                webhookUrl,

              allowed_updates: [
                "channel_post"
              ]
            })
        }
      );

    const data =
      await response.json();

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

const wss =
  new WebSocket.Server({
    server,
    path: "/ws"
  });


wss.on(
  "connection",
  socket => {
    clients.add(
      socket
    );

    console.log(
      `WebSocket client connected. Total: ${clients.size}`
    );

    socket.send(
      JSON.stringify({
        type:
          "state",

        events:
          Array.from(
            events.values()
          )
      })
    );

    socket.on(
      "close",
      () => {
        clients.delete(
          socket
        );

        console.log(
          `WebSocket client disconnected. Total: ${clients.size}`
        );
      }
    );

    socket.on(
      "error",
      () => {
        clients.delete(
          socket
        );
      }
    );
  }
);


// ============================================================
// BROADCAST
// ============================================================

function broadcastState() {
  const payload =
    JSON.stringify({
      type:
        "state",

      events:
        Array.from(
          events.values()
        )
    });

  for (
    const socket of clients
  ) {
    if (
      socket.readyState ===
      WebSocket.OPEN
    ) {
      socket.send(
        payload
      );
    }
  }
}


// ============================================================
// EXPIRATION
// ============================================================

function cleanupExpiredEvents() {
  const now =
    Date.now();

  let changed =
    false;

  for (
    const [
      id,
      event
    ] of events.entries()
  ) {
    if (
      typeof event.expiresAt ===
        "number" &&
      event.expiresAt <= now
    ) {
      events.delete(
        id
      );

      changed =
        true;

      console.log(
        `Expired point removed: ${id}`
      );
    }
  }

  if (
    changed
  ) {
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

server.listen(
  PORT,
  async () => {
    console.log(
      "================================"
    );

    console.log(
      "ONLINE RADAR backend v4.0.0"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Test channel: @${TEST_CHANNEL_USERNAME}`
    );

    console.log(
      "Multiple points: ENABLED"
    );

    console.log(
      "Red markers: ENABLED"
    );

    console.log(
      "TEST label on marker: DISABLED"
    );

    console.log(
      "================================"
    );

    await setupTelegramWebhook();
  }
);
