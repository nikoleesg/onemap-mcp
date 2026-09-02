import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Env } from "../env.js";
import { getOneMapToken } from "../onemap/auth.js";
import {
  routeTransitOneMap,
  type RouteTransitResponse,
  type TransitItinerary,
  type TransitLeg,
  type TransitPlace
} from "../onemap/routeTransit.js";
import { decodePolyline, type DecodedPoint } from "../onemap/polyline.js";

const RouteTransitInputSchema = z.object({
  startLatitude: z.number().min(-90).max(90).describe("WGS84 latitude of the trip's start point"),
  startLongitude: z.number().min(-180).max(180).describe("WGS84 longitude of the trip's start point"),
  endLatitude: z.number().min(-90).max(90).describe("WGS84 latitude of the trip's end point"),
  endLongitude: z.number().min(-180).max(180).describe("WGS84 longitude of the trip's end point"),
  date: z.string().optional().describe("Departure date as MM-DD-YYYY. Defaults to the current date in Singapore"),
  time: z.string().optional().describe("Departure time as HH:mm:ss (24-hour). Defaults to the current time in Singapore"),
  mode: z.enum(["TRANSIT", "BUS", "RAIL"]).default("TRANSIT").describe("Which public transport modes to consider"),
  maxWalkDistance: z.number().min(0).optional().describe("Maximum walking distance in meters for any single walk leg"),
  numItineraries: z.number().int().min(1).max(10).optional().describe("Number of itinerary options to return (OneMap-defined cap applies server-side)"),
  includeGeometry: z
    .boolean()
    .default(false)
    .describe("Include each leg's decoded shape as a dense [{latitude,longitude}] point list, suitable for drawing the trip on a map. Off by default"),
  includeDetails: z
    .boolean()
    .default(false)
    .describe("Include each leg's intermediate stops (for bus/rail legs) and walking steps (for walk legs). Off by default — most callers only need which service to board and when"),
  responseFormat: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("'markdown' for a human-readable summary, 'json' for machine-readable structured data")
});

type RouteTransitInput = z.infer<typeof RouteTransitInputSchema>;

const TransitPlaceSchema = z.object({
  name: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  stopCode: z.string().optional()
});

const TransitStepSchema = z.object({
  distanceMeters: z.number(),
  direction: z.string().optional(),
  streetName: z.string().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() })
});

const TransitStopSchema = z.object({
  name: z.string().optional(),
  stopCode: z.string().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }),
  arrival: z.string(),
  departure: z.string()
});

const TransitLegSchema = z.object({
  mode: z.string(),
  route: z.string().optional(),
  agencyName: z.string().optional(),
  from: TransitPlaceSchema,
  to: TransitPlaceSchema,
  startTime: z.string(),
  endTime: z.string(),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  geometry: z.array(z.object({ latitude: z.number(), longitude: z.number() })).optional(),
  intermediateStops: z.array(TransitStopSchema).optional(),
  steps: z.array(TransitStepSchema).optional()
});

const TransitItinerarySchema = z.object({
  durationSeconds: z.number(),
  startTime: z.string(),
  endTime: z.string(),
  walkTimeSeconds: z.number(),
  transitTimeSeconds: z.number(),
  waitingTimeSeconds: z.number(),
  walkDistanceMeters: z.number(),
  transfers: z.number(),
  fare: z.string().optional(),
  legs: z.array(TransitLegSchema)
});

const RouteTransitOutputSchema = z.object({
  itineraries: z.array(TransitItinerarySchema)
});

type RouteTransitOutput = z.infer<typeof RouteTransitOutputSchema>;

/** Current date/time in Singapore, formatted the way OneMap expects (`date=MM-DD-YYYY`, `time=HH:mm:ss`). */
function defaultDateTime(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("month")}-${get("day")}-${get("year")}`,
    time: `${hour}:${get("minute")}:${get("second")}`
  };
}

function formatPlace(place: TransitPlace): z.infer<typeof TransitPlaceSchema> {
  return { name: place.name, latitude: place.latitude, longitude: place.longitude, stopCode: place.stopCode };
}

function geometryOf(leg: TransitLeg, includeGeometry: boolean): DecodedPoint[] | undefined {
  if (!includeGeometry || !leg.geometryEncoded) return undefined;
  return decodePolyline(leg.geometryEncoded);
}

function formatLeg(leg: TransitLeg, includeDetails: boolean, includeGeometry: boolean): z.infer<typeof TransitLegSchema> {
  return {
    mode: leg.mode,
    route: leg.route,
    agencyName: leg.agencyName,
    from: formatPlace(leg.from),
    to: formatPlace(leg.to),
    startTime: leg.startTime,
    endTime: leg.endTime,
    distanceMeters: leg.distanceMeters,
    durationSeconds: leg.durationSeconds,
    geometry: geometryOf(leg, includeGeometry),
    ...(includeDetails
      ? { intermediateStops: leg.intermediateStops, steps: leg.steps }
      : {})
  };
}

function formatItinerary(itinerary: TransitItinerary, includeDetails: boolean, includeGeometry: boolean): z.infer<typeof TransitItinerarySchema> {
  return {
    durationSeconds: itinerary.durationSeconds,
    startTime: itinerary.startTime,
    endTime: itinerary.endTime,
    walkTimeSeconds: itinerary.walkTimeSeconds,
    transitTimeSeconds: itinerary.transitTimeSeconds,
    waitingTimeSeconds: itinerary.waitingTimeSeconds,
    walkDistanceMeters: itinerary.walkDistanceMeters,
    transfers: itinerary.transfers,
    fare: itinerary.fare,
    legs: itinerary.legs.map((l) => formatLeg(l, includeDetails, includeGeometry))
  };
}

function toStructuredOutput(data: RouteTransitResponse, includeDetails: boolean, includeGeometry: boolean): RouteTransitOutput {
  return { itineraries: data.itineraries.map((i) => formatItinerary(i, includeDetails, includeGeometry)) };
}

function formatMarkdown(output: RouteTransitOutput): string {
  if (output.itineraries.length === 0) {
    return "No public transport itinerary found between these points at the requested time.";
  }

  const lines = ["# Public transport itineraries", ""];

  output.itineraries.forEach((itinerary, i) => {
    lines.push(`## Option ${i + 1}`);
    lines.push(`- **Duration**: ${itinerary.durationSeconds} s (walk ${itinerary.walkTimeSeconds}s, transit ${itinerary.transitTimeSeconds}s, wait ${itinerary.waitingTimeSeconds}s)`);
    lines.push(`- **Departs**: ${itinerary.startTime}`);
    lines.push(`- **Arrives**: ${itinerary.endTime}`);
    lines.push(`- **Transfers**: ${itinerary.transfers}`);
    if (itinerary.fare) lines.push(`- **Fare**: ${itinerary.fare}`);
    lines.push("", "Legs:");
    for (const leg of itinerary.legs) {
      const label = leg.mode === "WALK" ? "Walk" : `${leg.mode} ${leg.route ?? ""}`.trim();
      lines.push(`1. ${label}: ${leg.from.name ?? "?"} → ${leg.to.name ?? "?"} (${leg.durationSeconds} s, ${leg.distanceMeters} m)`);
    }
    lines.push("");
  });

  return lines.join("\n");
}

function handleApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: OneMap route (pt) failed — ${message}. Check that ONEMAP_EMAIL/ONEMAP_PASSWORD secrets are set and valid, and that start/end coordinates are valid WGS84 lat/long.`;
}

export function registerRouteTransitTool(server: McpServer, env: Env): void {
  server.registerTool(
    "route_transit",
    {
      title: "Route (Public Transport)",
      description: `Get public transport (bus/MRT) itineraries between two points in Singapore, using OneMap's Routing API — an OpenTripPlanner-backed itinerary search.

Takes standard WGS84 lat/long for both ends. Structurally different from the \`route\` tool (walk/drive/cycle): this returns multiple full itinerary options, each built from mixed-mode legs (walk → bus → walk → rail → walk, etc.), because a transit network genuinely has several valid ways to combine routes and transfers between two points — unlike a road/path network, which has one deterministic best path.

Authentication with OneMap is handled automatically (token fetched and cached internally) — no credentials are needed from the caller. If a valid token can't be obtained or OneMap rejects it, this tool fails with an error rather than falling back to an unauthenticated call.

Args:
  - startLatitude, startLongitude, endLatitude, endLongitude (number, required): WGS84 coordinates
  - date (string, optional): departure date as MM-DD-YYYY, defaults to today in Singapore
  - time (string, optional): departure time as HH:mm:ss (24-hour), defaults to now in Singapore
  - mode ('TRANSIT' | 'BUS' | 'RAIL', default 'TRANSIT'): which public transport modes to consider
  - maxWalkDistance (number, optional): max walking distance per walk leg, in meters
  - numItineraries (number, optional, 1-10): number of itinerary options to return
  - includeGeometry (boolean, default false): include each leg's decoded [{latitude,longitude}] shape
  - includeDetails (boolean, default false): include each leg's intermediate stops and walking steps
  - responseFormat ('markdown' | 'json', default 'markdown'): output format

Returns:
  {
    "itineraries": [{
      "durationSeconds": number, "startTime": string, "endTime": string,
      "walkTimeSeconds": number, "transitTimeSeconds": number, "waitingTimeSeconds": number,
      "walkDistanceMeters": number, "transfers": number, "fare"?: string,
      "legs": [{ "mode": string, "route"?: string, "agencyName"?: string, "from": {...}, "to": {...}, "startTime": string, "endTime": string, "distanceMeters": number, "durationSeconds": number, "geometry"?: [...], "intermediateStops"?: [...], "steps"?: [...] }]
    }]
  }

Examples:
  - Use when: "What bus do I take from A to B, and when does it arrive?" -> plain call with start/end
  - Use when: a user wants to compare walking vs. bus vs. cycling — call this alongside \`route\` with mode="walk"/"cycle"
  - Don't use when: the user wants driving/walking/cycling directions — use \`route\` for that`,
      inputSchema: RouteTransitInputSchema,
      outputSchema: RouteTransitOutputSchema,
      annotations: {
        title: "Route (Public Transport)",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: RouteTransitInput) => {
      try {
        const token = await getOneMapToken(env);
        if (!token) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: "Error: could not obtain a OneMap access token — refusing to route. Check that ONEMAP_EMAIL/ONEMAP_PASSWORD secrets are set and valid."
            }]
          };
        }

        const defaults = defaultDateTime();
        const data = await routeTransitOneMap(
          {
            startLatitude: params.startLatitude,
            startLongitude: params.startLongitude,
            endLatitude: params.endLatitude,
            endLongitude: params.endLongitude,
            date: params.date ?? defaults.date,
            time: params.time ?? defaults.time,
            mode: params.mode,
            maxWalkDistance: params.maxWalkDistance,
            numItineraries: params.numItineraries
          },
          token
        );

        if (data.warning) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: OneMap rejected the access token — ${data.warning}` }]
          };
        }

        const structuredContent = toStructuredOutput(data, params.includeDetails, params.includeGeometry);
        const text =
          params.responseFormat === "json"
            ? JSON.stringify(structuredContent, null, 2)
            : formatMarkdown(structuredContent);

        return {
          content: [{ type: "text", text }],
          structuredContent
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleApiError(error) }]
        };
      }
    }
  );
}
