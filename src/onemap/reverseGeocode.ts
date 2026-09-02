const REVGEOCODE_URL = "https://www.onemap.gov.sg/api/public/revgeocode";

export interface OneMapReverseGeocodeParams {
  /** WGS84 latitude, decimal degrees. */
  latitude: number;
  /** WGS84 longitude, decimal degrees. */
  longitude: number;
  /** Search radius in meters around the point, 0-500. */
  buffer: number;
  addressType: "All" | "HDB";
  otherFeatures: boolean;
}

interface OneMapGeocodeInfoRaw {
  BUILDINGNAME?: string;
  BLOCK?: string;
  ROAD?: string;
  POSTALCODE?: string;
  LATITUDE?: string;
  LONGITUDE?: string;
  /** OneMap sometimes sends this misspelled duplicate instead of/alongside LONGITUDE. */
  LONGTITUDE?: string;
}

interface OneMapReverseGeocodeResponseRaw {
  GeocodeInfo?: OneMapGeocodeInfoRaw[];
  /** Present (alongside real results) when OneMap rejected the token as missing/invalid. */
  error?: string;
}

export interface OneMapReverseGeocodeResult {
  buildingName?: string;
  block?: string;
  road?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
}

export interface OneMapReverseGeocodeResponse {
  results: OneMapReverseGeocodeResult[];
  /**
   * Set if OneMap flagged the token as missing/invalid despite us sending
   * one. Treated as a hard failure by the caller (see tools/reverseGeocode.ts).
   */
  warning?: string;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapResult(raw: OneMapGeocodeInfoRaw): OneMapReverseGeocodeResult {
  return {
    buildingName: raw.BUILDINGNAME || undefined,
    block: raw.BLOCK || undefined,
    road: raw.ROAD || undefined,
    postalCode: raw.POSTALCODE || undefined,
    latitude: toNumber(raw.LATITUDE),
    longitude: toNumber(raw.LONGITUDE ?? raw.LONGTITUDE)
  };
}

/**
 * Calls OneMap's Reverse Geocode API (`/api/public/revgeocode`, the WGS84
 * variant) with a required bearer token. This server only wraps the WGS84
 * endpoint — `revgeocodexy` (SVY21) is intentionally out of scope, since
 * consumer GPS sources (browser geolocation, Google Maps, WhatsApp location
 * shares) all produce WGS84 lat/long, never SVY21 X/Y.
 */
export async function reverseGeocodeOneMap(
  params: OneMapReverseGeocodeParams,
  token: string
): Promise<OneMapReverseGeocodeResponse> {
  const url = new URL(REVGEOCODE_URL);
  url.searchParams.set("location", `${params.latitude},${params.longitude}`);
  url.searchParams.set("buffer", String(params.buffer));
  url.searchParams.set("addressType", params.addressType);
  url.searchParams.set("otherFeatures", params.otherFeatures ? "Y" : "N");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OneMap reverse geocode failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const body = JSON.parse(text) as OneMapReverseGeocodeResponseRaw;
  return {
    results: (body.GeocodeInfo ?? []).map(mapResult),
    ...(body.error ? { warning: body.error } : {})
  };
}
