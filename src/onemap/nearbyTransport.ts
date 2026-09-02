const MRT_URL = "https://www.onemap.gov.sg/api/public/nearbysvc/getNearestMrtStops";
const BUS_URL = "https://www.onemap.gov.sg/api/public/nearbysvc/getNearestBusStops";

export type NearbyTransportType = "both" | "mrt" | "bus";

export interface NearbyTransportParams {
  latitude: number;
  longitude: number;
  radiusMeters?: number;
  type: NearbyTransportType;
}

interface OneMapNearbyStopRaw {
  id: string | number;
  name: string;
  lat: number;
  lon: number;
  road: string;
}

export interface NearbyStop {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  road: string;
}

export interface NearbyTransportResponse {
  /** Present when `type` is "both" or "mrt". Despite the upstream endpoint's name, this also includes LRT stations (see OneMap's sample response). */
  mrtStations?: NearbyStop[];
  /** Present when `type` is "both" or "bus". */
  busStops?: NearbyStop[];
}

function mapStop(raw: OneMapNearbyStopRaw): NearbyStop {
  return {
    id: String(raw.id),
    name: raw.name,
    latitude: raw.lat,
    longitude: raw.lon,
    road: raw.road
  };
}

async function fetchStops(url: string, params: NearbyTransportParams, token: string): Promise<NearbyStop[]> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("latitude", String(params.latitude));
  requestUrl.searchParams.set("longitude", String(params.longitude));
  if (params.radiusMeters !== undefined) requestUrl.searchParams.set("radius_in_meters", String(params.radiusMeters));

  const response = await fetch(requestUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OneMap nearby transport failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const body = JSON.parse(text) as OneMapNearbyStopRaw[];
  return body.map(mapStop);
}

/**
 * Calls OneMap's Nearby Transport API — two separate endpoints
 * (`getNearestMrtStops`, `getNearestBusStops`) sharing the same request
 * shape (lat/long + radius, up to 5000m) and near-identical response shape
 * (a flat array of stops). Unlike search/reverse-geocode/route, errors come
 * back as real HTTP error statuses (400/401/403/429), not a 200 with an
 * embedded `error` field — so there's no `warning`-style soft failure here,
 * just a thrown error on any non-2xx response.
 */
export async function nearbyTransportOneMap(params: NearbyTransportParams, token: string): Promise<NearbyTransportResponse> {
  const result: NearbyTransportResponse = {};

  if (params.type === "both" || params.type === "mrt") {
    result.mrtStations = await fetchStops(MRT_URL, params, token);
  }
  if (params.type === "both" || params.type === "bus") {
    result.busStops = await fetchStops(BUS_URL, params, token);
  }

  return result;
}
