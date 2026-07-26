import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { geocode, forecast } from "../lib/open-meteo.js";
import { errorResult, textResult } from "../types.js";

export function registerWeatherGet(server: McpServer, config: Config): void {
  server.registerTool(
    "weather_get",
    {
      title: "Get weather",
      description:
        "Get current weather conditions and today's high/low for a location, by geocoding " +
        "the name and querying Open-Meteo. Only call this when the user is actually asking " +
        "about current or upcoming weather conditions — for a place they name, or their " +
        "default location if they don't name one. Do NOT call this for weather mentioned " +
        "only in passing, general climate/geography trivia, or small talk that happens to " +
        "use a weather-related word without actually requesting a forecast. Returns an error " +
        "(not a crash) for an unrecognized location or when no location is given and none is " +
        "configured — in either case, ask the user which city they mean rather than guessing.",
      inputSchema: {
        location: z
          .string()
          .optional()
          .describe(
            "City name to check weather for, e.g. 'Austin, TX'. Omit to use the configured " +
              "home location.",
          ),
      },
    },
    async ({ location }) => {
      try {
        let latitude: number;
        let longitude: number;
        let resolvedName: string;

        if (location) {
          const geo = await geocode(location);
          if (!geo) {
            return errorResult(`Could not find a location matching '${location}'.`);
          }
          latitude = geo.latitude;
          longitude = geo.longitude;
          resolvedName = `${geo.name}, ${geo.country}`;
        } else if (config.homeLatitude !== undefined && config.homeLongitude !== undefined) {
          latitude = config.homeLatitude;
          longitude = config.homeLongitude;
          resolvedName = config.homeLocation ?? "home";
        } else if (config.homeLocation) {
          const geo = await geocode(config.homeLocation);
          if (!geo) {
            return errorResult(`Could not find the configured home location '${config.homeLocation}'.`);
          }
          latitude = geo.latitude;
          longitude = geo.longitude;
          resolvedName = `${geo.name}, ${geo.country}`;
        } else {
          return errorResult(
            "No location given and no home location configured (set HOME_LOCATION or " +
              "HOME_LATITUDE/HOME_LONGITUDE).",
          );
        }

        const fc = await forecast(latitude, longitude);
        return textResult({
          location: resolvedName,
          temperature_c: fc.temperature_c,
          feels_like_c: fc.feels_like_c,
          conditions: fc.conditions,
          humidity_pct: fc.humidity_pct,
          wind_kph: fc.wind_kph,
          today_high_c: fc.today_high_c,
          today_low_c: fc.today_low_c,
        });
      } catch (e) {
        return errorResult(`weather_get failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
