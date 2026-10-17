import { McpServer } from "@modelcontextprotocol/server";

import type { Env } from "./env.js";
import { registerSearchTool } from "./tools/search.js";
import { registerReverseGeocodeTool } from "./tools/reverseGeocode.js";
import { registerRouteTool } from "./tools/route.js";
import { registerRouteTransitTool } from "./tools/routeTransit.js";
import { registerNearbyTransportTool } from "./tools/nearbyTransport.js";

const SERVER_NAME = "onemap-mcp";
const SERVER_VERSION = "0.7.0";

/** Builds a fresh McpServer bound to this request's `env` (KV binding + secrets). */
export function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerSearchTool(server, env);
  registerReverseGeocodeTool(server, env);
  registerRouteTool(server, env);
  registerRouteTransitTool(server, env);
  registerNearbyTransportTool(server, env);
  return server;
}
