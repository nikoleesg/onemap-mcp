# onemap-mcp

A stateless MCP server on Cloudflare Workers that wraps [OneMap](https://www.onemap.gov.sg/apidocs/maps), Singapore's national mapping API.

**Scope**: the OneMap **Authentication**, **Search**, **Reverse Geocode**, **Routing**, and **Nearby Transport** API categories. Authentication is internal plumbing only — the server exposes five tools (`search`, `reverse_geocode`, `route`, `route_transit`, `nearby_transport`), which fetch and cache a OneMap bearer token on the caller's behalf. There is no separate "get a token" tool.

Only the **WGS84** reverse geocode variant (`revgeocode`) is wrapped — not the SVY21 variant (`revgeocodexy`). Consumer GPS sources (browser/JS geolocation, Google Maps, WhatsApp's "Send Location") all produce WGS84 lat/long, never SVY21 X/Y, so SVY21 is intentionally out of scope. For the same reason, `search` no longer returns SVY21 X/Y coordinates — only WGS84 lat/long.

Routing is split into two tools rather than one, because OneMap's `routeType=pt` (public transport) genuinely returns a different response shape from `walk`/`drive`/`cycle` — see "Tools" below.

## How it works

- Built on `@modelcontextprotocol/server` v2 (the web-standards TypeScript SDK), using `createMcpHandler` in stateless mode — a fresh `McpServer` is constructed per HTTP request, so the Worker holds no session state and can run on any isolate.
- No `/mcp` path — the Worker's base URL *is* the MCP endpoint. The transport doesn't care about the request path, only method/headers/body, so nothing is mounted under a subpath.
- The OneMap bearer token (valid ~3 days) is cached in a Workers KV namespace so most tool calls skip the `getToken` round trip; a new token is fetched automatically when the cached one is close to expiry.
- All five tools require a valid OneMap token on every call and fail closed: if a token can't be obtained (e.g. missing/invalid `ONEMAP_EMAIL`/`ONEMAP_PASSWORD`) or OneMap rejects it, the tool returns an error instead of calling the underlying API unauthenticated. `nearby_transport` differs slightly in how OneMap surfaces auth/validation errors — see its section below.
- The Worker does no authentication of its own — it relies on a Cloudflare Access application in front of it (see "Access control").

## Requirements

- A [OneMap API account](https://www.onemap.gov.sg/apidocs/register) (email + password) — this is what's authenticated, not an API key.
- A Cloudflare account with Workers + KV access.
- Node.js 20+ and `npx` for local development.

## Setup

```bash
npm install

# Secrets — never committed, set per environment. Both are required; the
# tools fail closed (error out) if either is missing.
npx wrangler secret put ONEMAP_EMAIL
npx wrangler secret put ONEMAP_PASSWORD
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in real values (`.dev.vars` is gitignored) — `wrangler dev` reads secrets from there instead of the Cloudflare dashboard.

## Development

```bash
npm run dev         # wrangler dev, serves http://localhost:8787
npm run typecheck   # tsc --noEmit
```

## Deploy

```bash
npm run deploy       # wrangler deploy
```

The `ONEMAP_TOKEN_CACHE` KV binding in `wrangler.jsonc` has no `id`: wrangler's [automatic resource provisioning](https://developers.cloudflare.com/changelog/2025-10-24-automatic-resource-provisioning/) (wrangler ≥ 4.45, open beta) creates the namespace on the first deploy and keeps the Worker linked to it afterwards — there's no namespace to create by hand and no id to paste in. If wrangler writes an `id` back into `wrangler.jsonc`, don't commit it. The namespace only caches the OneMap token, so if a deploy ever ends up bound to a fresh one, the only effect is one extra `getToken` call.

This deploys to `https://onemap-mcp.<your-subdomain>.workers.dev` (or a custom route, if configured in `wrangler.jsonc`) — connect an MCP client directly to that base URL, no path suffix.

`wrangler deploy` builds and ships the current `src/` on every run — there's no separate build step and no versioned release artifact beyond the `version` in `package.json`/`registry.yaml`. Redeploy any time a tool is added or changed to push it live; existing secrets and the KV namespace carry over automatically since they're bound to the Worker, not to a specific deploy.

## Tools

### `search`

Registered on this server as bare `search` (no service prefix), by design — see "Naming" below.

Search Singapore addresses, buildings, streets, and postal codes. Not typo-tolerant — works best with a postal code, building/place name, or street name.

| Param | Type | Default | Description |
|---|---|---|---|
| `query` | string | — | Address, building/place name, street name, or 6-digit postal code |
| `returnGeom` | boolean | `true` | Include lat/long coordinates |
| `getAddrDetails` | boolean | `true` | Include full address details |
| `page` | number | `1` | 1-indexed page number |
| `responseFormat` | `"markdown" \| "json"` | `"markdown"` | Output format |

### `reverse_geocode`

Registered on this server as bare `reverse_geocode` (no service prefix), same reasoning as `search` — see "Naming" below.

Look up the Singapore address nearest a WGS84 latitude/longitude point. Takes standard GPS-style coordinates — the format produced by browser/JS geolocation, Google Maps, and WhatsApp's "Send Location" — not SVY21 X/Y (see "Scope" above).

| Param | Type | Default | Description |
|---|---|---|---|
| `latitude` | number | — | WGS84 latitude in decimal degrees |
| `longitude` | number | — | WGS84 longitude in decimal degrees |
| `buffer` | number | `10` | Search radius in meters (0–500) |
| `addressType` | `"All" \| "HDB"` | `"All"` | Restrict to HDB buildings only, or all types |
| `otherFeatures` | boolean | `false` | Include additional nearby features beyond buildings |
| `responseFormat` | `"markdown" \| "json"` | `"markdown"` | Output format |

### `route`

Registered on this server as bare `route` (no service prefix), same reasoning as `search` — see "Naming" below.

Walking, driving, or cycling directions between two WGS84 points. All three share one request/response shape (a single route), unlike `route_transit` — see "Scope" above. `drive` responses can include an embedded alternate route (e.g. "Shortest distance" vs. the primary "Fastest route, assuming usual traffic"), surfaced as `alternatives`; `walk`/`cycle` typically have none.

| Param | Type | Default | Description |
|---|---|---|---|
| `startLatitude`, `startLongitude`, `endLatitude`, `endLongitude` | number | — | WGS84 coordinates |
| `mode` | `"walk" \| "drive" \| "cycle"` | — | Travel mode |
| `includeGeometry` | boolean | `false` | Include the decoded route shape as `[{latitude,longitude}]` — dense (every vertex of the path), not the sparse turn-by-turn points already in `instructions` |
| `includeDetails` | boolean | `false` | Include each instruction's location/compass heading, plus the route's `subtitle`/`viaRoute` |
| `responseFormat` | `"markdown" \| "json"` | `"markdown"` | Output format |

### `route_transit`

Registered on this server as bare `route_transit` (no service prefix), same reasoning as `search` — see "Naming" below.

Public transport (bus/MRT) itineraries between two WGS84 points, via OneMap's OpenTripPlanner-backed routing. Returns multiple full itineraries (each a sequence of mixed-mode legs — walk → bus → walk, etc.), not one route — a transit network has several genuinely valid ways to combine routes and transfers, unlike a road/path network's single deterministic shortest path.

| Param | Type | Default | Description |
|---|---|---|---|
| `startLatitude`, `startLongitude`, `endLatitude`, `endLongitude` | number | — | WGS84 coordinates |
| `date` | string | today (Asia/Singapore) | Departure date, `MM-DD-YYYY` |
| `time` | string | now (Asia/Singapore) | Departure time, `HH:mm:ss` (24-hour) |
| `mode` | `"TRANSIT" \| "BUS" \| "RAIL"` | `"TRANSIT"` | Which public transport modes to consider |
| `maxWalkDistance` | number | — | Max walking distance per walk leg, in meters |
| `numItineraries` | number | — | Number of itinerary options to return (1–10) |
| `includeGeometry` | boolean | `false` | Include each leg's decoded shape as `[{latitude,longitude}]` |
| `includeDetails` | boolean | `false` | Include each leg's intermediate stops and walking steps |
| `responseFormat` | `"markdown" \| "json"` | `"markdown"` | Output format |

### `nearby_transport`

Registered on this server as bare `nearby_transport` (no service prefix), same reasoning as `search` — see "Naming" below.

Nearest MRT/LRT stations and/or bus stops to a WGS84 point. Wraps two OneMap endpoints (`getNearestMrtStops`, `getNearestBusStops`) under one tool — they share an identical request shape and near-identical response shape (a flat list of stops), differing mainly in the `id` format. Despite its name, `getNearestMrtStops` also returns LRT stations.

Unlike the other four tools, OneMap's Nearby Transport endpoints return errors as real HTTP status codes (`400`/`401`/`403`/`429`) rather than a `200` with an embedded `error` field — so there's no soft "token rejected" warning path here, just a thrown error surfaced directly to the caller.

| Param | Type | Default | Description |
|---|---|---|---|
| `latitude`, `longitude` | number | — | WGS84 coordinates of the point to search around |
| `radiusMeters` | number | `2000` | Search radius in meters (max `5000`) |
| `type` | `"both" \| "mrt" \| "bus"` | `"both"` | Which kind of nearby transport to return — `"both"` makes two upstream calls |
| `responseFormat` | `"markdown" \| "json"` | `"markdown"` | Output format |

### Naming

All five tools are registered bare — `search`, `reverse_geocode`, `route`, `route_transit`, `nearby_transport`, not `onemap_search`/etc. — deliberately, because the ContextForge gateway this server is meant to run behind auto-prefixes tool names with the upstream server's name on the way through. Registered bare here, they surface as `onemap_search`/`onemap_reverse_geocode`/`onemap_route`/`onemap_route_transit`/`onemap_nearby_transport` once wrapped in the gateway — matching MCP's collision-avoidance convention (a service-prefixed name) without hardcoding the prefix twice. A client connecting to this Worker directly (bypassing ContextForge) sees the bare names instead.

## Access control

This Worker does no authentication of its own: it is meant to sit behind a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) self-hosted application, which authenticates every request at Cloudflare's edge before it reaches the Worker. Without one in front of it, the endpoint is open to anyone who finds the URL.

- **Make the Worker itself the Access destination** (Workers & Pages → the Worker → Access → *Protect this Worker behind Access* → **All traffic**, or a self-hosted application whose destination is this Worker). That covers every way in — routes, custom domains, the `*.workers.dev` URL and preview URLs. A hostname-based application covers only the hostnames it lists, so the `*.workers.dev` and preview URLs would stay open unless they're listed too.
- **Machine clients (e.g. the ContextForge gateway)** authenticate with an Access **service token**: add a *Service Auth* policy for it to the application, and the client sends `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every request (see "Client config"). Create the token under Zero Trust → Access → Service credentials → Service Tokens; the secret is shown only once.
- A plain browser visit gets Access's login page; once signed in, it reaches the Worker's friendly status message.

## Client config

This is a remote streamable-HTTP MCP server. Point any MCP client (including the ContextForge gateway) at the deployed base URL — there is no `/mcp` path suffix:

```json
{
  "mcpServers": {
    "onemap": {
      "type": "streamable-http",
      "url": "https://onemap-mcp.<YOUR_WORKERS_SUBDOMAIN>.workers.dev",
      "headers": {
        "CF-Access-Client-Id": "<CF_ACCESS_CLIENT_ID>",
        "CF-Access-Client-Secret": "<CF_ACCESS_CLIENT_SECRET>"
      }
    }
  }
}
```

The `headers` carry a Cloudflare Access service token — see "Access control" for where to create one. Without them, Access answers with a redirect to its login page instead of forwarding the request. Replace the `url` with your custom domain if the Access application is on one.

## Security notes

- No OneMap credentials or Cloudflare identifiers are stored in this repo — `ONEMAP_EMAIL`/`ONEMAP_PASSWORD` are Worker secrets, and `wrangler.jsonc` carries no KV namespace id — wrangler provisions and links the namespace at deploy time.
- The Cloudflare Access application is mandatory: the Worker itself accepts any request, so without Access in front of every hostname it answers on, anyone who finds the URL can drive OneMap searches under your account's quota.

## Out of scope

- The SVY21 reverse geocode endpoint (`revgeocodexy`) — see "Scope" above.
- Everything else in the OneMap API catalog — population query, theme/static map services, planning area queries, coordinate converters, etc. — is intentionally not wrapped yet.
