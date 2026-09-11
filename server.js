const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT =
  process.env.PORT || 10000;

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "";

const TEST_CHANNEL_USERNAME =
  "radaronlinetest";

const TEST_EVENT_TTL =
  10 * 60 * 1000;

const NOMINATIM_URL =
  "https://nominatim.openstreetmap.org/search";

const events =
  new Map();

const clients =
  new Set();

const geocodeCache =
  new Map();


// ============================================================
// BASIC
// ============================================================

app.get("/", (req, res) => {

  res.json({
    name:
      "ONLINE RADAR backend",

    status:
      "online",

    version:
      "6.0.0",

    testChannel:
      `@${TEST_CHANNEL_USERNAME}`
  });

});


app.get("/health", (req, res) => {

  cleanupExpiredEvents();

  res.json({
    ok:
      true,

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
      Array.from(
        events.values()
      )
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
      ok:
        false,

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
      "red",

    label:
      "",

    place:
      body.place ||
      "",

    lat:
      body.lat,

    lon:
      body.lon,

    createdAt:
      now,

    updatedAt:
      now,

    expiresAt:
      body.expiresAt ||
      now +
      TEST_EVENT_TTL

  };


  events.set(
    event.id,
    event
  );


  broadcastState();


  res.json({
    ok:
      true,

    event
  });

});


// ============================================================
// DELETE EVENT
// ============================================================

app.delete(
  "/events/:id",
  (req, res) => {

    const deleted =
      events.delete(
        req.params.id
      );


    broadcastState();


    res.json({
      ok:
        true,

      deleted
    });

  }
);


// ============================================================
// RESET
// ============================================================

app.post(
  "/events/reset",
  (req, res) => {

    events.clear();

    broadcastState();

    res.json({
      ok:
        true,

      events:
        []
    });

  }
);


// ============================================================
// MANUAL TEST
// ============================================================

app.get(
  "/test-event",
  (req, res) => {

    const now =
      Date.now();


    const event = {

      id:
        "manual-test",

      pointId:
        "manual-test",

      type:
        "test",

      color:
        "red",

      label:
        "",

      place:
        "Біла Церква",

      lat:
        49.7968,

      lon:
        30.1153,

      createdAt:
        now,

      updatedAt:
        now,

      expiresAt:
        now +
        TEST_EVENT_TTL

    };


    events.set(
      event.id,
      event
    );


    broadcastState();


    res.json({
      ok:
        true,

      event
    });

  }
);


// ============================================================
// NORMALIZATION
// ============================================================

function normalizeText(text) {

  return String(text || "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[’`]/g, "'")
    .replace(
      /[.,!?;:()[\]{}"“”„]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();

}


// ============================================================
// PARSE MESSAGE
//
// 1 Біла Церква
// 2 Яготин
// 3 Київ Арсенальна
//
// DELETE:
//
// 1 -
//
// ============================================================

function parseMessage(text) {

  let value =
    String(text || "")
      .trim();


  let id =
    null;


  let deletePoint =
    false;


  // DELETE

  const deleteMatch =
    value.match(
      /^(?:test[-\s]*)?(\d+)\s*[-–—]\s*$/iu
    );


  if (
    deleteMatch
  ) {

    id =
      Number(
        deleteMatch[1]
      );


    deletePoint =
      true;


    return {
      id,

      text:
        "",

      deletePoint
    };

  }


  // NUMBER + LOCATION

  const match =
    value.match(
      /^(?:test[-\s]*)?(\d+)\s+(.+)$/iu
    );


  if (
    match
  ) {

    id =
      Number(
        match[1]
      );


    value =
      match[2]
        .trim();

  }


  return {

    id,

    text:
      value,

    deletePoint

  };

}


// ============================================================
// DELETE POINT
// ============================================================

function deletePoint(pointId) {

  const eventId =
    `telegram-test-${pointId}`;


  const existed =
    events.delete(
      eventId
    );


  console.log(
    "================================"
  );


  console.log(
    `DELETE POINT ${pointId}`
  );


  console.log(
    `Event: ${eventId}`
  );


  console.log(
    `Deleted: ${existed}`
  );


  console.log(
    "================================"
  );


  if (
    existed
  ) {

    broadcastState();

  }


  return existed;

}


// ============================================================
// CLEAN LOCATION
// ============================================================

function cleanLocationText(text) {

  let value =
    normalizeText(text);


  /*
   * Remove common service words.
   */

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


  return value
    .replace(
      /\s+/g,
      " "
    )
    .trim();

}


// ============================================================
// ALIASES
// ============================================================

function getAliasVariants(text) {

  const normalized =
    normalizeText(text);


  const aliases =
    [];


  function add(value) {

    value =
      normalizeText(value);


    if (
      value &&
      !aliases.includes(
        value
      )
    ) {

      aliases.push(
        value
      );

    }

  }


  add(normalized);


  // ==========================================================
  // УКРАЇНКА
  // ==========================================================

  if (
    normalized === "українку" ||
    normalized === "українки" ||
    normalized === "українці" ||
    normalized === "українкою"
  ) {

    add(
      "українка"
    );

  }


  // ==========================================================
  // БІЛА ЦЕРКВА
  // ==========================================================

  if (
    normalized === "білу церкву" ||
    normalized === "білої церкви" ||
    normalized === "білій церкві" ||
    normalized === "білою церквою"
  ) {

    add(
      "біла церква"
    );

  }


  // ==========================================================
  // БРОВАРИ
  // ==========================================================

  if (
    normalized === "броварів" ||
    normalized === "броварам" ||
    normalized === "броварами"
  ) {

    add(
      "бровари"
    );

  }


  // ==========================================================
  // ЯГОТИН
  // ==========================================================

  if (
    normalized === "яготина" ||
    normalized === "яготині" ||
    normalized === "яготином"
  ) {

    add(
      "яготин"
    );

  }


  // ==========================================================
  // СКВИРА
  // ==========================================================

  if (
    normalized === "сквиру" ||
    normalized === "сквири" ||
    normalized === "сквирою"
  ) {

    add(
      "сквира"
    );

  }


  // ==========================================================
  // ТРУШКИ
  // ==========================================================

  if (
    normalized === "трушок" ||
    normalized === "трушкам" ||
    normalized === "трушками"
  ) {

    add(
      "трушки"
    );

  }


  // ==========================================================
  // ВАСИЛЬКІВ
  // ==========================================================

  if (
    normalized === "василькова" ||
    normalized === "василькові" ||
    normalized === "васильковом"
  ) {

    add(
      "васильків"
    );

  }


  // ==========================================================
  // ОБУХІВ
  // ==========================================================

  if (
    normalized === "обухова" ||
    normalized === "обухові" ||
    normalized === "обуховом"
  ) {

    add(
      "обухів"
    );

  }


  // ==========================================================
  // ФАСТІВ
  // ==========================================================

  if (
    normalized === "фастова" ||
    normalized === "фастові" ||
    normalized === "фастовом"
  ) {

    add(
      "фастів"
    );

  }


  // ==========================================================
  // ПЕРЕЯСЛАВ
  // ==========================================================

  if (
    normalized === "переяслава" ||
    normalized === "переяславі" ||
    normalized === "переяславом"
  ) {

    add(
      "переяслав"
    );

  }


  return aliases;

}


// ============================================================
// KYIV INTERNAL LOCATION ALIASES
// ============================================================

function getKyivLocationAliases(
  text
) {

  const value =
    normalizeText(text);


  const aliases =
    [];


  function add(value) {

    value =
      normalizeText(value);


    if (
      value &&
      !aliases.includes(
        value
      )
    ) {

      aliases.push(
        value
      );

    }

  }


  /*
   * Арсенальна
   */

  if (
    value.includes(
      "арсеналь"
    )
  ) {

    add(
      "Арсенальна Київ"
    );

    add(
      "Арсенальна, Київ"
    );

    add(
      "Арсенальна станція метро Київ"
    );

  }


  /*
   * Теремки
   */

  if (
    value.includes(
      "теремк"
    )
  ) {

    add(
      "Теремки Київ"
    );

    add(
      "Теремки, Київ"
    );

  }


  /*
   * Печерськ
   */

  if (
    value.includes(
      "печерськ"
    ) ||
    value.includes(
      "печерськ"
    )
  ) {

    add(
      "Печерськ Київ"
    );

    add(
      "Печерськ, Київ"
    );

  }


  /*
   * Позняки
   */

  if (
    value.includes(
      "позняк"
    )
  ) {

    add(
      "Позняки Київ"
    );

  }


  /*
   * Осокорки
   */

  if (
    value.includes(
      "осокорк"
    )
  ) {

    add(
      "Осокорки Київ"
    );

  }


  /*
   * Оболонь
   */

  if (
    value.includes(
      "оболон"
    )
  ) {

    add(
      "Оболонь Київ"
    );

  }


  /*
   * Лівий берег
   */

  if (
    value.includes(
      "лівий берег"
    )
  ) {

    add(
      "Лівий берег Київ"
    );

  }


  /*
   * Виноградар
   */

  if (
    value.includes(
      "виноградар"
    )
  ) {

    add(
      "Виноградар Київ"
    );

  }


  /*
   * Троєщина
   */

  if (
    value.includes(
      "троєщин"
    )
  ) {

    add(
      "Троєщина Київ"
    );

  }


  /*
   * Солом'янка
   */

  if (
    value.includes(
      "солом"
    )
  ) {

    add(
      "Солом'янка Київ"
    );

  }


  /*
   * Голосіїв
   */

  if (
    value.includes(
      "голосіїв"
    )
  ) {

    add(
      "Голосіїв Київ"
    );

  }


  return aliases;

}


// ============================================================
// SEARCH VARIANTS
// ============================================================

function buildVariants(text) {

  const original =
    normalizeText(text);


  const cleaned =
    cleanLocationText(
      original
    );


  const variants =
    [];


  function add(value) {

    value =
      normalizeText(value);


    if (
      value &&
      !variants.includes(
        value
      )
    ) {

      variants.push(
        value
      );

    }

  }


  /*
   * Kyiv internal aliases first.
   */

  const kyivAliases =
    getKyivLocationAliases(
      cleaned
    );


  for (
    const alias
    of kyivAliases
  ) {

    add(alias);

  }


  /*
   * Normal aliases.
   */

  const aliases =
    getAliasVariants(
      cleaned
    );


  for (
    const alias
    of aliases
  ) {

    add(alias);

  }


  /*
   * Original and cleaned.
   */

  add(
    cleaned
  );

  add(
    original
  );


  /*
   * Shorter variants.
   */

  const words =
    cleaned.split(
      " "
    );


  for (
    let count = 1;
    count <=
      Math.min(
        5,
        words.length
      );
    count++
  ) {

    add(
      words
        .slice(
          words.length -
          count
        )
        .join(" ")
    );

  }


  return variants;

}


// ============================================================
// IS KYIV LOCATION QUERY
// ============================================================

function isKyivLocationQuery(
  query
) {

  const value =
    normalizeText(
      query
    );


  return (
    value === "київ" ||

    value.startsWith(
      "київ "
    ) ||

    value.includes(
      " київ "
    ) ||

    value.endsWith(
      " київ"
    )
  );

}


// ============================================================
// NOMINATIM SEARCH
// ============================================================

async function searchNominatim(
  query
) {

  const kyivQuery =
    isKyivLocationQuery(
      query
    );


  let searchText;


  if (
    kyivQuery
  ) {

    /*
     * Search specifically inside Kyiv.
     */

    searchText =
      `${query}, Київ, Україна`;

  } else {

    /*
     * Search specifically inside
     * Kyiv Oblast.
     */

    searchText =
      `${query}, Київська область, Україна`;

  }


  const url =
    `${NOMINATIM_URL}` +
    `?format=jsonv2` +
    `&limit=10` +
    `&countrycodes=ua` +
    `&addressdetails=1` +
    `&accept-language=uk` +
    `&q=${encodeURIComponent(
      searchText
    )}`;


  const response =
    await fetch(
      url,
      {
        headers: {

          "User-Agent":
            "ONLINE-RADAR-Test/6.0"

        }

      }
    );


  if (
    !response.ok
  ) {

    throw new Error(
      `Nominatim HTTP ${response.status}`
    );

  }


  return await response.json();

}


// ============================================================
// IS KYIV
// ============================================================

function isKyiv(
  result
) {

  const address =
    result.address ||
    {};


  const display =
    normalizeText(
      result.display_name ||
      ""
    );


  const city =
    normalizeText(
      address.city ||
      ""
    );


  const municipality =
    normalizeText(
      address.municipality ||
      ""
    );


  const cityDistrict =
    normalizeText(
      address.city_district ||
      ""
    );


  const suburb =
    normalizeText(
      address.suburb ||
      ""
    );


  if (
    city === "київ"
  ) {

    return true;

  }


  if (
    municipality === "київ"
  ) {

    return true;

  }


  if (
    display.includes(
      "київ"
    )
  ) {

    /*
     * Do not treat Kyiv Oblast
     * as Kyiv city.
     */

    if (
      display.includes(
        "київська область"
      )
    ) {

      return false;

    }


    return true;

  }


  if (
    cityDistrict &&
    display.includes(
      "київ"
    )
  ) {

    return true;

  }


  if (
    suburb &&
    display.includes(
      "київ"
    )
  ) {

    return true;

  }


  return false;

}


// ============================================================
// KYIV OBLAST
// ============================================================

function isKyivOblast(
  result
) {

  const address =
    result.address ||
    {};


  const state =
    normalizeText(
      address.state ||
      ""
    );


  const display =
    normalizeText(
      result.display_name ||
      ""
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
    display.includes(
      "київська область"
    )
  ) {

    return true;

  }


  return false;

}


// ============================================================
// SETTLEMENT
// ============================================================

function isSettlement(
  result
) {

  const type =
    String(
      result.type ||
      ""
    ).toLowerCase();


  const address =
    result.address ||
    {};


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
  ].includes(
    type
  );

}


// ============================================================
// EXACT KYIV SUBLOCATION MATCH
// ============================================================

function hasRequestedKyivLocation(
  query,
  result
) {

  const normalizedQuery =
    normalizeText(
      query
    );


  const display =
    normalizeText(
      result.display_name ||
      ""
    );


  const name =
    normalizeText(
      result.name ||
      ""
    );


  const address =
    result.address ||
    {};


  const suburb =
    normalizeText(
      address.suburb ||
      ""
    );


  const neighbourhood =
    normalizeText(
      address.neighbourhood ||
      ""
    );


  const cityDistrict =
    normalizeText(
      address.city_district ||
      ""
    );


  /*
   * Remove "київ" from the query.
   *
   * Example:
   *
   * київ арсенальна
   *
   * becomes:
   *
   * арсенальна
   */

  const requested =
    normalizedQuery
      .replace(
        /\bкиїв\b/giu,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();


  /*
   * If there is no specific part,
   * normal Kyiv query is accepted.
   */

  if (
    !requested
  ) {

    return true;

  }


  /*
   * Build all searchable names.
   */

  const searchable =
    [
      name,
      suburb,
      neighbourhood,
      cityDistrict,
      display
    ]
      .filter(Boolean)
      .join(" ");


  /*
   * Every word of the requested
   * location should appear in the
   * result.
   */

  const requestedWords =
    requested
      .split(" ")
      .filter(Boolean);


  const allWordsPresent =
    requestedWords.every(
      word =>
        searchable.includes(
          word
        )
    );


  if (
    allWordsPresent
  ) {

    return true;

  }


  /*
   * Special handling for common
   * Ukrainian endings.
   */

  for (
    const word
    of requestedWords
  ) {

    const stem =
      word.length >= 5
        ? word.slice(
            0,
            word.length - 2
          )
        : word;


    if (
      !searchable.includes(
        stem
      )
    ) {

      return false;

    }

  }


  return true;

}


// ============================================================
// ACCEPT KYIV RESULT
// ============================================================

function isAcceptedKyivResult(
  result,
  query
) {

  if (
    !isKyiv(result)
  ) {

    return false;

  }


  if (
    isKyivOblast(result)
  ) {

    return false;

  }


  /*
   * For plain "Київ" accept Kyiv.
   */

  if (
    normalizeText(query) ===
    "київ"
  ) {

    return true;

  }


  /*
   * For "Київ Арсенальна",
   * "Київ Теремки", etc.,
   * require actual location match.
   */

  return hasRequestedKyivLocation(
    query,
    result
  );

}


// ============================================================
// ACCEPT RESULT
// ============================================================

function isAcceptedResult(
  result,
  query
) {

  const kyivQuery =
    isKyivLocationQuery(
      query
    );


  /*
   * KYIV
   */

  if (
    kyivQuery
  ) {

    return isAcceptedKyivResult(
      result,
      query
    );

  }


  /*
   * KYIV OBLAST
   */

  if (
    !isKyivOblast(
      result
    )
  ) {

    return false;

  }


  if (
    !isSettlement(
      result
    )
  ) {

    return false;

  }


  return true;

}


// ============================================================
// PLACE NAME
// ============================================================

function getPlaceName(
  result
) {

  const address =
    result.address ||
    {};


  if (
    isKyiv(result)
  ) {

    return (
      result.name ||

      address.suburb ||

      address.neighbourhood ||

      address.city_district ||

      address.city ||

      "Київ"
    );

  }


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

async function findPlace(
  text
) {

  const variants =
    buildVariants(
      text
    );


  console.log(
    "================================"
  );


  console.log(
    "SEARCH:",
    text
  );


  console.log(
    "Search variants:",
    variants
  );


  /*
   * IMPORTANT:
   *
   * We don't immediately accept
   * the first Nominatim result.
   *
   * For Kyiv internal locations,
   * we require the requested name
   * to actually occur in the result.
   */


  for (
    const variant
    of variants
  ) {

    const cacheKey =
      variant;


    if (
      geocodeCache.has(
        cacheKey
      )
    ) {

      const cached =
        geocodeCache.get(
          cacheKey
        );


      if (
        cached
      ) {

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


      console.log(
        `Nominatim results: ${results.length}`
      );


      for (
        const result
        of results
      ) {

        console.log(
          "Candidate:",
          result.name ||
          "(no name)",
          "|",
          result.display_name ||
          ""
        );


        if (
          !isAcceptedResult(
            result,
            variant
          )
        ) {

          continue;

        }


        const lat =
          Number(
            result.lat
          );


        const lon =
          Number(
            result.lon
          );


        if (
          !Number.isFinite(
            lat
          ) ||
          !Number.isFinite(
            lon
          )
        ) {

          continue;

        }


        const place = {

          name:
            getPlaceName(
              result
            ),

          lat,

          lon,

          displayName:
            result.display_name ||
            "",

          osmType:
            result.osm_type ||
            "",

          osmId:
            result.osm_id ||
            null

        };


        if (
          !place.name
        ) {

          continue;

        }


        /*
         * Cache successful match.
         */

        geocodeCache.set(
          cacheKey,
          place
        );


        console.log(
          "--------------------------------"
        );


        console.log(
          `MATCHED: ${place.name}`
        );


        console.log(
          `Coordinates: ${place.lat}, ${place.lon}`
        );


        console.log(
          `Display: ${place.displayName}`
        );


        console.log(
          "--------------------------------"
        );


        return place;

      }


      /*
       * Don't permanently cache
       * a failed short variant too
       * aggressively.
       */

      if (
        variant.length >= 5
      ) {

        geocodeCache.set(
          cacheKey,
          null
        );

      }


    } catch (error) {

      console.error(
        `Geocoding error: ${error.message}`
      );

    }

  }


  console.log(
    `NO MATCH: ${text}`
  );


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


  const oldEvent =
    events.get(
      eventId
    );


  const event = {

    id:
      eventId,

    pointId:
      pointId,

    type:
      "test",

    color:
      "red",

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
      oldEvent
        ? oldEvent.createdAt
        : now,

    updatedAt:
      now,

    expiresAt:
      now +
      TEST_EVENT_TTL

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
    oldEvent
      ? "Action: MOVED"
      : "Action: CREATED"
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
        req.body ||
        {};


      const channelPost =
        update.channel_post;


      if (
        !channelPost
      ) {

        return res.json({

          ok:
            true,

          ignored:
            true,

          reason:
            "not channel_post"

        });

      }


      const chat =
        channelPost.chat ||
        {};


      const username =
        String(
          chat.username ||
          ""
        )
          .replace(
            /^@/,
            ""
          )
          .toLowerCase();


      /*
       * ONLY @radaronlinetest
       */

      if (
        username !==
        TEST_CHANNEL_USERNAME
      ) {

        console.log(
          `Ignored channel: @${username}`
        );


        return res.json({

          ok:
            true,

          ignored:
            true,

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

          ok:
            true,

          ignored:
            true,

          reason:
            "empty message"

        });

      }


      const parsed =
        parseMessage(
          message
        );


      console.log(
        `Point ID: ${
          parsed.id !== null
            ? parsed.id
            : "AUTO"
        }`
      );


      console.log(
        `Location text: ${
          parsed.text
        }`
      );


      /*
       * DELETE
       *
       * 1 -
       */

      if (
        parsed.deletePoint
      ) {

        const deleted =
          deletePoint(
            parsed.id
          );


        return res.json({

          ok:
            true,

          matched:
            true,

          deleted,

          pointId:
            parsed.id

        });

      }


      if (
        !parsed.text
      ) {

        return res.json({

          ok:
            true,

          matched:
            false,

          reason:
            "empty location"

        });

      }


      const place =
        await findPlace(
          parsed.text
        );


      if (
        !place
      ) {

        return res.json({

          ok:
            true,

          matched:
            false,

          reason:
            "location not found"

        });

      }


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

        ok:
          true,

        matched:
          true,

        event

      });


    } catch (error) {

      console.error(
        "Telegram webhook error:",
        error
      );


      return res.status(500).json({

        ok:
          false,

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

    path:
      "/ws"

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
    const socket
    of clients
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
    ]
    of events.entries()
  ) {

    if (
      typeof event.expiresAt ===
        "number" &&
      event.expiresAt <=
        now
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
      "ONLINE RADAR backend v6.0.0"
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
      "Point movement: ENABLED"
    );


    console.log(
      "Point deletion: ENABLED"
    );


    console.log(
      "Kyiv locations: ENABLED"
    );


    console.log(
      "Kyiv internal locations: ENABLED"
    );


    console.log(
      "Exact Kyiv location matching: ENABLED"
    );


    console.log(
      "Case normalization: ENABLED"
    );


    console.log(
      "Red test events: ENABLED"
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
