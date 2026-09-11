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

const TEST_EVENT_ID =
  "telegram-test";

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
    version: "3.0.0",
    testChannel:
      `@${TEST_CHANNEL_USERNAME}`,
    geocoder:
      "Nominatim / OpenStreetMap"
  });
});


app.get("/health", (req, res) => {
  cleanupExpiredEvents();

  res.json({
    ok: true,
    timestamp:
      new Date().toISOString(),
    events:
      events.size
  });
});


// ============================================================
// EVENTS
// ============================================================

app.get("/events", (req, res) => {
  cleanupExpiredEvents();

  res.json({
    events:
      Array.from(events.values())
  });
});


app.post("/events", (req, res) => {
  const body =
    req.body || {};

  if (
    typeof body.lat !== "number" ||
    typeof body.lon !== "number"
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "lat and lon must be numbers"
    });
  }

  const now =
    Date.now();

  const event = {
    id:
      body.id ||
      `event-${now}`,

    type:
      body.type ||
      "test",

    color:
      body.color ||
      "red",

    label:
      body.label ||
      "TEST",

    place:
      body.place ||
      null,

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
    events.delete(
      req.params.id
    );

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
  const now =
    Date.now();

  const event = {
    id:
      "manual-test",

    type:
      "test",

    color:
      "red",

    label:
      "TEST",

    place:
      "Біла Церква",

    lat:
      49.7968,

    lon:
      30.1153,

    createdAt:
      now,

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
// TEXT NORMALIZATION
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
// REMOVE SERVICE WORDS
// ============================================================

function cleanMessage(text) {
  let value =
    normalizeText(text);

  // Beginning constructions:
  //
  // Від Славутича
  // З Славутича
  // Із Славутича
  // На Заворичі
  // До Білої Церкви
  // Біля Фастова
  // Заходить на Заворичі
  //

  value =
    value.replace(
      /^(заходить|заходить на|йде|летить|рухається|рухається на|напрямок|напрямку)\s+/i,
      ""
    );

  value =
    value.replace(
      /^(від|з|із|зі|на|до|біля|коло|через|у|в)\s+/i,
      ""
    );

  value =
    value.replace(
      /^(заходить|йде|летить|рухається)\s+/i,
      ""
    );

  return value.trim();
}


// ============================================================
// EXTRACT POSSIBLE PLACE
// ============================================================

function buildSearchVariants(text) {
  const original =
    normalizeText(text);

  const cleaned =
    cleanMessage(original);

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

  // Whole message
  add(original);

  // Remove more common words
  let reduced =
    cleaned
      .replace(
        /\b(днс|центр|район|р-н|область|обл)\b/g,
        " "
      )
      .replace(/\s+/g, " ")
      .trim();

  add(reduced);

  // Last 1–4 words
  const words =
    cleaned.split(" ");

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

async function nominatimSearch(query) {
  const url =
    `${NOMINATIM_URL}` +
    `?format=jsonv2` +
    `&limit=5` +
    `&countrycodes=ua` +
    `&addressdetails=1` +
    `&accept-language=uk` +
    `&q=${encodeURIComponent(query + ", Київська область, Україна")}`;

  const response =
    await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "ONLINE-RADAR-Test/3.0"
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
// IS KYIV OBLAST
// ============================================================

function isKyivOblast(result) {
  if (!result) {
    return false;
  }

  const address =
    result.address || {};

  const state =
    normalizeText(
      address.state || ""
    );

  const stateDistrict =
    normalizeText(
      address.state_district || ""
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
    state ===
    "київська"
  ) {
    return true;
  }

  if (
    stateDistrict.includes(
      "київська область"
    )
  ) {
    return true;
  }

  return display.includes(
    "київська область"
  );
}


// ============================================================
// IS SETTLEMENT
// ============================================================

function isSettlement(result) {
  if (!result) {
    return false;
  }

  const type =
    String(
      result.type || ""
    ).toLowerCase();

  const category =
    String(
      result.category || ""
    ).toLowerCase();

  const address =
    result.address || {};

  const place =
    String(
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.hamlet ||
      address.suburb ||
      ""
    ).trim();

  if (place) {
    return true;
  }

  const allowedTypes = [
    "city",
    "town",
    "village",
    "hamlet",
    "municipality"
  ];

  if (
    allowedTypes.includes(type)
  ) {
    return true;
  }

  if (
    category ===
    "place"
  ) {
    return true;
  }

  return false;
}


// ============================================================
// GET BEST PLACE NAME
// ============================================================

function getPlaceName(result) {
  const address =
    result.address || {};

  return (
    address.city ||
    address.town ||
    address.village ||
    address.hamlet ||
    address.municipality ||
    result.name ||
    ""
  );
}


// ============================================================
// GEOCODE MESSAGE
// ============================================================

async function findPlace(text) {
  const variants =
    buildSearchVariants(text);

  console.log(
    "Search variants:",
    variants
  );

  for (const variant of variants) {
    if (!variant) {
      continue;
    }

    const cacheKey =
      variant;

    if (
      geocodeCache.has(cacheKey)
    ) {
      const cached =
        geocodeCache.get(
          cacheKey
        );

      if (cached) {
        return cached;
      }

      continue;
    }

    try {
      console.log(
        `Geocoding: "${variant}"`
      );

      const results =
        await nominatimSearch(
          variant
        );

      if (
        !Array.isArray(results)
      ) {
        continue;
      }

      for (const result of results) {
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

        const placeName =
          getPlaceName(result);

        if (!placeName) {
          continue;
        }

        const place = {
          name:
            placeName,

          lat:
            lat,

          lon:
            lon,

          osmType:
            result.type ||
            null,

          displayName:
            result.display_name ||
            null
        };

        geocodeCache.set(
          cacheKey,
          place
        );

        console.log(
          `MATCHED: ${place.name}`
        );

        console.log(
          `Coordinates: ${place.lat}, ${place.lon}`
        );

        return place;
      }

      geocodeCache.set(
        cacheKey,
        null
      );

    } catch (error) {
      console.error(
        `Geocoding error for "${variant}":`,
        error.message
      );
    }
  }

  return null;
}


// ============================================================
// CREATE TELEGRAM TEST EVENT
// ============================================================

async function createTelegramTestEvent(
  place,
  originalMessage
) {
  const now =
    Date.now();

  // Remove previous point
  events.delete(
    TEST_EVENT_ID
  );

  const event = {
    id:
      TEST_EVENT_ID,

    type:
      "test",

    color:
      "red",

    label:
      "TEST",

    place:
      place.name,

    sourceMessage:
      originalMessage,

    lat:
      place.lat,

    lon:
      place.lon,

    createdAt:
      now,

    expiresAt:
      now + TEST_EVENT_TTL
  };

  events.set(
    TEST_EVENT_ID,
    event
  );

  console.log(
    "================================"
  );

  console.log(
    "TEST EVENT CREATED"
  );

  console.log(
    `Message: ${originalMessage}`
  );

  console.log(
    `Matched: ${place.name}`
  );

  console.log(
    `Coordinates: ${place.lat}, ${place.lon}`
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

      if (!channelPost) {
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

      // VERY IMPORTANT:
      // Only our test channel.
      if (
        username !==
        TEST_CHANNEL_USERNAME
          .toLowerCase()
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

      const text =
        channelPost.text ||
        channelPost.caption ||
        "";

      const message =
        String(text).trim();

      console.log(
        "--------------------------------"
      );

      console.log(
        `Telegram test channel message: ${message}`
      );

      if (!message) {
        return res.json({
          ok: true,
          ignored: true,
          reason:
            "empty message"
        });
      }

      const place =
        await findPlace(
          message
        );

      if (!place) {
        console.log(
          `NO MATCH: ${message}`
        );

        return res.json({
          ok: true,
          ignored: true,
          reason:
            "settlement not found"
        });
      }

      const event =
        await createTelegramTestEvent(
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
  (socket) => {
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

server.listen(
  PORT,
  async () => {
    console.log(
      "================================"
    );

    console.log(
      "ONLINE RADAR backend"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Test channel: @${TEST_CHANNEL_USERNAME}`
    );

    console.log(
      "Geocoder: Nominatim"
    );

    console.log(
      "================================"
    );

    await setupTelegramWebhook();
  }
);
