import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Env } from "../env.js";
import { getOneMapToken } from "../onemap/auth.js";
import { searchOneMap, type OneMapSearchResponse, type OneMapSearchResult } from "../onemap/search.js";

const SearchInputSchema = z.object({
  query: z
    .string()
    .min(1, "query must not be empty")
    .max(200, "query must not exceed 200 characters")
    .describe("Address, building/place name, street name, or 6-digit postal code to search for, e.g. 'novena mrt' or '307653'"),
  returnGeom: z
    .boolean()
    .default(true)
    .describe("Include lat/long coordinates for each result"),
  getAddrDetails: z
    .boolean()
    .default(true)
    .describe("Include full address details (block number, road, postal code) for each result"),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("1-indexed page number; use with the response's total_pages to page through more results"),
  responseFormat: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("'markdown' for a human-readable list, 'json' for machine-readable structured data")
});

type SearchInput = z.infer<typeof SearchInputSchema>;

const SearchOutputSchema = z.object({
  found: z.number().describe("Total number of matches across all pages"),
  total_pages: z.number(),
  page: z.number(),
  results: z.array(
    z.object({
      searchVal: z.string(),
      blockNumber: z.string().optional(),
      roadName: z.string().optional(),
      building: z.string().optional(),
      address: z.string().optional(),
      postalCode: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional()
    })
  )
});

function formatMarkdown(query: string, data: OneMapSearchResponse): string {
  if (data.results.length === 0) {
    return `No results found for '${query}'.`;
  }

  const lines = [
    `# OneMap search results for '${query}'`,
    "",
    `Found ${data.found} match(es) — page ${data.pageNum} of ${data.totalNumPages}`,
    ""
  ];

  for (const result of data.results) {
    lines.push(`## ${result.building || result.searchVal}`);
    if (result.address) lines.push(`- **Address**: ${result.address}`);
    if (result.postalCode) lines.push(`- **Postal code**: ${result.postalCode}`);
    if (result.latitude !== undefined && result.longitude !== undefined) {
      lines.push(`- **Lat/Long**: ${result.latitude}, ${result.longitude}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function toStructuredOutput(data: OneMapSearchResponse): {
  found: number;
  total_pages: number;
  page: number;
  results: OneMapSearchResult[];
} {
  return {
    found: data.found,
    total_pages: data.totalNumPages,
    page: data.pageNum,
    results: data.results
  };
}

function handleApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: OneMap search failed — ${message}. Check that ONEMAP_EMAIL/ONEMAP_PASSWORD secrets are set and valid, and that 'query' isn't empty.`;
}

export function registerSearchTool(server: McpServer, env: Env): void {
  server.registerTool(
    "search",
    {
      title: "Search OneMap",
      description: `Search Singapore addresses, buildings, streets, and postal codes using OneMap's Search API.

This tool does NOT geocode arbitrary free text well — it matches against OneMap's address/building index, so it works best with a postal code, a building/place name, or a street name (e.g. "307653", "novena mrt", "orchard road"). It is not typo-tolerant.

Authentication with OneMap is handled automatically (token fetched and cached internally) — no credentials are needed from the caller. If a valid token can't be obtained or OneMap rejects it, this tool fails with an error rather than falling back to an unauthenticated search.

Args:
  - query (string, required): address, building/place name, street name, or 6-digit postal code
  - returnGeom (boolean, default true): include lat/long coordinates
  - getAddrDetails (boolean, default true): include full address details
  - page (number, default 1): 1-indexed page number
  - responseFormat ('markdown' | 'json', default 'markdown'): output format

Returns:
  {
    "found": number,        // total matches across all pages
    "total_pages": number,
    "page": number,
    "results": [{
      "searchVal": string,
      "blockNumber"?: string,
      "roadName"?: string,
      "building"?: string,
      "address"?: string,
      "postalCode"?: string,
      "latitude"?: number,
      "longitude"?: number
    }]
  }

Examples:
  - Use when: "Where is Novena MRT station?" -> query="novena mrt"
  - Use when: "What address is postal code 307653?" -> query="307653"
  - Don't use when: you need travel directions or population statistics (out of scope for this server)`,
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
      annotations: {
        title: "Search OneMap",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (params: SearchInput) => {
      try {
        const token = await getOneMapToken(env);
        if (!token) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: "Error: could not obtain a OneMap access token — refusing to search. Check that ONEMAP_EMAIL/ONEMAP_PASSWORD secrets are set and valid."
            }]
          };
        }

        const data = await searchOneMap(
          {
            searchVal: params.query,
            returnGeom: params.returnGeom,
            getAddrDetails: params.getAddrDetails,
            pageNum: params.page
          },
          token
        );

        if (data.warning) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: OneMap rejected the access token — ${data.warning}` }]
          };
        }

        const structuredContent = toStructuredOutput(data);
        const text =
          params.responseFormat === "json"
            ? JSON.stringify(structuredContent, null, 2)
            : formatMarkdown(params.query, data);

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
