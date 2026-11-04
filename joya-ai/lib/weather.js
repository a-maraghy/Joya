"use strict";
/**
 * The weather, from a real source (2026-10-30): Open-Meteo's free geocoding and forecast APIs (no key,
 * ~0.1 s from this VPS). JOYA AI's `weather` MCP tool (bin/joya-ai-mcp) and the voice calls' quick lane
 * use it instead of guessing or scraping a page.
 *
 *   weather({ place, lat?, lon?, days? }, { fetch?, now? }) -> { place, country, current, days: [...], source }
 *
 * Temperatures in °C, wind in km/h, rain as the day's highest chance in %, the sky in words (WMO codes).
 * Places are looked up once and cached in memory. Errors are thrown with a plain message.
 */

const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 6000;

// WMO weather interpretation codes (Open-Meteo's table), in words.
const SKY = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

const places = new Map(); // normalised name -> { name, country, admin1, lat, lon, tz }

async function getJson(url, f) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await f(url, { signal: ctl.signal, headers: { "User-Agent": "joya-ai-weather/1" } });
    if (!r.ok) throw new Error("the weather service answered " + r.status);
    return await r.json();
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("the weather service did not answer in time");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Common spellings Open-Meteo's geocoder does not know as such. */
const ALIASES = { "6th of october": "6th of October City", "sixth of october": "6th of October City", "october city": "6th of October City", "6 october": "6th of October City", "السادس من أكتوبر": "6th of October City", "6 أكتوبر": "6th of October City", "أكتوبر": "6th of October City", "القاهرة": "Cairo", "الجيزة": "Giza", "الإسكندرية": "Alexandria" };

async function geocode(place, f) {
  const key = String(place || "").trim().toLowerCase();
  if (!key) throw new Error("say which place");
  if (places.has(key)) return places.get(key);
  const name = ALIASES[key] || ALIASES[String(place).trim()] || String(place).trim();
  const j = await getJson(`${GEO}?name=${encodeURIComponent(name)}&count=5&language=en&format=json`, f);
  const list = (j && j.results) || [];
  if (!list.length) throw new Error(`no place called "${String(place).slice(0, 60)}" was found`);
  // The most populous match (a city over a village of the same name).
  const best = list.slice().sort((a, b) => (Number(b.population) || 0) - (Number(a.population) || 0))[0];
  const p = { name: best.name, country: best.country || "", admin1: best.admin1 || "", lat: best.latitude, lon: best.longitude, tz: best.timezone || "auto" };
  places.set(key, p);
  return p;
}

const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(Number(x)));

/** The weather now and for the next `days` days (1..7) at a place or coordinates. */
async function weather(args, o) {
  const a = args || {};
  o = o || {};
  const f = o.fetch || globalThis.fetch;
  if (!f) throw new Error("no HTTP client");
  const days = Math.max(1, Math.min(7, Number(a.days) || 2));
  let p;
  if (isFinite(Number(a.lat)) && isFinite(Number(a.lon)) && a.lat !== "" && a.lon !== "") p = { name: String(a.place || `${a.lat},${a.lon}`), country: "", lat: Number(a.lat), lon: Number(a.lon), tz: "auto" };
  else p = await geocode(a.place, f);
  const url =
    `${FORECAST}?latitude=${p.lat}&longitude=${p.lon}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
    `&timezone=${encodeURIComponent(p.tz || "auto")}&forecast_days=${days}`;
  const j = await getJson(url, f);
  const c = j.current || {};
  const d = j.daily || {};
  return {
    place: [p.name, p.admin1, p.country].filter(Boolean).join(", "),
    local_time: c.time || null,
    current: { sky: SKY[c.weather_code] || null, temp_c: r1(c.temperature_2m), feels_like_c: r1(c.apparent_temperature), humidity_pct: r1(c.relative_humidity_2m), wind_kmh: r1(c.wind_speed_10m) },
    days: (d.time || []).map((date, i) => ({
      date,
      sky: SKY[(d.weather_code || [])[i]] || null,
      low_c: r1((d.temperature_2m_min || [])[i]),
      high_c: r1((d.temperature_2m_max || [])[i]),
      rain_chance_pct: r1((d.precipitation_probability_max || [])[i]),
    })),
    source: "Open-Meteo",
  };
}

module.exports = { weather, geocode, SKY, ALIASES };
