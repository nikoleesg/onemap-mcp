const ROUTE_URL = "https://www.onemap.gov.sg/api/public/routingsvc/route";

export type RouteMode = "walk" | "drive" | "cycle";

export interface RouteParams {
  startLatitude: number;
  startLongitude: number;
  endLatitude: number;
  endLongitude: number;
  mode: RouteMode;
}

/**
 * A single turn-by-turn step. OneMap's raw `route_instructions` tuple is
 * `[direction, streetName, distanceMeters, "lat,lon", durationSeconds,
 * distanceDisplay, headingAfter, headingBefore, travelMode, instructionText]`
 * — verified against live responses; index 3 is a literal per-step
 * coordinate (not a geometry offset), and index 6/7 are the compass heading
 * after/before this turn (index 6 of one step equals index 7 of the next).
 */
interface OneMapRouteInstructionRaw
  extends Array<string | number> {
  0: string;
  1: string;
  2: number;
  3: string;
  4: number;
  5: string;
  6: string;
  7: string;
  8: string;
  9: string;
}

interface OneMapRouteSummaryRaw {
  start_point?: string;
  end_point?: string;
  total_time?: number;
  total_distance?: number;
}

interface OneMapRouteRaw {
  status?: number;
  status_message?: string;
  route_geometry?: string;
  route_instructions?: OneMapRouteInstructionRaw[];
  route_summary?: OneMapRouteSummaryRaw;
  /** Present only on some `drive` responses — a fully-formed embedded alternate route (e.g. "Shortest distance" vs the primary "Fastest route, assuming usual traffic"). Not seen on walk/cycle. */
  phyroute?: OneMapRouteRaw;
  viaRoute?: string;
  subtitle?: string;
  /** Present (alongside a mostly-empty body) when OneMap rejected the token as missing/invalid. */
  error?: string;
}

export interface RouteInstruction {
  instruction: string;
  streetName?: string;
  distanceMeters: number;
  durationSeconds: number;
  location: { latitude: number; longitude: number };
  headingBefore: string;
  headingAfter: string;
}

export interface RouteVariant {
  distanceMeters: number;
  durationSeconds: number;
  startPoint?: string;
  endPoint?: string;
  subtitle?: string;
  viaRoute?: string;
  instructions: RouteInstruction[];
  /** Raw encoded polyline (Google Encoded Polyline Algorithm Format, precision 5) — decode with `decodePolyline` only when the caller actually wants geometry. */
  geometryEncoded?: string;
}

export interface RouteResponse {
  mode: RouteMode;
  route: RouteVariant;
  /** From `phyroute`, when present — otherwise empty. Currently only ever seen (0 or 1 entries) on `drive`. */
  alternatives: RouteVariant[];
  /**
   * Set if OneMap flagged the token as missing/invalid despite us sending
   * one. Treated as a hard failure by the caller (see tools/route.ts).
   */
  warning?: string;
}

function mapInstruction(raw: OneMapRouteInstructionRaw): RouteInstruction {
  const [direction, streetName, distanceMeters, coords, durationSeconds, , headingAfter, headingBefore, , instructionText] = raw;
  const [latitude = 0, longitude = 0] = coords.split(",").map(Number);
  return {
    instruction: instructionText || direction,
    streetName: streetName || undefined,
    distanceMeters,
    durationSeconds,
    location: { latitude, longitude },
    headingBefore,
    headingAfter
  };
}

function mapVariant(raw: OneMapRouteRaw): RouteVariant {
  return {
    distanceMeters: raw.route_summary?.total_distance ?? 0,
    durationSeconds: raw.route_summary?.total_time ?? 0,
    startPoint: raw.route_summary?.start_point || undefined,
    endPoint: raw.route_summary?.end_point || undefined,
    subtitle: raw.subtitle || undefined,
    viaRoute: raw.viaRoute || undefined,
    instructions: (raw.route_instructions ?? []).map(mapInstruction),
    geometryEncoded: raw.route_geometry || undefined
  };
}

/**
 * Calls OneMap's Routing API (`/api/public/routingsvc/route`) for the
 * `walk`/`drive`/`cycle` route types, all of which share the same
 * single-route response shape (as opposed to `pt`, which returns multiple
 * itineraries — see onemap/routeTransit.ts). No date/time params: these
 * three modes route over a static network with no time-of-day modeling
 * exposed via the API.
 */
export async function routeOneMap(params: RouteParams, token: string): Promise<RouteResponse> {
  const url = new URL(ROUTE_URL);
  url.searchParams.set("start", `${params.startLatitude},${params.startLongitude}`);
  url.searchParams.set("end", `${params.endLatitude},${params.endLongitude}`);
  url.searchParams.set("routeType", params.mode);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OneMap route failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const body = JSON.parse(text) as OneMapRouteRaw;
  if (body.error) {
    return { mode: params.mode, route: mapVariant(body), alternatives: [], warning: body.error };
  }
  if (body.status !== 0) {
    throw new Error(`OneMap route failed: ${body.status_message ?? "no route found"}`);
  }

  return {
    mode: params.mode,
    route: mapVariant(body),
    alternatives: body.phyroute ? [mapVariant(body.phyroute)] : []
  };
}
