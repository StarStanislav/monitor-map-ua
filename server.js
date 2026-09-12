const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

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

const SETTLEMENTS_FILE =
  path.join(
    __dirname,
    "kyiv-oblast-places.json"
  );

const events =
  new Map();

const clients =
  new Set();

const geocodeCache =
  new Map();


// ============================================================
// KYIV INTERNAL LOCATIONS
//
// These are not settlements from the oblast gazetteer.
// They are kept separately because they are locations inside Kyiv.
// ============================================================

const KYIV_INTERNAL_PLACES = {

  "київ": {
    name: "Київ",
    lat: 50.4501,
    lon: 30.5234
  },

  "арсенальна": {
    name: "Арсенальна",
    lat: 50.4446,
    lon: 30.5486
  },

  "печерськ": {
    name: "Печерськ",
    lat: 50.4269,
    lon: 30.5367
  },

  "теремки": {
    name: "Теремки",
    lat: 50.3677,
    lon: 30.4528
  },

  "позняки": {
    name: "Позняки",
    lat: 50.4147,
    lon: 30.6332
  },

  "осокорки": {
    name: "Осокорки",
    lat: 50.4056,
    lon: 30.6155
  },

  "оболонь": {
    name: "Оболонь",
    lat: 50.5114,
    lon: 30.4982
  },

  "троєщина": {
    name: "Троєщина",
    lat: 50.5104,
    lon: 30.6165
  },

  "виноградар": {
    name: "Виноградар",
    lat: 50.5057,
    lon: 30.4242
  },

  "солом'янка": {
    name: "Солом'янка",
    lat: 50.4300,
    lon: 30.4720
  },

  "голосіїв": {
    name: "Голосіїв",
    lat: 50.3920,
    lon: 30.5080
  },

  "лівий берег": {
    name: "Лівий берег",
    lat: 50.4450,
    lon: 30.6200
  }

};


// ============================================================
// LOAD KYIV OBLAST GAZETTEER
//
// File:
// kyiv-oblast-places.json
//
// Format:
//
// [
//   {
//     "name": "...",
//     "type": "село",
//     "lat": 49.123,
//     "lon": 30.123,
//     ...
//   }
// ]
// ============================================================

let SETTLEMENTS = [];
let SETTLEMENTS_BY_NAME = new Map();

function loadSettlements() {

  try {

    if (
      !fs.existsSync(
        SETTLEMENTS_FILE
      )
    ) {

      console.error(
        "================================"
      );

      console.error(
        "ERROR: kyiv-oblast-places.json NOT FOUND"
      );

      console.error(
        `Expected file: ${SETTLEMENTS_FILE}`
      );

      console.error(
        "================================"
      );

      return;

    }


    const raw =
      fs.readFileSync(
        SETTLEMENTS_FILE,
        "utf8"
      );


    const data =
      JSON.parse(
        raw
      );


    if (
      !Array.isArray(data)
    ) {

      throw new Error(
        "kyiv-oblast-places.json must contain an array"
      );

    }


    SETTLEMENTS =
      data.filter(
        place =>
          place &&
          typeof place.name === "string" &&
          Number.isFinite(
            Number(place.lat)
          ) &&
          Number.isFinite(
            Number(place.lon)
          )
      );


    SETTLEMENTS_BY_NAME =
      new Map();


    for (
      const place
      of SETTLEMENTS
    ) {

      const key =
        normalizeText(
          place.name
        );


      if (
        !key
      ) {

        continue;

      }


      if (
        !SETTLEMENTS_BY_NAME.has(
          key
        )
      ) {

        SETTLEMENTS_BY_NAME.set(
          key,
          []
        );

      }


      SETTLEMENTS_BY_NAME
        .get(key)
        .push(place);

    }


    console.log(
      "================================"
    );

    console.log(
      "KYIV OBLAST GAZETTEER LOADED"
    );

    console.log(
      `Records: ${SETTLEMENTS.length}`
    );

    console.log(
      `Unique names: ${SETTLEMENTS_BY_NAME.size}`
    );

    console.log(
      `File: ${SETTLEMENTS_FILE}`
    );

    console.log(
      "================================"
    );


  } catch (error) {

    console.error(
      "================================"
    );

    console.error(
      "GAZETTEER LOAD ERROR:"
    );

    console.error(
      error.message
    );

    console.error(
      "================================"
    );

  }

}


