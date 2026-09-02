import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Env } from "../env.js";
import { getOneMapToken } from "../onemap/auth.js";
import { routeOneMap, type RouteInstruction, type RouteMode, type RouteResponse, type RouteVariant } from "../onemap/route.js";
import { decodePolyline, type DecodedPoint } from "../onemap/polyline.js";

const RouteInputSchema = z.object({
  startLatitude: z.number().min(-90).max(90).describe("WGS84 latitude of the route's start point"),
  startLongitude: z.number().min(-180).max(180).describe("WGS84 longitude of the route's start point"),
  endLatitude: z.number().min(-90).max(90).describe("WGS84 latitude of the route's end point"),
  endLongitude: z.number().min(-180).max(180).describe("WGS84 longitude of the route's end point"),
  mode: z.enum(["walk", "drive", "cycle"]).describe("Travel mode. For public transport, use the separate `route_transit` tool instead"),
  includeGeometry: z
    .boolean()
    .default(false)
    .describe("Include the decoded route shape as a dense [{latitude,longitude}] point list, suitable for drawing the route on a map. Off by default — most callers only need distance/duration/instructions"),
  includeDetails: z
    .boolean()
    .default(false)
    .describe("Include extra per-instruction detail: each step's location and compass heading before/after the turn, plus the route's `subtitle`/`viaRoute` summary text when present"),
  responseFormat: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("'markdown' for a human-readable summary, 'json' for machine-readable structured data")
});

type RouteInput = z.infer<typeof RouteInputSchema>;

const RouteInstructionSchema = z.object({
  instruction: z.string(),
  streetName: z.string().optional(),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  headingBefore: z.string().optional(),
  headingAfter: z.string().optional()
});

const RouteGeometryPointSchema = z.object({ latitude: z.number(), longitude: z.number() });

const RouteVariantSchema = z.object({
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  startPoint: z.string().optional(),
  endPoint: z.string().optional(),
  subtitle: z.string().optional(),
  viaRoute: z.string().optional(),
  instructions: z.array(RouteInstructionSchema),
  geometry: z.array(RouteGeometryPointSchema).optional()
});

const RouteOutputSchema = z.object({
  mode: z.enum(["walk", "drive", "cycle"]),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  startPoint: z.string().optional(),
  endPoint: z.string().optional(),
  subtitle: z.string().optional(),
  viaRoute: z.string().optional(),
  instructions: z.array(RouteInstructionSchema),
  geometry: z.array(RouteGeometryPointSchema).optional(),
  alternatives: z.array(RouteVariantSchema).optional()
});

type RouteOutput = z.infer<typeof RouteOutputSchema>;

function formatInstruction(instruction: RouteInstruction, includeDetails: boolean): z.infer<typeof RouteInstructionSchema> {
  return {
    instruction: instruction.instruction,
    streetName: instruction.streetName,
    distanceMeters: instruction.distanceMeters,
    durationSeconds: instruction.durationSeconds,
    ...(includeDetails
      ? { location: instruction.location, headingBefore: instruction.headingBefore, headingAfter: instruction.headingAfter }
      : {})
  };
}

function geometryOf(variant: RouteVariant, includeGeometry: boolean): DecodedPoint[] | undefined {
  if (!includeGeometry || !variant.geometryEncoded) return undefined;
  return decodePolyline(variant.geometryEncoded);
}

function formatVariant(variant: RouteVariant, includeDetails: boolean, includeGeometry: boolean): z.infer<typeof RouteVariantSchema> {
  return {
    distanceMeters: variant.distanceMeters,
    durationSeconds: variant.durationSeconds,
    startPoint: variant.startPoint,
    endPoint: variant.endPoint,
    subtitle: variant.subtitle,
    viaRoute: variant.viaRoute,
    instructions: variant.instructions.map((i) => formatInstruction(i, includeDetails)),
    geometry: geometryOf(variant, includeGeometry)
  };
}

function toStructuredOutput(mode: RouteMode, data: RouteResponse, includeDetails: boolean, includeGeometry: boolean): RouteOutput {
  const primary = formatVariant(data.route, includeDetails, includeGeometry);
  return {
    mode,
    ...primary,
    alternatives: data.alternatives.length ? data.alternatives.map((a) => formatVariant(a, includeDetails, includeGeometry)) : undefined
  };
}

