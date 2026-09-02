const SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search";

export interface OneMapSearchParams {
  searchVal: string;
  returnGeom: boolean;
  getAddrDetails: boolean;
  pageNum: number;
}

interface OneMapSearchResultRaw {
  SEARCHVAL: string;
  BLK_NO?: string;
  ROAD_NAME?: string;
  BUILDING?: string;
  ADDRESS?: string;
  POSTAL?: string;
  X?: string;
  Y?: string;
  LATITUDE?: string;
  LONGITUDE?: string;
}

interface OneMapSearchResponseRaw {
  found: number;
  totalNumPages: number;
  pageNum: number;
  results: OneMapSearchResultRaw[];
  /** Present (alongside real results) when OneMap rejected the token as missing/invalid. */
  error?: string;
}

export interface OneMapSearchResult {
  searchVal: string;
  blockNumber?: string;
  roadName?: string;
  building?: string;
  address?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
}

export interface OneMapSearchResponse {
  found: number;
  totalNumPages: number;
  pageNum: number;
  results: OneMapSearchResult[];
  /**
   * Set if OneMap flagged the token as missing/invalid despite us sending
   * one — e.g. it expired between the KV freshness check and this request.
   * Treated as a hard failure by the caller (see tools/search.ts), not
   * surfaced as a degraded-but-usable result.
   */
  warning?: string;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapResult(raw: OneMapSearchResultRaw): OneMapSearchResult {
  return {
    searchVal: raw.SEARCHVAL,
    blockNumber: raw.BLK_NO || undefined,
    roadName: raw.ROAD_NAME || undefined,
    building: raw.BUILDING || undefined,
    address: raw.ADDRESS || undefined,
    postalCode: raw.POSTAL || undefined,
    latitude: toNumber(raw.LATITUDE),
    longitude: toNumber(raw.LONGITUDE)
  };
}

/**
 * Calls OneMap's Search API (`/api/common/elastic/search`) with a required
 * bearer token. Always sends `Authorization` — this server does not fall
 * back to calling the endpoint unauthenticated.
 */
export async function searchOneMap(
  params: OneMapSearchParams,
  token: string
): Promise<OneMapSearchResponse> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("searchVal", params.searchVal);
  url.searchParams.set("returnGeom", params.returnGeom ? "Y" : "N");
  url.searchParams.set("getAddrDetails", params.getAddrDetails ? "Y" : "N");
  url.searchParams.set("pageNum", String(params.pageNum));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OneMap search failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const body = JSON.parse(text) as OneMapSearchResponseRaw;
  return {
    found: body.found ?? 0,
    totalNumPages: body.totalNumPages ?? 0,
    pageNum: body.pageNum ?? params.pageNum,
    results: (body.results ?? []).map(mapResult),
    ...(body.error ? { warning: body.error } : {})
  };
}
