import type { Env } from "../env.js";

const GET_TOKEN_URL = "https://www.onemap.gov.sg/api/auth/post/getToken";
const TOKEN_CACHE_KEY = "onemap:access_token";

/** Fetch a token this long before its real expiry, so a cached token never gets used right up to the wire. */
const EXPIRY_SAFETY_BUFFER_SECONDS = 5 * 60;
/** OneMap tokens are valid ~3 days; used only if `expiry_timestamp` is missing or unparseable. */
const FALLBACK_TOKEN_TTL_SECONDS = 3 * 24 * 60 * 60;
/** Cloudflare KV requires a minimum TTL on `expirationTtl`. */
const KV_MIN_TTL_SECONDS = 60;

interface CachedToken {
  accessToken: string;
  /** Unix seconds. */
  expiresAt: number;
}

interface GetTokenResponse {
  access_token?: string;
  expiry_timestamp?: string | number;
  error?: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function requestNewToken(env: Env): Promise<CachedToken> {
  const response = await fetch(GET_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: env.ONEMAP_EMAIL,
      password: env.ONEMAP_PASSWORD
    })
  });

  const body = (await response.json().catch(() => ({}))) as GetTokenResponse;

  if (!response.ok || !body.access_token) {
    throw new Error(
      `OneMap getToken failed (${response.status}): ${body.error ?? "no access_token in response"}`
    );
  }

  const parsedExpiry = Number(body.expiry_timestamp);
  const expiresAt = Number.isFinite(parsedExpiry) && parsedExpiry > nowSeconds()
    ? parsedExpiry
    : nowSeconds() + FALLBACK_TOKEN_TTL_SECONDS;

  return { accessToken: body.access_token, expiresAt };
}

/**
 * Returns a valid OneMap bearer token, reusing a cached one from KV when it
 * has more than {@link EXPIRY_SAFETY_BUFFER_SECONDS} left, otherwise fetching
 * and caching a fresh one via the Authentication API.
 *
 * Returns `null` (rather than throwing) if a token can't be obtained — the
 * OneMap Search API still serves unauthenticated requests, just in a
 * degraded/limited form, so callers can fall back to that instead of failing
 * the whole tool call.
 */
export async function getOneMapToken(env: Env): Promise<string | null> {
  try {
    const cachedRaw = await env.ONEMAP_TOKEN_CACHE.get(TOKEN_CACHE_KEY);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw) as CachedToken;
      if (cached.expiresAt - nowSeconds() > EXPIRY_SAFETY_BUFFER_SECONDS) {
        return cached.accessToken;
      }
    }

    const fresh = await requestNewToken(env);
    const ttl = Math.max(fresh.expiresAt - nowSeconds() - EXPIRY_SAFETY_BUFFER_SECONDS, KV_MIN_TTL_SECONDS);
    await env.ONEMAP_TOKEN_CACHE.put(TOKEN_CACHE_KEY, JSON.stringify(fresh), {
      expirationTtl: ttl
    });
    return fresh.accessToken;
  } catch (error) {
    console.error("getOneMapToken failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
