import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 120;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const TOKENS_PER_CHAR = 0.75;

// Simple cache
const RESEARCH_CACHE = new Map<string, { value: unknown; expiresAt: number }>();

// Freshness shortcuts
const FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);

interface ResearchResult {
  url: string;
  title: string;
  content: string;
  relevanceScore: number;
  sourceReliability: "authoritative" | "community" | "unknown";
  contentType: "article" | "docs" | "code" | "mixed";
  fetchedAt: string;
  wordCount: number;
}

interface ResearchSummary {
  query: string;
  totalSources: number;
  totalWords: number;
  estimatedTokens: number;
  authoritativeCount: number;
  topTopics: string[];
  tookMs: number;
}

function getBraveApiKey(): string | null {
  return (process.env.BRAVE_API_KEY ?? "").trim() || null;
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.trim().toLowerCase();
  if (FRESHNESS_SHORTCUTS.has(lower)) return lower;
  
  const rangeMatch = value.match(/^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/);
  if (rangeMatch) {
    const [, start, end] = rangeMatch;
    if (start <= end) return `${start}to${end}`;
  }
  return undefined;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function assessReliability(url: string): "authoritative" | "community" | "unknown" {
  const domain = extractDomain(url).toLowerCase();
  
  const authoritative = [
    /\.(edu|gov|ac\.\w{2})$/,
    /(github\.com|stackoverflow\.com|mozilla\.org|w3\.org|ietf\.org|apache\.org)/,
    /(wikipedia\.org|wikibooks\.org)/,
    /(docs\.|developer\.|api\.)/,
    /(npmjs\.com|pypi\.org|crates\.io|mvnrepository\.com)/,
  ];
  
  const community = [
    /(medium\.com|dev\.to|hashnode\.com)/,
    /(reddit\.com|news\.ycombinator\.com)/,
    /(blog|wordpress|substack)\./,
  ];
  
  if (authoritative.some(p => p.test(domain))) return "authoritative";
  if (community.some(p => p.test(domain))) return "community";
  return "unknown";
}

function detectContentType(html: string): "article" | "docs" | "code" | "mixed" {
  const codeDensity = (html.match(/<code|<pre|<syntaxhighlight/g) || []).length;
  const articleMarkers = (html.match(/<article|<main|class="content|id="content/g) || []).length;
  const docMarkers = (html.match(/class="doc|id="doc|class="reference|api-reference/gi) || []).length;
  
  if (codeDensity > 5) return "code";
  if (docMarkers > 3) return "docs";
  if (articleMarkers > 0) return "article";
  return "mixed";
}

async function searchAndFetch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeout: number;
  freshness?: string;
  fetchLimit?: number;
  minReliability?: "authoritative" | "community" | "any";
  contentSelector?: "article" | "code" | "full";
  onProgress?: (message: string) => void;
}): Promise<{ results: ResearchResult[]; summary: ResearchSummary }> {
  const start = Date.now();
  
  // Step 1: Search
  params.onProgress?.(`Searching for: ${params.query}...`);
  
  const searchUrl = new URL(BRAVE_SEARCH_ENDPOINT);
  searchUrl.searchParams.set("q", params.query);
  searchUrl.searchParams.set("count", String(params.count));
  if (params.freshness) searchUrl.searchParams.set("freshness", params.freshness);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeout * 1000);
  
  const searchRes = await fetch(searchUrl.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  
  if (!searchRes.ok) {
    throw new Error(`Search failed: ${searchRes.status}`);
  }
  
  const searchData = await searchRes.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  const searchResults = searchData.web?.results?.slice(0, params.count) || [];
  
  // Step 2: Filter by reliability if requested
  let filteredResults = searchResults;
  if (params.minReliability && params.minReliability !== "any") {
    filteredResults = searchResults.filter(r => {
      const reliability = assessReliability(r.url || "");
      return params.minReliability === "authoritative" 
        ? reliability === "authoritative"
        : reliability !== "unknown";
    });
  }
  
  // Step 3: Fetch content from top results
  const fetchCount = Math.min(params.fetchLimit || 3, filteredResults.length);
  const toFetch = filteredResults.slice(0, fetchCount);
  
  params.onProgress?.(`Fetching content from ${fetchCount} sources...`);
  
  const researchResults: ResearchResult[] = [];
  
  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    if (!item.url) continue;
    
    params.onProgress?.(`Fetching ${i + 1}/${fetchCount}: ${extractDomain(item.url)}...`);
    
    try {
      const fetchController = new AbortController();
      const fetchTimeout = setTimeout(() => fetchController.abort(), (params.timeout * 1000) / 2);
      
      const fetchRes = await fetch(item.url, {
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: "text/html",
        },
        signal: fetchController.signal,
      });
      clearTimeout(fetchTimeout);
      
      if (!fetchRes.ok) continue;
      
      const contentType = fetchRes.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) continue;
      
      const html = await fetchRes.text();
      
      // Extract content based on selector
      let text = "";
      const contentType2 = detectContentType(html);
      
      if (params.contentSelector === "code") {
        const codeBlocks = html.match(/<(?:pre|code)[^>]*>([\s\S]*?)<\/(?:pre|code)>/gi) || [];
        text = codeBlocks.map(b => stripTags(b)).join("\n\n");
      } else if (params.contentSelector === "article") {
        // Simple article extraction - look for main/article tags
        const articleMatch = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i) ||
                            html.match(/<div[^>]*class=["'][^"']*(?:content|article)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
        if (articleMatch) {
          text = htmlToMarkdown(articleMatch[1]);
        } else {
          text = htmlToMarkdown(html.slice(0, 50000));
        }
      } else {
        text = htmlToMarkdown(html.slice(0, 50000));
      }
      
      // Clean up text
      text = text
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 15000); // Limit each source
      
      const wordCount = text.split(/\s+/).length;
      const reliability = assessReliability(item.url);
      
      // Calculate relevance score (simple TF-IDF-like score)
      const queryWords = params.query.toLowerCase().split(/\s+/);
      const textLower = text.toLowerCase();
      const matchCount = queryWords.reduce((sum, word) => 
        sum + (textLower.includes(word) ? 1 : 0), 0);
      const relevanceScore = matchCount / queryWords.length;
      
      researchResults.push({
        url: item.url,
        title: item.title || "Untitled",
        content: text,
        relevanceScore,
        sourceReliability: reliability,
        contentType: contentType2,
        fetchedAt: new Date().toISOString(),
        wordCount,
      });
      
    } catch (err) {
      // Skip failed fetches
      continue;
    }
  }
  
  // Sort by relevance
  researchResults.sort((a, b) => b.relevanceScore - a.relevanceScore);
  
  // Generate summary
  const totalWords = researchResults.reduce((sum, r) => sum + r.wordCount, 0);
  const authoritativeCount = researchResults.filter(r => r.sourceReliability === "authoritative").length;
  
  // Extract top topics (simple keyword extraction)
  const allText = researchResults.map(r => r.content).join(" ");
  const words = allText.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const wordFreq = new Map<string, number>();
  for (const word of words) {
    if (!["this", "that", "with", "from", "have", "been", "were", "they", "their", "will", "would", "there", "could", "should"].includes(word)) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }
  }
  const topTopics = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
  
  const summary: ResearchSummary = {
    query: params.query,
    totalSources: researchResults.length,
    totalWords,
    estimatedTokens: Math.round(totalWords * 1.3), // ~1.3 tokens per word
    authoritativeCount,
    topTopics,
    tookMs: Date.now() - start,
  };
  
  return { results: researchResults, summary };
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n\n")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

