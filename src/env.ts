export interface Env {
  /** KV namespace caching the OneMap bearer token between requests. */
  ONEMAP_TOKEN_CACHE: KVNamespace;
  /** OneMap account email, set via `wrangler secret put ONEMAP_EMAIL`. */
  ONEMAP_EMAIL: string;
  /** OneMap account password, set via `wrangler secret put ONEMAP_PASSWORD`. */
  ONEMAP_PASSWORD: string;
}
