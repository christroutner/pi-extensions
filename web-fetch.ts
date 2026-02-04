import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Simple cache
const FETCH_CACHE = new Map<string, { value: unknown; expiresAt: number }>();

// Basic HTML to markdown conversion (simplified version)
function htmlToMarkdown(html: string): { text: string; title?: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : undefined;

  // Remove scripts, styles
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Convert links
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = stripTags(body).trim();
    return label ? `[${label}](${href})` : href;
  });

  // Convert headings
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = "#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
    const label = stripTags(body).trim();
    return `\n${prefix} ${label}\n`;
  });

  // Convert lists
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = stripTags(body).trim();
    return label ? `\n- ${label}` : "";
  });

  // Convert line breaks
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer)>/gi, "\n");

  // Strip remaining tags and normalize whitespace
  text = stripTags(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return { text, title };
}

function stripTags(html: string): string {
  return html
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<[^>]+>/g, "");
}

async function extractReadableContent(html: string, url: string, extractMode: "markdown" | "text"): Promise<{ text: string; title?: string }> {
  // Try Mozilla Readability first (if available)
  try {
    const [{ Readability }, { parseHTML }] = await Promise.all([
      import("@mozilla/readability"),
      import("linkedom"),
    ]);
    const { document } = parseHTML(html);
    try {
      (document as { baseURI?: string }).baseURI = url;
    } catch {
      // Ignore
    }
    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (parsed?.content) {
      const title = parsed.title || undefined;
      if (extractMode === "text") {
        const text = (parsed.textContent ?? "").trim();
        return text ? { text, title } : htmlToMarkdown(html);
      }
      const rendered = htmlToMarkdown(parsed.content);
      return { text: rendered.text, title: title ?? rendered.title };
    }
  } catch {
    // Fall back to basic conversion
  }

  // Fallback: basic HTML to markdown
  const result = htmlToMarkdown(html);
  if (extractMode === "text") {
    // Convert markdown to plain text
    let plain = result.text
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .trim();
    return { text: plain, title: result.title };
  }
  return result;
}

function getCacheKey(url: string, extractMode: string): string {
  return `fetch:${url.toLowerCase()}:${extractMode}`;
}

function readCache(key: string): unknown | null {
  const entry = FETCH_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    FETCH_CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key: string, value: unknown, ttlMs: number) {
  if (ttlMs <= 0) return;
  if (FETCH_CACHE.size >= 100) {
    const firstKey = FETCH_CACHE.keys().next().value;
    if (firstKey) FETCH_CACHE.delete(firstKey);
  }
  FETCH_CACHE.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch and extract readable content from a URL (HTML → markdown/text). Extracts main content, removing navigation, ads, and other clutter. Use this to read the actual content of web pages found via web_search.",
    parameters: Type.Object({
      url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
      extractMode: Type.Optional(
        Type.Union([
          Type.Literal("markdown"),
          Type.Literal("text"),
        ], {
          description: 'Extraction mode: "markdown" (default) or "text" (plain text).',
          default: "markdown",
        })
      ),
      maxChars: Type.Optional(
        Type.Number({
          description: "Maximum characters to return (truncates when exceeded).",
          minimum: 100,
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { url, extractMode = "markdown", maxChars = DEFAULT_MAX_CHARS } = params as {
        url: string;
        extractMode?: "markdown" | "text";
        maxChars?: number;
      };

      if (!url || typeof url !== "string") {
        return {
          content: [{ type: "text", text: "Error: url parameter is required" }],
          details: { error: "invalid_url" },
          isError: true,
        };
      }

      // Validate URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          throw new Error("Only HTTP and HTTPS URLs are supported");
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: Invalid URL: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: "invalid_url" },
          isError: true,
        };
      }

      const cacheKey = getCacheKey(url, extractMode);
      const cached = readCache(cacheKey);
      if (cached) {
        const cachedResult = cached as Record<string, unknown>;
        return {
          content: [{ type: "text", text: cachedResult.text as string }],
          details: { ...cachedResult, cached: true },
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${url}...` }],
      });

      const start = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_SECONDS * 1000);

      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timeoutId);
          controller.abort();
        });
      }

      try {
        const res = await fetch(url, {
          method: "GET",
          headers: {
            "User-Agent": DEFAULT_USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const contentType = res.headers.get("content-type") || "";
        const body = await res.text();

        let text: string;
        let title: string | undefined;
        let extractor = "raw";

        if (contentType.includes("text/html")) {
          const extracted = await extractReadableContent(body, url, extractMode);
          text = extracted.text;
          title = extracted.title;
          extractor = "readability";
        } else if (contentType.includes("application/json")) {
          try {
            text = JSON.stringify(JSON.parse(body), null, 2);
            extractor = "json";
          } catch {
            text = body;
            extractor = "raw";
          }
        } else {
          text = body;
          extractor = "raw";
        }

        // Truncate if needed
        const truncated = text.length > maxChars;
        if (truncated) {
          text = text.slice(0, maxChars);
        }

        const payload = {
          url,
          finalUrl: res.url,
          status: res.status,
          contentType,
          title,
          extractMode,
          extractor,
          truncated,
          length: text.length,
          fetchedAt: new Date().toISOString(),
          tookMs: Date.now() - start,
          text,
        };

        writeCache(cacheKey, payload, DEFAULT_CACHE_TTL_MS);

        let resultText = text;
        if (truncated) {
          resultText += `\n\n[Content truncated: showing first ${maxChars} characters of ${text.length + (text.length - maxChars)} total]`;
        }

        return {
          content: [{ type: "text", text: resultText }],
          details: payload,
        };
      } catch (err) {
        clearTimeout(timeoutId);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error fetching ${url}: ${errorMessage}` }],
          details: { error: errorMessage, url },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_fetch "));
      text += theme.fg("accent", args.url);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as Record<string, unknown> | undefined;
      const status = details?.status as number | undefined;
      const title = details?.title as string | undefined;
      const extractor = details?.extractor as string | undefined;
      const cached = details?.cached === true;

      let text = theme.fg(status === 200 ? "success" : "warning", `HTTP ${status ?? "?"}`);
      if (title) {
        text += ` ${theme.fg("accent", title)}`;
      }
      if (extractor) {
        text += theme.fg("dim", ` (${extractor})`);
      }
      if (cached) {
        text += theme.fg("dim", " (cached)");
      }

      return new Text(text, 0, 0);
    },
  });
}