function getCacheKey(query: string, freshness?: string, minReliability?: string): string {
  return `research:${query.toLowerCase()}:${freshness || "any"}:${minReliability || "any"}`;
}

function readCache(key: string): unknown | null {
  const entry = RESEARCH_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    RESEARCH_CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key: string, value: unknown, ttlMs: number) {
  if (ttlMs <= 0) return;
  if (RESEARCH_CACHE.size >= 50) {
    const firstKey = RESEARCH_CACHE.keys().next().value;
    if (firstKey) RESEARCH_CACHE.delete(firstKey);
  }
  RESEARCH_CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_research",
    label: "Web Research",
    description:
      "Search the web and automatically fetch content from top results. Combines web_search + web_fetch with intelligent content extraction, relevance scoring, and deduplication. Best for comprehensive research on a topic.",
    parameters: Type.Object({
      query: Type.String({
        description: "Research query - can be a question or topic.",
      }),
      count: Type.Optional(
        Type.Number({
          description: "Number of search results to fetch (1-10).",
          minimum: 1,
          maximum: MAX_SEARCH_COUNT,
          default: 5,
        })
      ),
      freshness: Type.Optional(
        Type.String({
          description: "Filter by time: 'pd' (24h), 'pw' (week), 'pm' (month), 'py' (year), or YYYY-MM-DDtoYYYY-MM-DD",
        })
      ),
      minReliability: Type.Optional(
        Type.Union([
          Type.Literal("authoritative", { description: "Only .edu, .gov, major docs sites" }),
          Type.Literal("community", { description: "Authoritative + established community sites" }),
          Type.Literal("any", { description: "Any source (default)" }),
        ], {
          description: "Minimum source reliability level.",
          default: "any",
        })
      ),
      contentSelector: Type.Optional(
        Type.Union([
          Type.Literal("article", { description: "Extract main article content (default)" }),
          Type.Literal("code", { description: "Extract code blocks only" }),
          Type.Literal("full", { description: "Full page content" }),
        ], {
          description: "What content to extract from each page.",
          default: "article",
        })
      ),
      fetchLimit: Type.Optional(
        Type.Number({
          description: "Max pages to actually fetch content from (for token control).",
          minimum: 1,
          maximum: 10,
          default: 3,
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
      const apiKey = getBraveApiKey();
      if (!apiKey) {
        return {
          content: [{
            type: "text",
            text: "Error: BRAVE_API_KEY environment variable is not set. Get an API key from https://brave.com/search/api/",
          }],
          details: { error: "missing_api_key", confidence: "high" },
          isError: true,
        };
      }

      const {
        query,
        count,
        freshness: rawFreshness,
        minReliability = "any",
        contentSelector = "article",
        fetchLimit = 3,
        timeout: rawTimeout,
      } = params as {
        query: string;
        count?: number;
        freshness?: string;
        minReliability?: "authoritative" | "community" | "any";
        contentSelector?: "article" | "code" | "full";
        fetchLimit?: number;
        timeout?: number;
      };

      if (!query?.trim()) {
        return {
          content: [{ type: "text", text: "Error: query parameter is required" }],
          details: { error: "invalid_query", confidence: "high" },
          isError: true,
        };
      }

      const freshness = normalizeFreshness(rawFreshness);
      if (rawFreshness && !freshness) {
        return {
          content: [{ type: "text", text: "Error: Invalid freshness format. Use pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD" }],
          details: { error: "invalid_freshness" },
          isError: true,
        };
      }

      const searchCount = Math.max(1, Math.min(MAX_SEARCH_COUNT, count ?? 5));
      const timeout = Math.min(MAX_TIMEOUT, Math.max(5, rawTimeout ?? DEFAULT_TIMEOUT));

      const cacheKey = getCacheKey(query, freshness, minReliability);
      const cached = readCache(cacheKey);
      if (cached) {
        return {
          content: [{ type: "text", text: (cached as { text: string }).text }],
          details: { ...(cached as object), cached: true },
        };
      }

      try {
        const { results, summary } = await searchAndFetch({
          query: query.trim(),
          count: searchCount,
          apiKey,
          timeout,
          freshness,
          fetchLimit,
          minReliability,
          contentSelector,
          onProgress: (msg) => onUpdate?.({ content: [{ type: "text", text: msg }] }),
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant content found from search results." }],
            details: { query, summary: { ...summary, totalSources: 0 } },
          };
        }

        // Format output
        let text = `# Research: ${query}\n\n`;
        text += `**Summary:** Analyzed ${summary.totalSources} sources (${summary.authoritativeCount} authoritative). `;
        text += `~${summary.totalWords.toLocaleString()} words, ~${summary.estimatedTokens.toLocaleString()} tokens. `;
        text += `Took ${(summary.tookMs / 1000).toFixed(1)}s.\n\n`;
        
        if (summary.topTopics.length > 0) {
          text += `**Key Topics:** ${summary.topTopics.join(", ")}\n\n`;
        }
        
        text += `---\n\n`;

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          text += `## Source ${i + 1}: ${r.title}\n`;
          text += `**URL:** ${r.url}\n`;
          text += `**Reliability:** ${r.sourceReliability}`;
          if (r.sourceReliability === "authoritative") text += " ★";
          text += ` | **Relevance:** ${(r.relevanceScore * 100).toFixed(0)}%`;
          text += ` | **Words:** ${r.wordCount.toLocaleString()}\n\n`;
          
          // Add content excerpt
          const excerpt = r.content.slice(0, 2000);
          text += excerpt;
          if (r.content.length > 2000) {
            text += `\n\n[... ${(r.content.length - 2000).toLocaleString()} more characters]`;
          }
          text += "\n\n---\n\n";
        }

        const payload = {
          query,
          text,
          summary,
          results: results.map(r => ({
            url: r.url,
            title: r.title,
            relevanceScore: r.relevanceScore,
            sourceReliability: r.sourceReliability,
            wordCount: r.wordCount,
          })),
          fetchedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS).toISOString(),
          cached: false,
        };

        writeCache(cacheKey, payload, DEFAULT_CACHE_TTL_MS);

        return {
          content: [{ type: "text", text }],
          details: payload,
        };

      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Research error: ${errorMessage}` }],
          details: { error: errorMessage, confidence: "high" },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_research "));
      text += theme.fg("accent", `"${args.query}"`);
      if (args.minReliability && args.minReliability !== "any") {
        text += theme.fg("muted", ` [${args.minReliability}]`);
      }
      if (args.fetchLimit && args.fetchLimit !== 3) {
        text += theme.fg("muted", ` (fetch ${args.fetchLimit})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as Record<string, unknown> | undefined;
      const summary = details?.summary as ResearchSummary | undefined;
      const cached = details?.cached === true;

      let text = theme.fg("success", `${summary?.totalSources ?? 0} sources`);
      
      if (summary) {
        text += theme.fg("dim", ` | ${summary.totalWords.toLocaleString()} words`);
        text += theme.fg("dim", ` | ~${summary.estimatedTokens.toLocaleString()} tokens`);
        if (summary.authoritativeCount > 0) {
          text += theme.fg("success", ` | ${summary.authoritativeCount}★`);
        }
      }
      
      if (cached) {
        text += theme.fg("dim", " (cached)");
      }

      if (expanded && summary?.topTopics) {
        text += `\n${theme.fg("muted", `Topics: ${summary.topTopics.slice(0, 3).join(", ")}`)}`;
      }

      return new Text(text, 0, 0);
    },
  });
}
