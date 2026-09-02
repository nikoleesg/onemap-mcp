import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Env } from "../env.js";
import { getOneMapToken } from "../onemap/auth.js";
import { nearbyTransportOneMap, type NearbyStop, type NearbyTransportResponse } from "../onemap/nearbyTransport.js";

const NearbyTransportInputSchema = z.object({
  latitude: z.number().min(-90).max(90).describe("WGS84 latitude of the point to search around"),
  longitude: z.number().min(-180).max(180).describe("WGS84 longitude of the point to search around"),
  radiusMeters: z.number().int().min(1).max(5000).default(2000).describe("Search radius in meters (max 5000)"),
  type: z
    .enum(["both", "mrt", "bus"])
    .default("both")
    .describe("Which kind of nearby transport to return. 'mrt' also includes LRT stations. 'both' makes two upstream calls"),
  responseFormat: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("'markdown' for a human-readable list, 'json' for machine-readable structured data")
});

type NearbyTransportInput = z.infer<typeof NearbyTransportInputSchema>;

const NearbyStopSchema = z.object({
  id: z.string(),
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  road: z.string()
});

const NearbyTransportOutputSchema = z.object({
  mrtStations: z.array(NearbyStopSchema).optional(),
  busStops: z.array(NearbyStopSchema).optional()
});

type NearbyTransportOutput = z.infer<typeof NearbyTransportOutputSchema>;

function formatMarkdown(output: NearbyTransportOutput): string {
  const lines: string[] = ["# Nearby transport", ""];

  const describe = (stops: NearbyStop[] | undefined, label: string) => {
    if (!stops) return;
    lines.push(`## ${label}`);
    if (stops.length === 0) {
      lines.push("None found within the given radius.", "");
      return;
    }
    for (const stop of stops) {
      lines.push(`- **${stop.name}** (${stop.id}) — ${stop.road}`);
    }
    lines.push("");
  };

  describe(output.mrtStations, "MRT / LRT stations");
  describe(output.busStops, "Bus stops");

  return lines.join("\n");
}

function handleApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: OneMap nearby transport failed — ${message}. Check that ONEMAP_EMAIL/ONEMAP_PASSWORD secrets are set and valid, that latitude/longitude are valid WGS84 coordinates, and that radiusMeters is between 1 and 5000.`;
}

export function registerNearbyTransportTool(server: McpServer, env: Env): void {
  server.registerTool(
    "nearby_transport",
    {
      title: "Nearby Transport",
      description: `Find the nearest MRT/LRT stations and/or bus stops to a WGS84 point in Singapore, using OneMap's Nearby Transport API.

Two upstream OneMap endpoints under one tool — \`getNearestMrtStops\` (despite the name, this includes LRT stations too) and \`getNearestBusStops\` — sharing the same request shape. Use \`type\` to fetch one or both.

Authentication with OneMap is handled automatically (token fetched and cached internally) — no credentials are needed from the caller. If a valid token can't be obtained or OneMap rejects it, this tool fails with an error rather than falling back to an unauthenticated call.

Args:
  - latitude, longitude (number, required): WGS84 coordinates of the point to search around
  - radiusMeters (number, default 2000, max 5000): search radius in meters
  - type ('both' | 'mrt' | 'bus', default 'both'): which kind of nearby transport to return
  - responseFormat ('markdown' | 'json', default 'markdown'): output format

Returns:
  {
    "mrtStations"?: [{ "id": string, "name": string, "latitude": number, "longitude": number, "road": string }],
    "busStops"?: [{ "id": string, "name": string, "latitude": number, "longitude": number, "road": string }]
  }

Examples:
  - Use when: "What MRT stations and bus stops are near this address?" -> plain call with type="both"
  - Use when: "Is there an MRT station within 500m?" -> type="mrt", radiusMeters=500
  - Don't use when: you need door-to-door directions — use \`route\`/\`route_transit\` for that`,
      inputSchema: NearbyTransportInputSchema,
      outputSchema: NearbyTransportOutputSchema,
      annotations: {
        title: "Nearby Transport",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: NearbyTransportInput) => {
      try {
        const token = await getOneMapToken(env);
        if (!token) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: "Error: could not obtain a OneMap access token — refusing to look up nearby transport. Check that ONEMAP_EMAIL/ONEMAP_PASSWORD secrets are set and valid."
            }]
          };
        }

        const data: NearbyTransportResponse = await nearbyTransportOneMap(
          {
            latitude: params.latitude,
            longitude: params.longitude,
            radiusMeters: params.radiusMeters,
            type: params.type
          },
          token
        );

        const structuredContent: NearbyTransportOutput = data;
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