function formatMarkdown(mode: RouteMode, output: RouteOutput): string {
  const lines = [`# ${mode} route`, ""];

  const describe = (v: RouteOutput | z.infer<typeof RouteVariantSchema>, label: string) => {
    lines.push(`## ${label}`);
    if (v.subtitle) lines.push(`_${v.subtitle}_`);
    lines.push(`- **Distance**: ${v.distanceMeters} m`);
    lines.push(`- **Duration**: ${v.durationSeconds} s`);
    if (v.startPoint || v.endPoint) lines.push(`- **From/To**: ${v.startPoint || "?"} → ${v.endPoint || "?"}`);
    if (v.geometry) lines.push(`- **Geometry**: ${v.geometry.length} points (see JSON output)`);
    lines.push("", "Steps:");
    for (const step of v.instructions) {
      lines.push(`1. ${step.instruction} (${step.distanceMeters} m, ${step.durationSeconds} s)${step.streetName ? ` — ${step.streetName}` : ""}`);
    }
    lines.push("");
  };

  describe(output, "Route");
  for (const [i, alt] of (output.alternatives ?? []).entries()) {
    describe(alt, `Alternative ${i + 1}`);
  }

  return lines.join("\n");
}

function handleApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: OneMap route failed — ${message}. Check that ONEMAP_EMAIL/ONEMAP_PASSWORD secrets are set and valid, and that start/end coordinates are valid WGS84 lat/long.`;
}

export function registerRouteTool(server: McpServer, env: Env): void {
  server.registerTool(
    "route",
    {
      title: "Route (Walk / Drive / Cycle)",
      description: `Get a walking, driving, or cycling route between two points in Singapore, using OneMap's Routing API.

Takes standard WGS84 lat/long for both ends. For public transport directions, use the separate \`route_transit\` tool instead — public transport itinerary planning has a materially different request/response shape (multiple itinerary options built from mixed-mode legs) from these three point-to-point modes.

\`drive\` routes can include an embedded alternate (e.g. "Shortest distance" vs the primary "Fastest route, assuming usual traffic") — surfaced as \`alternatives\`. \`walk\`/\`cycle\` typically have none.

Authentication with OneMap is handled automatically (token fetched and cached internally) — no credentials are needed from the caller. If a valid token can't be obtained or OneMap rejects it, this tool fails with an error rather than falling back to an unauthenticated call.

Args:
  - startLatitude, startLongitude, endLatitude, endLongitude (number, required): WGS84 coordinates
  - mode ('walk' | 'drive' | 'cycle', required): travel mode
  - includeGeometry (boolean, default false): include decoded [{latitude,longitude}] route shape
  - includeDetails (boolean, default false): include per-instruction location/heading and route subtitle/viaRoute
  - responseFormat ('markdown' | 'json', default 'markdown'): output format

Returns:
  {
    "mode": string,
    "distanceMeters": number,
    "durationSeconds": number,
    "startPoint"?: string,
    "endPoint"?: string,
    "subtitle"?: string,
    "viaRoute"?: string,
    "instructions": [{ "instruction": string, "streetName"?: string, "distanceMeters": number, "durationSeconds": number, "location"?: {...}, "headingBefore"?: string, "headingAfter"?: string }],
    "geometry"?: [{ "latitude": number, "longitude": number }],
    "alternatives"?: [ /* same shape as the route itself, minus "mode" */ ]
  }

Examples:
  - Use when: "How do I walk from A to B?" -> mode="walk"
  - Use when: "What's the driving route and how long will it take?" -> mode="drive"
  - Don't use when: the user wants bus/train directions — use \`route_transit\` for that`,
      inputSchema: RouteInputSchema,
      outputSchema: RouteOutputSchema,
      annotations: {
        title: "Route (Walk / Drive / Cycle)",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: RouteInput) => {
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

        const data = await routeOneMap(
          {
            startLatitude: params.startLatitude,
            startLongitude: params.startLongitude,
            endLatitude: params.endLatitude,
            endLongitude: params.endLongitude,
            mode: params.mode
          },
          token
        );

        if (data.warning) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: OneMap rejected the access token — ${data.warning}` }]
          };
        }

        const structuredContent = toStructuredOutput(params.mode, data, params.includeDetails, params.includeGeometry);
        const text =
          params.responseFormat === "json"
            ? JSON.stringify(structuredContent, null, 2)
            : formatMarkdown(params.mode, structuredContent);

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
