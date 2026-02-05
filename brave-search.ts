import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_TIMEOUT = 30; // seconds
const MAX_TIMEOUT = 120; // seconds
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Token estimation: ~0.75 tokens per character on average
const TOKENS_PER_CHAR = 0.75;

// Simple in-memory cache
const SEARCH_CACHE = new Map<string, { value: unknown; expiresAt: number }>();

// Brave freshness shortcuts
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

type SummaryStyle = "brief" | "snippet" | "detailed";

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  meta?: {
    domain?: string;
  };
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

function extractDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const hostname = new URL(url).hostname;
    // Remove www. prefix for grouping
    return hostname.replace(/^www\./, "");
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

/**
 * Filter results by regex pattern.
 */
function filterByPattern(results: BraveSearchResult[], pattern: string | undefined): BraveSearchResult[] {
  if (!pattern) return results;
  
  try {
    const regex = new RegExp(pattern, "i");
    return results.filter(r => 
      regex.test(r.title || "") || 
      regex.test(r.description || "") ||
      regex.test(r.url || "")
    );
  } catch {
    // Invalid regex, return all
    return results;
  }
}

/**
 * Ensure domain diversity in results.
 */
function diversifySources(results: BraveSearchResult[], maxPerDomain: number = 2): BraveSearchResult[] {
  const domainCounts = new Map<string, number>();
  const diversified: BraveSearchResult[] = [];
  
  for (const result of results) {
    const domain = extractDomain(result.url);
    if (!domain) {
      diversified.push(result);
      continue;
    }
    
    const count = domainCounts.get(domain) || 0;
    if (count < maxPerDomain) {
      domainCounts.set(domain, count + 1);
      diversified.push(result);
    }
  }
  
  return diversified;
}

/**
 * Assess source reliability based on domain patterns.
 */
function assessReliability(url: string | undefined): "authoritative" | "community" | "unknown" {
  if (!url) return "unknown";
  
  const domain = extractDomain(url)?.toLowerCase() || "";
  
  // Authoritative domains
  const authoritativePatterns = [
    /\.(edu|gov|ac\.\w{2})$/,
    /^(docs\.|developer\.|api\.)?/,
    /(github\.com|stackoverflow\.com|mozilla\.org|w3\.org|ietf\.org)/,
    /(wikipedia\.org|wikibooks\.org)/,
  ];
  
  // Community domains (may vary in quality)
  const communityPatterns = [
    /(medium\.com|dev\.to|hashnode\.com)/,
    /(reddit\.com|news\.ycombinator\.com)/,
    /(blog|wordpress|substack)\./,
  ];
  
  if (authoritativePatterns.some(p => p.test(domain))) {
    return "authoritative";
  }
  
  if (communityPatterns.some(p => p.test(domain))) {
    return "community";
  }
  
  return "unknown";
}

/**
 * Format results based on summary style.
 */
function formatResults(
  results: Array<{ title: string; url: string; description: string; siteName?: string; reliability?: string }>,
  style: SummaryStyle,
  query: string
): string {
  const truncated = results.length < (results as unknown[]).length;
  
  let text = `Found ${results.length} result${results.length !== 1 ? "s" : ""} for "${query}"`;
  if (truncated) {
    text += " (some filtered by criteria)";
  }
  text += "\n\n";

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    
    switch (style) {
      case "brief":
        // Title + URL only (~10-20 tokens per result)
        text += `${i + 1}. [${r.title}](${r.url})\n`;
        break;
        
      case "snippet":
        // Title + 1-line description (~30-50 tokens per result)
        text += `${i + 1}. **${r.title}**\n`;
        text += `   ${r.url}\n`;
        if (r.description) {
          const snippet = r.description.slice(0, 120);
          text += `   ${snippet}${r.description.length > 120 ? "..." : ""}\n`;
        }
        text += "\n";
        break;
        
      case "detailed":
      default:
        // Full details (~100+ tokens per result)
        text += `${i + 1}. ${r.title}\n`;
        text += `   URL: ${r.url}\n`;
        if (r.siteName) {
          text += `   Site: ${r.siteName}`;
          if (r.reliability && r.reliability !== "unknown") {
            text += ` [${r.reliability}]`;
          }
          text += "\n";
        }
        if (r.description) {
          text += `   ${r.description}\n`;
        }
        text += "\n";
        break;
    }
  }

  return text.trim();
}

