import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Env } from "../env.js";
import { getOneMapToken } from "../onemap/auth.js";
import {
  reverseGeocodeOneMap,
  type OneMapReverseGeocodeResponse,
  type OneMapReverseGeocodeResult
} from "../onemap/reverseGeocode.js";

const ReverseGeocodeInputSchema = z.object({
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .describe("WGS84 latitude in decimal degrees, e.g. from GPS, Google Maps, or a WhatsApp location share"),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .describe("WGS84 longitude in decimal degrees, e.g. from GPS, Google Maps, or a WhatsApp location share"),
  buffer: z
    .number()
    .int()
    .min(0)
    .max(500)
    .default(10)
    .describe("Search radius in meters around the point (0-500)"),
  addressType: z
    .enum(["All", "HDB"])
    .default("All")
    .describe("Restrict results to HDB buildings only, or return all building types"),
  otherFeatures: z
    .boolean()
    .default(false)
    .describe("Include additional nearby features (e.g. reservoirs, parks) beyond buildings"),
  responseFormat: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("'markdown' for a human-readable list, 'json' for machine-readable structured data")
});

type ReverseGeocodeInput = z.infer<typeof ReverseGeocodeInputSchema>;

const ReverseGeocodeOutputSchema = z.object({
  results: z.array(
    z.object({
      buildingName: z.string().optional(),
      block: z.string().optional(),
      road: z.string().optional(),
      postalCode: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional()
    })
  )
});

function formatMarkdown(latitude: number, longitude: number, data: OneMapReverseGeocodeResponse): string {
  if (data.results.length === 0) {
    return `No address found near (${latitude}, ${longitude}).`;
  }

  const lines = [`# Reverse geocode results for (${latitude}, ${longitude})`, ""];

  for (const result of data.results) {
    lines.push(`## ${result.buildingName || "(unnamed)"}`);
    if (result.block || result.road) {
      lines.push(`- **Block/Road**: ${[result.block, result.road].filter(Boolean).join(" ")}`);
    }
    if (result.postalCode) lines.push(`- **Postal code**: ${result.postalCode}`);
    if (result.latitude !== undefined && result.longitude !== undefined) {
      lines.push(`- **Lat/Long**: ${result.latitude}, ${result.longitude}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function toStructuredOutput(data: OneMapReverseGeocodeResponse): { results: OneMapReverseGeocodeResult[] } {
  return { results: data.results };
}

function handleApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: OneMap reverse geocode failed — ${message}. Check that ONEMAP_EMAIL/ONEMAP_PASSWORD secrets are set and valid, and that 'latitude'/'longitude' are in range.`;
}

export function registerReverseGeocodeTool(server: McpServer, env: Env): void {
  server.registerTool(
    "reverse_geocode",
    {
      title: "Reverse Geocode (OneMap)",
      description: `Look up the Singapore address nearest a WGS84 latitude/longitude point, using OneMap's Reverse Geocode API.

Takes standard WGS84 lat/long — the format produced by browser/GPS geolocation, Google Maps, and WhatsApp's "Send Location" — not SVY21 X/Y. This server only wraps the WGS84 variant of OneMap's reverse geocode endpoint; the SVY21 variant is intentionally out of scope, since consumer GPS sources never emit SVY21 coordinates.

Authentication with OneMap is handled automatically (token fetched and cached internally) — no credentials are needed from the caller. If a valid token can't be obtained or OneMap rejects it, this tool fails with an error rather than falling back to an unauthenticated call.

Args:
  - latitude (number, required): WGS84 latitude in decimal degrees
  - longitude (number, required): WGS84 longitude in decimal degrees
  - buffer (number, default 10): search radius in meters (0-500)
  - addressType ('All' | 'HDB', default 'All'): restrict to HDB buildings only, or all types
  - otherFeatures (boolean, default false): include additional nearby features beyond buildings
  - responseFormat ('markdown' | 'json', default 'markdown'): output format

Returns:
  {
    "results": [{
      "buildingName"?: string,
      "block"?: string,
      "road"?: string,
      "postalCode"?: string,
      "latitude"?: number,
      "longitude"?: number
    }]
  }

Examples:
  - Use when: "What's the address at 1.3121, 103.7864?" -> latitude=1.3121, longitude=103.7864
  - Use when: a user shares a GPS pin or a WhatsApp location and you need the street address
  - Don't use when: you have an address/place name and want coordinates instead — use \`search\` for that`,
      inputSchema: ReverseGeocodeInputSchema,
      outputSchema: ReverseGeocodeOutputSchema,
      annotations: {
        title: "Reverse Geocode (OneMap)",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: ReverseGeocodeInput) => {
      try {
        const token = await getOneMapToken(env);
        if (!token) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: "Error: could not obtain a OneMap access token — refusing to reverse geocode. Check that ONEMAP_EMAIL/ONEMAP_PASSWORD secrets are set and valid."
            }]
          };
        }

        const data = await reverseGeocodeOneMap(
          {
            latitude: params.latitude,
            longitude: params.longitude,
            buffer: params.buffer,
            addressType: params.addressType,
            otherFeatures: params.otherFeatures
          },
          token
        );

        if (data.warning) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: OneMap rejected the access token — ${data.warning}` }]
          };
        }

        const structuredContent = toStructuredOutput(data);
        const text =
          params.responseFormat === "json"
            ? JSON.stringify(structuredContent, null, 2)
            : formatMarkdown(params.latitude, params.longitude, data);

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
