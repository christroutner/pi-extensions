import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Simple in-memory cache
const SEARCH_CACHE = new Map<string, { value: unknown; expiresAt: number }>();

// Brave freshness shortcuts
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

function getApiKey(): string | null {
  const fromEnv = (process.env.BRAVE_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  return null;
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return lower;
  }

  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) return undefined;

  const [, start, end] = match;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) return undefined;
  if (start > end) return undefined;

  return `${start}to${end}`;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number.parseInt);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function getCacheKey(query: string, count: number, country?: string, search_lang?: string, ui_lang?: string, freshness?: string): string {
  return `brave:${query.toLowerCase()}:${count}:${country || "default"}:${search_lang || "default"}:${ui_lang || "default"}:${freshness || "default"}`;
}

function readCache(key: string): unknown | null {
  const entry = SEARCH_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    SEARCH_CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key: string, value: unknown, ttlMs: number) {
  if (ttlMs <= 0) return;
  // Simple LRU: remove oldest if cache is too large
  if (SEARCH_CACHE.size >= 100) {
    const firstKey = SEARCH_CACHE.keys().next().value;
    if (firstKey) SEARCH_CACHE.delete(firstKey);
  }
  SEARCH_CACHE.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

async function runBraveSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
}): Promise<Record<string, unknown>> {
  const cacheKey = getCacheKey(
    params.query,
    params.count,
    params.country,
    params.search_lang,
    params.ui_lang,
    params.freshness
  );

  const cached = readCache(cacheKey);
  if (cached) {
    return { ...(cached as Record<string, unknown>), cached: true };
  }

  const start = Date.now();
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));

  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": params.apiKey,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
    }

    const data = (await res.json()) as BraveSearchResponse;
    const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
    const mapped = results.map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      description: entry.description ?? "",
      published: entry.age ?? undefined,
      siteName: resolveSiteName(entry.url ?? ""),
    }));

    const payload = {
      query: params.query,
      provider: "brave",
      count: mapped.length,
      tookMs: Date.now() - start,
      results: mapped,
    };

    writeCache(cacheKey, payload, DEFAULT_CACHE_TTL_MS);
    return payload;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${params.timeoutSeconds} seconds`);
    }
    throw err;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query string." }),
      count: Type.Optional(
        Type.Number({
          description: "Number of results to return (1-10).",
          minimum: 1,
          maximum: MAX_SEARCH_COUNT,
        })
      ),
      country: Type.Optional(
        Type.String({
          description:
            "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
        })
      ),
      search_lang: Type.Optional(
        Type.String({
          description: "ISO language code for search results (e.g., 'de', 'en', 'fr').",
        })
      ),
      ui_lang: Type.Optional(
        Type.String({
          description: "ISO language code for UI elements.",
        })
      ),
      freshness: Type.Optional(
        Type.String({
          description:
            "Filter results by discovery time. Values: 'pd' (past 24h), 'pw' (past week), 'pm' (past month), 'py' (past year), or date range 'YYYY-MM-DDtoYYYY-MM-DD'.",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = getApiKey();
      if (!apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "Error: BRAVE_API_KEY environment variable is not set. Get an API key from https://brave.com/search/api/",
            },
          ],
          details: { error: "missing_api_key" },
          isError: true,
        };
      }

      const { query, count, country, search_lang, ui_lang, freshness: rawFreshness } = params as {
        query: string;
        count?: number;
        country?: string;
        search_lang?: string;
        ui_lang?: string;
        freshness?: string;
      };

      if (!query || typeof query !== "string" || !query.trim()) {
        return {
          content: [{ type: "text", text: "Error: query parameter is required" }],
          details: { error: "invalid_query" },
          isError: true,
        };
      }

      const normalizedFreshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
      if (rawFreshness && !normalizedFreshness) {
        return {
          content: [
            {
              type: "text",
              text: "Error: freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD",
            },
          ],
          details: { error: "invalid_freshness" },
          isError: true,
        };
      }

      const searchCount = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(count ?? DEFAULT_SEARCH_COUNT)));

      // Stream progress update
      onUpdate?.({
        content: [{ type: "text", text: `Searching for: ${query}...` }],
      });

      try {
        const result = await runBraveSearch({
          query: query.trim(),
          count: searchCount,
          apiKey,
          timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
          country,
          search_lang,
          ui_lang,
          freshness: normalizedFreshness,
        });

        // Format results for LLM
        const results = (result.results as Array<{ title: string; url: string; description: string; siteName?: string }>) ?? [];
        let text = `Found ${results.length} result${results.length !== 1 ? "s" : ""} for "${query}"`;
        if (result.cached) {
          text += " (cached)";
        }
        text += `\n\n`;

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          text += `${i + 1}. ${r.title}\n`;
          text += `   URL: ${r.url}\n`;
          if (r.siteName) {
            text += `   Site: ${r.siteName}\n`;
          }
          if (r.description) {
            text += `   ${r.description}\n`;
          }
          text += `\n`;
        }

        return {
          content: [{ type: "text", text }],
          details: result,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          details: { error: errorMessage },
          isError: true,
        };
      }
    },

    // Optional: Custom rendering
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_search "));
      text += theme.fg("accent", `"${args.query}"`);
      if (args.count) {
        text += theme.fg("muted", ` (${args.count} results)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as Record<string, unknown> | undefined;
      const count = (details?.count as number) ?? 0;
      const cached = details?.cached === true;

      let text = theme.fg("success", `${count} result${count !== 1 ? "s" : ""}`);
      if (cached) {
        text += theme.fg("dim", " (cached)");
      }

      if (expanded && details?.results) {
        const results = details.results as Array<{ title: string; url: string; description?: string }>;
        for (const r of results.slice(0, 5)) {
          text += `\n${theme.fg("accent", r.title)}`;
          text += `\n${theme.fg("dim", r.url)}`;
          if (r.description) {
            text += `\n${theme.fg("muted", r.description)}`;
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });
}

