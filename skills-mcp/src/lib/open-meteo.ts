const GEOCODING_BASE_URL = "https://geocoding-api.open-meteo.com/v1";
const FORECAST_BASE_URL = "https://api.open-meteo.com/v1";

export interface GeoResult {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
}

async function geocodeOnce(query: string): Promise<GeoResult | null> {
  const res = await fetch(
    `${GEOCODING_BASE_URL}/search?name=${encodeURIComponent(query)}&count=1`,
  );
  if (!res.ok) {
    throw new Error(`Open-Meteo geocoding failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    results?: Array<{ name: string; country: string; latitude: number; longitude: number }>;
  };
  const first = data.results?.[0];
  if (!first) return null;
  return {
    name: first.name,
    country: first.country,
    latitude: first.latitude,
    longitude: first.longitude,
  };
}

// Open-Meteo's geocoder does plain name matching and returns zero results
// for compound phrasing like "bothell washington" or "Bothell, WA" — it
// wants a bare city name. Try the full string first, then a comma-split
// prefix ("City, ST" -> "City"), then progressively drop trailing words
// ("City State" -> "City") to recover the plain city name a human typed
// with a state/country qualifier attached.
export async function geocode(location: string): Promise<GeoResult | null> {
  const candidates: string[] = [location];

  const commaIdx = location.indexOf(",");
  if (commaIdx !== -1) {
    candidates.push(location.slice(0, commaIdx).trim());
  }

  const words = location.trim().split(/\s+/);
  for (let i = words.length - 1; i > 0; i--) {
    candidates.push(words.slice(0, i).join(" "));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    const result = await geocodeOnce(candidate);
    if (result) return result;
  }
  return null;
}

// WMO weather interpretation codes -> short human-readable label.
// https://open-meteo.com/en/docs (see "WMO Weather interpretation codes")
const WMO_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

export function describeWeatherCode(code: number): string {
  return WMO_CODES[code] ?? `Unknown conditions (code ${code})`;
}

export interface ForecastResult {
  temperature_c: number;
  feels_like_c: number;
  humidity_pct: number;
  wind_kph: number;
  conditions: string;
  today_high_c: number;
  today_low_c: number;
}

export async function forecast(latitude: number, longitude: number): Promise<ForecastResult> {
  const url =
    `${FORECAST_BASE_URL}/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo forecast failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    current: {
      temperature_2m: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
      weather_code: number;
      wind_speed_10m: number;
    };
    daily: {
      temperature_2m_max: number[];
      temperature_2m_min: number[];
    };
  };

  return {
    temperature_c: data.current.temperature_2m,
    feels_like_c: data.current.apparent_temperature,
    humidity_pct: data.current.relative_humidity_2m,
    wind_kph: data.current.wind_speed_10m,
    conditions: describeWeatherCode(data.current.weather_code),
    today_high_c: data.daily.temperature_2m_max[0],
    today_low_c: data.daily.temperature_2m_min[0],
  };
}
