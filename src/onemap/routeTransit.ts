const ROUTE_URL = "https://www.onemap.gov.sg/api/public/routingsvc/route";

export type TransitMode = "TRANSIT" | "BUS" | "RAIL";

export interface RouteTransitParams {
  startLatitude: number;
  startLongitude: number;
  endLatitude: number;
  endLongitude: number;
  date: string;
  time: string;
  mode: TransitMode;
  maxWalkDistance?: number;
  numItineraries?: number;
}

interface OneMapPtPlaceRaw {
  name?: string;
  lat: number;
  lon: number;
  stopCode?: string;
}

interface OneMapPtStepRaw {
  distance: number;
  relativeDirection?: string;
  absoluteDirection?: string;
  streetName?: string;
  lat: number;
  lon: number;
}

interface OneMapPtIntermediateStopRaw {
  name?: string;
  stopCode?: string;
  lat: number;
  lon: number;
  arrival: number;
  departure: number;
}

interface OneMapPtLegRaw {
  startTime: number;
  endTime: number;
  duration: number;
  distance: number;
  mode: string;
  route?: string;
  agencyName?: string;
  routeShortName?: string;
  from: OneMapPtPlaceRaw;
  to: OneMapPtPlaceRaw;
  legGeometry?: { points?: string };
  steps?: OneMapPtStepRaw[];
  intermediateStops?: OneMapPtIntermediateStopRaw[];
}

interface OneMapPtItineraryRaw {
  duration: number;
  startTime: number;
  endTime: number;
  walkTime: number;
  transitTime: number;
  waitingTime: number;
  walkDistance: number;
  transfers: number;
  fare?: string;
  legs: OneMapPtLegRaw[];
}

interface OneMapPtResponseRaw {
  plan?: { itineraries?: OneMapPtItineraryRaw[] };
  /** Present (alongside a mostly-empty body) when OneMap rejected the token as missing/invalid. */
  error?: string;
}

export interface TransitPlace {
  name?: string;
  latitude: number;
  longitude: number;
  stopCode?: string;
}

export interface TransitStep {
  distanceMeters: number;
  direction?: string;
  streetName?: string;
  location: { latitude: number; longitude: number };
}

export interface TransitStop {
  name?: string;
  stopCode?: string;
  location: { latitude: number; longitude: number };
  arrival: string;
  departure: string;
}

export interface TransitLeg {
  mode: string;
  route?: string;
  agencyName?: string;
  from: TransitPlace;
  to: TransitPlace;
  startTime: string;
  endTime: string;
  distanceMeters: number;
  durationSeconds: number;
  /** Raw encoded polyline for this leg only — decode with `decodePolyline` only when requested. */
  geometryEncoded?: string;
  intermediateStops: TransitStop[];
  steps: TransitStep[];
}

export interface TransitItinerary {
  durationSeconds: number;
  startTime: string;
  endTime: string;
  walkTimeSeconds: number;
  transitTimeSeconds: number;
  waitingTimeSeconds: number;
  walkDistanceMeters: number;
  transfers: number;
  fare?: string;
  legs: TransitLeg[];
}

export interface RouteTransitResponse {
  itineraries: TransitItinerary[];
  /**
   * Set if OneMap flagged the token as missing/invalid despite us sending
   * one. Treated as a hard failure by the caller (see tools/routeTransit.ts).
   */
  warning?: string;
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function mapPlace(raw: OneMapPtPlaceRaw): TransitPlace {
  return { name: raw.name || undefined, latitude: raw.lat, longitude: raw.lon, stopCode: raw.stopCode || undefined };
}

function mapStep(raw: OneMapPtStepRaw): TransitStep {
  return {
    distanceMeters: raw.distance,
    direction: raw.absoluteDirection || raw.relativeDirection || undefined,
    streetName: raw.streetName || undefined,
    location: { latitude: raw.lat, longitude: raw.lon }
  };
}

function mapIntermediateStop(raw: OneMapPtIntermediateStopRaw): TransitStop {
  return {
    name: raw.name || undefined,
    stopCode: raw.stopCode || undefined,
    location: { latitude: raw.lat, longitude: raw.lon },
    arrival: toIso(raw.arrival),
    departure: toIso(raw.departure)
  };
}

function mapLeg(raw: OneMapPtLegRaw): TransitLeg {
  return {
    mode: raw.mode,
    route: raw.route || undefined,
    agencyName: raw.agencyName || undefined,
    from: mapPlace(raw.from),
    to: mapPlace(raw.to),
    startTime: toIso(raw.startTime),
    endTime: toIso(raw.endTime),
    distanceMeters: raw.distance,
    durationSeconds: raw.duration,
    geometryEncoded: raw.legGeometry?.points || undefined,
    intermediateStops: (raw.intermediateStops ?? []).map(mapIntermediateStop),
    steps: (raw.steps ?? []).map(mapStep)
  };
}

function mapItinerary(raw: OneMapPtItineraryRaw): TransitItinerary {
  return {
    durationSeconds: raw.duration,
    startTime: toIso(raw.startTime),
    endTime: toIso(raw.endTime),
    walkTimeSeconds: raw.walkTime,
    transitTimeSeconds: raw.transitTime,
    waitingTimeSeconds: raw.waitingTime,
    walkDistanceMeters: raw.walkDistance,
    transfers: raw.transfers,
    fare: raw.fare || undefined,
    legs: (raw.legs ?? []).map(mapLeg)
  };
}

/**
 * Calls OneMap's Routing API (`/api/public/routingsvc/route`) for the `pt`
 * (public transport) route type — an OpenTripPlanner-backed itinerary
 * search, structurally different from `walk`/`drive`/`cycle` (see
 * onemap/route.ts): it returns multiple full itineraries, each built from
 * mixed-mode legs (walk/bus/rail), rather than one single route.
 */
export async function routeTransitOneMap(params: RouteTransitParams, token: string): Promise<RouteTransitResponse> {
  const url = new URL(ROUTE_URL);
  url.searchParams.set("start", `${params.startLatitude},${params.startLongitude}`);
  url.searchParams.set("end", `${params.endLatitude},${params.endLongitude}`);
  url.searchParams.set("routeType", "pt");
  url.searchParams.set("date", params.date);
  url.searchParams.set("time", params.time);
  url.searchParams.set("mode", params.mode);
  if (params.maxWalkDistance !== undefined) url.searchParams.set("maxWalkDistance", String(params.maxWalkDistance));
  if (params.numItineraries !== undefined) url.searchParams.set("numItineraries", String(params.numItineraries));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OneMap route (pt) failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const body = JSON.parse(text) as OneMapPtResponseRaw;
  if (body.error) {
    return { itineraries: [], warning: body.error };
  }

  return { itineraries: (body.plan?.itineraries ?? []).map(mapItinerary) };
}
