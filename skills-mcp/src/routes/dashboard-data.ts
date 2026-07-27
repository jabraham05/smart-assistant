import type { Express } from "express";
import type { Config } from "../config.js";
import { listEvents } from "../lib/google-calendar.js";
import { getCurrentlyPlaying } from "../lib/spotify.js";

// Duplicated from the Pi's server/src/integrations/weather/service.ts rather
// than shared — the Pi app and this service are separate builds with no
// shared package today (same convention as duplicating small lookup tables
// elsewhere in this project). Keep condition/icon strings identical to that
// file if either changes.
const WEATHER_CODES: Record<number, { condition: string; icon: string }> = {
  0: { condition: "Clear", icon: "☀️" },
  1: { condition: "Mostly Clear", icon: "🌤️" },
  2: { condition: "Partly Cloudy", icon: "⛅" },
  3: { condition: "Overcast", icon: "☁️" },
  45: { condition: "Fog", icon: "🌫️" },
  48: { condition: "Fog", icon: "🌫️" },
  51: { condition: "Light Drizzle", icon: "🌦️" },
  53: { condition: "Drizzle", icon: "🌦️" },
  55: { condition: "Heavy Drizzle", icon: "🌦️" },
  56: { condition: "Freezing Drizzle", icon: "🌧️" },
  57: { condition: "Freezing Drizzle", icon: "🌧️" },
  61: { condition: "Light Rain", icon: "🌧️" },
  63: { condition: "Rain", icon: "🌧️" },
  65: { condition: "Heavy Rain", icon: "🌧️" },
  66: { condition: "Freezing Rain", icon: "🌧️" },
  67: { condition: "Freezing Rain", icon: "🌧️" },
  71: { condition: "Light Snow", icon: "❄️" },
  73: { condition: "Snow", icon: "❄️" },
  75: { condition: "Heavy Snow", icon: "❄️" },
  77: { condition: "Snow Grains", icon: "❄️" },
  80: { condition: "Rain Showers", icon: "🌦️" },
  81: { condition: "Rain Showers", icon: "🌦️" },
  82: { condition: "Violent Showers", icon: "🌦️" },
  85: { condition: "Snow Showers", icon: "🌨️" },
  86: { condition: "Snow Showers", icon: "🌨️" },
  95: { condition: "Thunderstorm", icon: "⛈️" },
  96: { condition: "Thunderstorm", icon: "⛈️" },
  99: { condition: "Thunderstorm", icon: "⛈️" },
};

interface WeatherData {
  temperature: number;
  condition: string;
  icon: string;
  highTemp: number;
  lowTemp: number;
}

async function fetchWeather(config: Config): Promise<WeatherData | null> {
  if (config.homeLatitude === undefined || config.homeLongitude === undefined) return null;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(config.homeLatitude));
  url.searchParams.set("longitude", String(config.homeLongitude));
  url.searchParams.set("current", "temperature_2m,weather_code");
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  const data = (await res.json()) as {
    current: { temperature_2m: number; weather_code: number };
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[] };
  };
  const mapped = WEATHER_CODES[data.current.weather_code] ?? { condition: "Unknown", icon: "❓" };

  return {
    temperature: Math.round(data.current.temperature_2m),
    condition: mapped.condition,
    icon: mapped.icon,
    highTemp: Math.round(data.daily.temperature_2m_max[0]),
    lowTemp: Math.round(data.daily.temperature_2m_min[0]),
  };
}

interface CalendarEventData {
  id: string;
  title: string;
  start: string;
  allDay: boolean;
  location?: string;
}

async function fetchCalendar(config: Config): Promise<CalendarEventData[]> {
  if (!config.googleCalendarKeyFile || !config.googleCalendarId) return [];

  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const events = await listEvents(config, now.toISOString(), weekOut.toISOString(), 5);

  return events.map((e) => ({
    id: e.id,
    title: e.summary ?? "(No title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    location: e.location,
  }));
}

interface SpotifyNowPlayingData {
  isPlaying: boolean;
  trackName: string | null;
  artistName: string | null;
  albumArt: string | null;
  deviceName: string | null;
  progressMs: number | null;
  durationMs: number | null;
}

const SPOTIFY_IDLE: SpotifyNowPlayingData = {
  isPlaying: false,
  trackName: null,
  artistName: null,
  albumArt: null,
  deviceName: null,
  progressMs: null,
  durationMs: null,
};

async function fetchSpotify(config: Config): Promise<SpotifyNowPlayingData | null> {
  if (!config.spotifyClientId || !config.spotifyClientSecret || !config.spotifyRefreshToken) return null;

  const current = await getCurrentlyPlaying(config);
  if (!current) return SPOTIFY_IDLE;

  return {
    isPlaying: current.isPlaying,
    trackName: current.trackName ?? null,
    artistName: current.artists ?? null,
    albumArt: current.albumArt ?? null,
    deviceName: current.deviceName ?? null,
    progressMs: current.progressMs ?? null,
    durationMs: current.durationMs ?? null,
  };
}

// Each source is fetched/caught independently so one integration's failure
// (e.g. a Spotify auth hiccup) never blanks out the others — mirrors the
// defensive spirit of every skills-mcp tool's own try/catch. Missing
// credentials return null/[] rather than throwing, same as each tool's
// notConfiguredResult() convention, since dashboard_state's n8n workflow
// needs to keep running for whatever sources ARE configured.
export function registerDashboardDataRoute(app: Express, config: Config): void {
  app.get("/internal/dashboard-data", async (_req, res) => {
    const [weather, calendar, spotify] = await Promise.all([
      fetchWeather(config).catch((e) => {
        console.error("dashboard-data: weather fetch failed", e);
        return null;
      }),
      fetchCalendar(config).catch((e) => {
        console.error("dashboard-data: calendar fetch failed", e);
        return [];
      }),
      fetchSpotify(config).catch((e) => {
        console.error("dashboard-data: spotify fetch failed", e);
        return null;
      }),
    ]);

    res.json({ weather, calendar, spotify });
  });
}