// ============================================================
// BASIC
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.json({

      name:
        "ONLINE RADAR backend",

      status:
        "online",

      version:
        "7.0.0",

      testChannel:
        `@${TEST_CHANNEL_USERNAME}`,

      settlements:
        SETTLEMENTS.length

    });

  }
);


app.get(
  "/health",
  (req, res) => {

    cleanupExpiredEvents();

    res.json({

      ok:
        true,

      timestamp:
        new Date().toISOString(),

      events:
        events.size,

      settlements:
        SETTLEMENTS.length

    });

  }
);


// ============================================================
// EVENTS
// ============================================================

app.get(
  "/events",
  (req, res) => {

    cleanupExpiredEvents();

    res.json({

      events:
        Array.from(
          events.values()
        )

    });

  }
);


app.post(
  "/events",
  (req, res) => {

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

  }
);


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


    const place =
      findGazetteerPlace(
        "біла церква"
      );


    if (
      !place
    ) {

      return res.status(500).json({

        ok:
          false,

        error:
          "Біла Церква not found in gazetteer"

      });

    }


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
        place.name,

      lat:
        place.lat,

      lon:
        place.lon,

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

  return String(
    text || ""
  )
    .toLowerCase()
    .normalize("NFC")
    .replace(
      /[’`]/g,
      "'"
    )
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
// CLEAN LOCATION TEXT
// ============================================================

function cleanLocationText(text) {

  let value =
    normalizeText(
      text
    );


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
    normalizeText(
      text
    );


  const aliases =
    [];


  function add(value) {

    value =
      normalizeText(
        value
      );


    if (
      value &&
      !aliases.includes(value)
    ) {

      aliases.push(value);

    }

  }


  add(normalized);


  // УКРАЇНКА

  if (
    normalized === "українку" ||
    normalized === "українки" ||
    normalized === "українці" ||
    normalized === "українкою"
  ) {

    add("українка");

  }


  // БІЛА ЦЕРКВА

  if (
    normalized === "білу церкву" ||
    normalized === "білої церкви" ||
    normalized === "білій церкві" ||
    normalized === "білою церквою"
  ) {

    add("біла церква");

  }


  // БРОВАРИ

  if (
    normalized === "броварів" ||
    normalized === "броварам" ||
    normalized === "броварами"
  ) {

    add("бровари");

  }


  // ЯГОТИН

  if (
    normalized === "яготина" ||
    normalized === "яготині" ||
    normalized === "яготином"
  ) {

    add("яготин");

  }


  // СКВИРА

  if (
    normalized === "сквиру" ||
    normalized === "сквири" ||
    normalized === "сквирою"
  ) {

    add("сквира");

  }


  // ТРУШКИ

  if (
    normalized === "трушок" ||
    normalized === "трушкам" ||
    normalized === "трушками" ||
    normalized === "трушках"
  ) {

    add("трушки");

  }


  // ВАСИЛЬКІВ

  if (
    normalized === "василькова" ||
    normalized === "василькові" ||
    normalized === "васильковом"
  ) {

    add("васильків");

  }


  // ОБУХІВ

  if (
    normalized === "обухова" ||
    normalized === "обухові" ||
    normalized === "обуховом"
  ) {

    add("обухів");

  }


  // ФАСТІВ

  if (
    normalized === "фастова" ||
    normalized === "фастові" ||
    normalized === "фастовом"
  ) {

    add("фастів");

  }


  // ПЕРЕЯСЛАВ

  if (
    normalized === "переяслава" ||
    normalized === "переяславі" ||
    normalized === "переяславом"
  ) {

    add("переяслав");

  }


  // УЗИН

  if (
    normalized === "узина" ||
    normalized === "узині" ||
    normalized === "узином"
  ) {

    add("узин");

  }


  // КАГАРЛИК

  if (
    normalized === "кагарлика" ||
    normalized === "кагарлику" ||
    normalized === "кагарликом"
  ) {

    add("кагарлик");

  }


  // РЖИЩІВ

  if (
    normalized === "ржищова" ||
    normalized === "ржищеві" ||
    normalized === "ржищевом"
  ) {

    add("ржищів");

  }


  // БОРИСПІЛЬ

  if (
    normalized === "борисполя" ||
    normalized === "борисполі" ||
    normalized === "борисполем"
  ) {

    add("бориспіль");

  }


  // ВИШГОРОД

  if (
    normalized === "вишгорода" ||
    normalized === "вишгороді" ||
    normalized === "вишгородом"
  ) {

    add("вишгород");

  }


  // СЛАВУТИЧ

  if (
    normalized === "славутича" ||
    normalized === "славутичі" ||
    normalized === "славутичем"
  ) {

    add("славутич");

  }


  // ДИМЕР

  if (
    normalized === "димера" ||
    normalized === "димері" ||
    normalized === "димером"
  ) {

    add("димер");

  }


  // ІВАНКІВ

  if (
    normalized === "іванкова" ||
    normalized === "іванкові" ||
    normalized === "іванковом"
  ) {

    add("іванків");

  }


  // БОРИСПІЛЬ / ВИШГОРОД ETC.
  // Generic aliases below are handled
  // by partial-name matching.

  return aliases;

}


// ============================================================
// KYIV INTERNAL LOCATION ALIASES
// ============================================================

function getKyivLocationAliases(text) {

  const value =
    normalizeText(
      text
    );


  const aliases =
    [];


  function add(value) {

    value =
      normalizeText(
        value
      );


    if (
      value &&
      !aliases.includes(value)
    ) {

      aliases.push(value);

    }

  }


  if (
    value.includes("арсеналь")
  ) {

    add("арсенальна");

  }


  if (
    value.includes("теремк")
  ) {

    add("теремки");

  }


  if (
    value.includes("печерськ")
  ) {

    add("печерськ");

  }


  if (
    value.includes("позняк")
  ) {

    add("позняки");

  }


  if (
    value.includes("осокорк")
  ) {

    add("осокорки");

  }


  if (
    value.includes("оболон")
  ) {

    add("оболонь");

  }


  if (
    value.includes("лівий берег")
  ) {

    add("лівий берег");

  }


  if (
    value.includes("виноградар")
  ) {

    add("виноградар");

  }


  if (
    value.includes("троєщин")
  ) {

    add("троєщина");

  }


  if (
    value.includes("солом")
  ) {

    add("солом'янка");

  }


  if (
    value.includes("голосіїв")
  ) {

    add("голосіїв");

  }


  return aliases;

}


// ============================================================
// CONVERT GAZETTEER RECORD
// ============================================================

function convertGazetteerPlace(
  place
) {

  return {

    name:
      place.name,

    lat:
      Number(place.lat),

    lon:
      Number(place.lon),

    displayName:
      `${place.name}, Київська область, Україна`,

    osmType:
      "gazetteer",

    osmId:
      place.osm_id ||
      null,

    katottg:
      place.katottg ||
      null,

    type:
      place.type ||
      "",

    district:
      place.district ||
      place.district_name ||
      "",

    hromada:
      place.hromada ||
      place.hromada_name ||
      "",

    postalCode:
      place.postal_code ||
      "",

    population:
      place.population ||
      null

  };

}


// ============================================================
// FIND EXACT GAZETTEER PLACE
// ============================================================

function findGazetteerPlace(
  text
) {

  const normalized =
    normalizeText(
      text
    );


  const cleaned =
    cleanLocationText(
      normalized
    );


  const aliases =
    getAliasVariants(
      cleaned
    );


  const candidates = [
    ...aliases,
    cleaned,
    normalized
  ];


  for (
    const candidate
    of candidates
  ) {

    const records =
      SETTLEMENTS_BY_NAME.get(
        candidate
      );


    if (
      !records ||
      records.length === 0
    ) {

      continue;

    }


    /*
     * Usually there is only one settlement
     * with this exact name.
     *
     * If a name exists more than once
     * (for example Калинівка), use the first
     * gazetteer record and leave Nominatim
     * as fallback for more specific queries.
     */

    const place =
      records[0];


    return convertGazetteerPlace(
      place
    );

  }


  return null;

}


// ============================================================
// FUZZY GAZETTEER SEARCH
//
// Helps with:
//
// Біла церква
// Біла церква ДНС
// Славутич
// В напрямку Білогородки
//
// This is only the neutral TEST channel.
// ============================================================

function findGazetteerPartialPlace(
  text
) {

  const normalized =
    cleanLocationText(
      text
    );


  if (
    !normalized
  ) {

    return null;

  }


  const aliases =
    getAliasVariants(
      normalized
    );


  const candidates = [
    ...aliases,
    normalized
  ];


  // Exact token / phrase contained in message.

  for (
    const candidate
    of candidates
  ) {

    if (
      candidate.length < 3
    ) {

      continue;

    }


    let best =
      null;


    for (
      const place
      of SETTLEMENTS
    ) {

      const placeName =
        normalizeText(
          place.name
        );


      if (
        !placeName
      ) {

        continue;

      }


      if (
        candidate ===
        placeName
      ) {

        return convertGazetteerPlace(
          place
        );

      }


      if (
        candidate.includes(
          placeName
        )
      ) {

        if (
          !best ||
          placeName.length >
            normalizeText(
              best.name
            ).length
        ) {

          best =
            place;

        }

      }

    }


    if (
      best
    ) {

      return convertGazetteerPlace(
        best
      );

    }

  }


  // Reverse check:
  // message contains words that identify settlement.

  const words =
    normalized
      .split(" ")
      .filter(
        word =>
          word.length >= 4
      );


  if (
    words.length === 0
  ) {

    return null;

  }


  let best =
    null;

  let bestScore =
    0;


  for (
    const place
    of SETTLEMENTS
  ) {

    const placeName =
      normalizeText(
        place.name
      );


    if (
      !placeName
    ) {

      continue;

    }


    const placeWords =
      placeName
        .split(" ")
        .filter(Boolean);


    let score =
      0;


    for (
      const placeWord
      of placeWords
    ) {

      for (
        const word
        of words
      ) {

        if (
          word ===
          placeWord
        ) {

          score += 3;

        } else if (
          word.length >= 5 &&
          placeWord.length >= 5 &&
          (
            word.startsWith(
              placeWord.slice(
                0,
                Math.max(
                  4,
                  placeWord.length - 2
                )
              )
            ) ||
            placeWord.startsWith(
              word.slice(
                0,
                Math.max(
                  4,
                  word.length - 2
                )
              )
            )
          )
        ) {

          score += 1;

        }

      }

    }


    if (
      score > bestScore
    ) {

      bestScore =
        score;

      best =
        place;

    }

  }


  if (
    best &&
    bestScore >= 3
  ) {

    return convertGazetteerPlace(
      best
    );

  }


  return null;

}


// ============================================================
// FIND KYIV INTERNAL PLACE
// ============================================================

function findKyivInternalPlace(
  text
) {

  const normalized =
    normalizeText(
      text
    );


  const cleaned =
    cleanLocationText(
      normalized
    );


  const aliases =
    getKyivLocationAliases(
      cleaned
    );


  const candidates = [
    ...aliases,
    cleaned,
    normalized
  ];


  for (
    const candidate
    of candidates
  ) {

    if (
      KYIV_INTERNAL_PLACES[
        candidate
      ]
    ) {

      const place =
        KYIV_INTERNAL_PLACES[
          candidate
        ];


      return {

        name:
          place.name,

        lat:
          place.lat,

        lon:
          place.lon,

        displayName:
          `${place.name}, Київ, Україна`,

        osmType:
          "kyiv-internal",

        osmId:
          null

      };

    }

  }


  // Special matching.

  if (
    normalized.includes(
      "арсеналь"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "арсенальна"
    ];

  }


  if (
    normalized.includes(
      "печерськ"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "печерськ"
    ];

  }


  if (
    normalized.includes(
      "теремк"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "теремки"
    ];

  }


  if (
    normalized.includes(
      "позняк"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "позняки"
    ];

  }


  if (
    normalized.includes(
      "осокорк"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "осокорки"
    ];

  }


  if (
    normalized.includes(
      "оболон"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "оболонь"
    ];

  }


  if (
    normalized.includes(
      "троєщин"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "троєщина"
    ];

  }


  if (
    normalized.includes(
      "виноградар"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "виноградар"
    ];

  }


  if (
    normalized.includes(
      "солом"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "солом'янка"
    ];

  }


  if (
    normalized.includes(
      "голосіїв"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "голосіїв"
    ];

  }


  if (
    normalized.includes(
      "лівий берег"
    )
  ) {

    return KYIV_INTERNAL_PLACES[
      "лівий берег"
    ];

  }


  if (
    normalized ===
    "київ"
  ) {

    return KYIV_INTERNAL_PLACES[
      "київ"
    ];

  }


  return null;

}


// ============================================================
// SEARCH VARIANTS
// ============================================================

function buildVariants(
  text
) {

  const original =
    normalizeText(
      text
    );


  const cleaned =
    cleanLocationText(
      original
    );


  const variants =
    [];


  function add(value) {

    value =
      normalizeText(
        value
      );


    if (
      value &&
      !variants.includes(value)
    ) {

      variants.push(value);

    }

  }


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


  add(cleaned);

  add(original);


  const words =
    cleaned
      .split(" ")
      .filter(Boolean);


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
    value.startsWith("київ ") ||
    value.includes(" київ ") ||
    value.endsWith(" київ")
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

    searchText =
      `${query}, Київ, Україна`;

  } else {

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
            "ONLINE-RADAR-Test/7.0"

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
    ) &&
    !display.includes(
      "київська область"
    )
  ) {

    return true;

  }


  return false;

}


// ============================================================
// IS KYIV OBLAST
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


  const searchable =
    [
      name,
      normalizeText(
        address.suburb ||
        ""
      ),
      normalizeText(
        address.neighbourhood ||
        ""
      ),
      normalizeText(
        address.city_district ||
        ""
      ),
      display
    ]
      .filter(Boolean)
      .join(" ");


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


  if (
    !requested
  ) {

    return true;

  }


  const requestedWords =
    requested
      .split(" ")
      .filter(Boolean);


  return requestedWords.every(
    word =>
      searchable.includes(
        word
      )
  );

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


  if (
    normalizeText(query) ===
    "київ"
  ) {

    return true;

  }


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


  if (
    kyivQuery
  ) {

    return isAcceptedKyivResult(
      result,
      query
    );

  }


  if (
    !isKyivOblast(result)
  ) {

    return false;

  }


  if (
    !isSettlement(result)
  ) {

    return false;

  }


  return true;

}


// ============================================================
// PLACE NAME FROM NOMINATIM
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
//
// Priority:
//
// 1. Kyiv internal locations
// 2. Full Kyiv Oblast gazetteer
// 3. Gazetteer partial match
// 4. Nominatim fallback
// ============================================================

async function findPlace(
  text
) {

  // ----------------------------------------------------------
  // 1. KYIV INTERNAL
  // ----------------------------------------------------------

  const kyivPlace =
    findKyivInternalPlace(
      text
    );


  if (
    kyivPlace
  ) {

    console.log(
      "================================"
    );

    console.log(
      "KYIV INTERNAL MATCH:",
      text
    );

    console.log(
      `Place: ${kyivPlace.name}`
    );

    console.log(
      `Coordinates: ${kyivPlace.lat}, ${kyivPlace.lon}`
    );

    console.log(
      "Source: KYIV INTERNAL"
    );

    console.log(
      "================================"
    );


    return kyivPlace;

  }


  // ----------------------------------------------------------
  // 2. EXACT GAZETTEER
  // ----------------------------------------------------------

  const exactPlace =
    findGazetteerPlace(
      text
    );


  if (
    exactPlace
  ) {

    console.log(
      "================================"
    );

    console.log(
      "GAZETTEER MATCH:",
      text
    );

    console.log(
      `Place: ${exactPlace.name}`
    );

    console.log(
      `Coordinates: ${exactPlace.lat}, ${exactPlace.lon}`
    );

    console.log(
      `Type: ${exactPlace.type || ""}`
    );

    console.log(
      `District: ${exactPlace.district || ""}`
    );

    console.log(
      `Hromada: ${exactPlace.hromada || ""}`
    );

    console.log(
      "Source: KYIV OBLAST GAZETTEER"
    );

    console.log(
      "================================"
    );


    return exactPlace;

  }


  // ----------------------------------------------------------
  // 3. PARTIAL GAZETTEER
  // ----------------------------------------------------------

  const partialPlace =
    findGazetteerPartialPlace(
      text
    );


  if (
    partialPlace
  ) {

    console.log(
      "================================"
    );

    console.log(
      "GAZETTEER PARTIAL MATCH:",
      text
    );

    console.log(
      `Place: ${partialPlace.name}`
    );

    console.log(
      `Coordinates: ${partialPlace.lat}, ${partialPlace.lon}`
    );

    console.log(
      "Source: KYIV OBLAST GAZETTEER"
    );

    console.log(
      "================================"
    );


    return partialPlace;

  }


  // ----------------------------------------------------------
  // 4. NOMINATIM FALLBACK
  // ----------------------------------------------------------

  const variants =
    buildVariants(
      text
    );


  console.log(
    "================================"
  );

  console.log(
    "NOMINATIM FALLBACK SEARCH:",
    text
  );

  console.log(
    "Search variants:",
    variants
  );


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
          !Number.isFinite(lat) ||
          !Number.isFinite(lon)
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
          "Source: NOMINATIM"
        );

        console.log(
          "--------------------------------"
        );


        return place;

      }


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
// Also accepts:
//
// TEST 1 Біла Церква
// ============================================================

function parseMessage(
  text
) {

  let value =
    String(
      text || ""
    )
      .trim();


  let id =
    null;


  let deletePoint =
    false;


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

function deletePoint(
  pointId
) {

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
    "Source:",
    place.osmType ===
      "gazetteer"
      ? "KYIV OBLAST GAZETTEER"
      : place.osmType ===
        "kyiv-internal"
        ? "KYIV INTERNAL"
        : "NOMINATIM"
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


      // IMPORTANT:
      // ONLY TEST CHANNEL

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
        )
          .trim();


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
        `Location text: ${parsed.text}`
      );


      // --------------------------------------------------------
      // DELETE
      // --------------------------------------------------------

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


      // --------------------------------------------------------
      // FIND PLACE
      // --------------------------------------------------------

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
            "location not found",

          text:
            parsed.text

        });

      }


      // --------------------------------------------------------
      // POINT ID
      // --------------------------------------------------------

      let pointId =
        parsed.id;


      if (
        pointId === null
      ) {

        pointId =
          Date.now();

      }


      // --------------------------------------------------------
      // CREATE / MOVE
      // --------------------------------------------------------

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

loadSettlements();


server.listen(
  PORT,
  async () => {

    console.log(
      "================================"
    );

    console.log(
      "ONLINE RADAR backend v7.0.0"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Test channel: @${TEST_CHANNEL_USERNAME}`
    );

    console.log(
      `Gazetteer records: ${SETTLEMENTS.length}`
    );

    console.log(
      "Full Kyiv Oblast gazetteer: ENABLED"
    );

    console.log(
      "Gazetteer coordinates priority: ENABLED"
    );

    console.log(
      "Nominatim fallback: ENABLED"
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
      "Case normalization: ENABLED"
    );

    console.log(
      "Inflection aliases: ENABLED"
    );

    console.log(
      "Red test events: ENABLED"
    );

    console.log(
      "TEST label on marker: DISABLED"
    );

    console.log(
      "Operational channels: DISABLED"
    );

    console.log(
      "================================"
    );


    await setupTelegramWebhook();

  }
);