async function runBraveSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeout: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  requirePattern?: string;
  diverseSources?: boolean;
  summaryStyle?: SummaryStyle;
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
  const timeoutId = setTimeout(() => controller.abort(), params.timeout * 1000);

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
    let results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
    
    // Apply pattern filter
    if (params.requirePattern) {
      results = filterByPattern(results, params.requirePattern);
    }
    
    // Apply diversity filter
    if (params.diverseSources) {
      results = diversifySources(results, 2);
    }
    
    // Map and enrich results
    const mapped = results.slice(0, params.count).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      description: entry.description ?? "",
      published: entry.age ?? undefined,
      siteName: resolveSiteName(entry.url ?? ""),
      reliability: assessReliability(entry.url ?? ""),
    }));

    const payload = {
      query: params.query,
      provider: "brave",
      count: mapped.length,
      tookMs: Date.now() - start,
      results: mapped,
      filters: {
        pattern: params.requirePattern,
        diverse: params.diverseSources,
        style: params.summaryStyle,
      },
    };

    writeCache(cacheKey, payload, DEFAULT_CACHE_TTL_MS);
    return payload;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${params.timeout} seconds`);
    }
    throw err;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Brave Search API. Supports result prioritization, domain diversity, and flexible summary styles to control token usage. Use 'brief' style for discovery, 'snippet' for quick scanning, 'detailed' for deep research.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query string." }),
      count: Type.Optional(
        Type.Number({
          description: "Number of results to return (1-10).",
          minimum: 1,
          maximum: MAX_SEARCH_COUNT,
          default: DEFAULT_SEARCH_COUNT,
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
      summaryStyle: Type.Optional(
        Type.Union([
          Type.Literal("brief", { 
            description: "Title + URL only (~10 tokens/result). Best for link discovery." 
          }),
          Type.Literal("snippet", { 
            description: "Title + 1-line description (~30 tokens/result). Best for quick scanning." 
          }),
          Type.Literal("detailed", { 
            description: "Full details with descriptions (~100 tokens/result). Best for deep research." 
          }),
        ], {
          description: "How much detail to include per result. Controls token usage.",
          default: "snippet",
        })
      ),
      requirePattern: Type.Optional(
        Type.String({
          description: "Regex pattern that results must match (title, URL, or description).",
        })
      ),
      diverseSources: Type.Optional(
        Type.Boolean({
          description: "Ensure results come from diverse domains (max 2 per domain). Reduces bias.",
          default: true,
        })
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Request timeout in seconds (5-120).",
          minimum: 5,
          maximum: MAX_TIMEOUT,
          default: DEFAULT_TIMEOUT,
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

      const { 
        query, 
        count, 
        country, 
        search_lang, 
        ui_lang, 
        freshness: rawFreshness,
        summaryStyle = "snippet",
        requirePattern,
        diverseSources = true,
      } = params as {
        query: string;
        count?: number;
        country?: string;
        search_lang?: string;
        ui_lang?: string;
        freshness?: string;
        summaryStyle?: SummaryStyle;
        requirePattern?: string;
        diverseSources?: boolean;
        timeout?: number;
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
      const timeout = Math.min(MAX_TIMEOUT, Math.max(5, (params as { timeout?: number }).timeout ?? DEFAULT_TIMEOUT));

      // Stream progress update
      onUpdate?.({
        content: [{ type: "text", text: `Searching for: ${query} (${summaryStyle} style)...` }],
      });

      try {
        const result = await runBraveSearch({
          query: query.trim(),
          count: searchCount,
          apiKey,
          timeout,
          country,
          search_lang,
          ui_lang,
          freshness: normalizedFreshness,
          requirePattern,
          diverseSources,
          summaryStyle,
        });

        // Format results for LLM based on style
        const results = (result.results as Array<{ 
          title: string; 
          url: string; 
          description: string; 
          siteName?: string;
          reliability?: string;
        }>) ?? [];
        
        const text = formatResults(results, summaryStyle, query);
        
        // Calculate token estimates (0.75 tokens/char is average)
        const textLength = text.length;
        const estimatedTokens = Math.round(textLength * TOKENS_PER_CHAR);

        return {
          content: [{ type: "text", text }],
          details: { 
            ...result, 
            estimatedTokens,
            tokenSavings: summaryStyle === "detailed" ? 0 : summaryStyle === "snippet" ? 67 : 87,
          },
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
      if (args.summaryStyle && args.summaryStyle !== "snippet") {
        text += theme.fg("muted", ` [${args.summaryStyle}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as Record<string, unknown> | undefined;
      const count = (details?.count as number) ?? 0;
      const cached = details?.cached === true;
      const estimatedTokens = details?.estimatedTokens as number | undefined;
      const filters = details?.filters as Record<string, unknown> | undefined;

      let text = theme.fg("success", `${count} result${count !== 1 ? "s" : ""}`);
      
      if (estimatedTokens) {
        text += theme.fg("dim", ` ~${estimatedTokens}tk`);
      }
      
      if (filters?.diverse) {
        text += theme.fg("dim", " [diverse]");
      }
      
      if (cached) {
        text += theme.fg("dim", " (cached)");
      }

      if (expanded && details?.results) {
        const results = details.results as Array<{ title: string; url: string; description?: string; reliability?: string }>;
        for (const r of results.slice(0, 5)) {
          text += `\n${theme.fg("accent", r.title)}`;
          text += `\n${theme.fg("dim", r.url)}`;
          if (r.reliability === "authoritative") {
            text += theme.fg("success", " ★");
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
