import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT = 30; // seconds
const MAX_TIMEOUT = 120; // seconds
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ARCHIVE_ORG_ENDPOINT = "https://webcache.googleusercontent.com/search?q=cache:";

// Token estimation: ~0.75 tokens per character on average
const TOKENS_PER_CHAR = 0.75;

// Simple cache
const FETCH_CACHE = new Map<string, { value: unknown; expiresAt: number }>();

// Content selector types
type ContentSelector = "article" | "code" | "links" | "headings" | "full";
type TruncateMode = "paragraph" | "sentence" | "hard";
type ExtractMode = "markdown" | "text";
type FetchMode = "fetch" | "preview" | "archive";

/**
 * Metadata for URL preview.
 */
interface URLMetadata {
  url: string;
  title?: string;
  description?: string;
  contentType?: string;
  contentLength?: number;
  lastModified?: string;
  estimatedReadingTime?: number; // minutes
  hasPaywall?: boolean;
  hasLogin?: boolean;
  isHTML: boolean;
}

/**
 * Paywall indicators in HTML.
 */
const PAYWALL_INDICATORS = [
  /paywall/i,
  /subscribe/i,
  /subscription/i,
  /premium/i,
  /member/i,
  /login.*read/i,
  /signin.*read/i,
  /gate/i,
];

/**
 * Check if HTML indicates a paywall.
 */
function detectPaywall(html: string): boolean {
  const headAndStart = html.slice(0, 10000).toLowerCase();
  return PAYWALL_INDICATORS.some(pattern => pattern.test(headAndStart));
}

/**
 * Extract metadata from HTML.
 */
function extractMetadata(html: string, url: string, headers: Headers): URLMetadata {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : undefined;
  
  // Meta description
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                    html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  const description = descMatch ? descMatch[1] : undefined;
  
  const contentType = headers.get("content-type") || undefined;
  const contentLength = headers.get("content-length") ? 
    Number.parseInt(headers.get("content-length")!, 10) : undefined;
  const lastModified = headers.get("last-modified") || undefined;
  
  const isHTML = contentType?.includes("text/html") ?? false;
  
  // Estimate reading time (avg 200 wpm)
  let estimatedReadingTime: number | undefined;
  if (isHTML && description) {
    const wordCount = description.split(/\s+/).length + (title?.split(/\s+/).length || 0);
    estimatedReadingTime = Math.ceil(wordCount / 200);
  }
  
  return {
    url,
    title,
    description,
    contentType,
    contentLength,
    lastModified,
    estimatedReadingTime,
    hasPaywall: isHTML ? detectPaywall(html) : false,
    hasLogin: isHTML ? /login|signin|auth/i.test(html.slice(0, 5000)) : false,
    isHTML,
  };
}

/**
 * Fetch from archive.org.
 */
async function fetchFromArchive(url: string, signal: AbortSignal): Promise<{ html: string; url: string } | null> {
  try {
    const archiveUrl = `${ARCHIVE_ORG_ENDPOINT}${encodeURIComponent(url)}`;
    const res = await fetch(archiveUrl, {
      method: "GET",
      headers: { "User-Agent": DEFAULT_USER_AGENT },
      signal,
    });
    
    if (!res.ok) return null;
    
    const html = await res.text();
    return { html, url: archiveUrl };
  } catch {
    return null;
  }
}

/**
 * Extract code blocks from HTML content.
 */
function extractCodeBlocks(html: string): string {
  const blocks: string[] = [];
  
  // Match pre/code blocks
  const codeRegex = /<(?:pre|code)[^>]*>([\s\S]*?)<\/(?:pre|code)>/gi;
  let match;
  while ((match = codeRegex.exec(html)) !== null) {
    const code = stripTags(match[1]).trim();
    if (code.length > 10) {
      blocks.push(`\`\`\`\n${code}\n\`\`\``);
    }
  }
  
  return blocks.join("\n\n");
}

/**
 * Extract all links from HTML content.
 */
function extractLinks(html: string, baseUrl: string): string {
  const links: Array<{ text: string; href: string }> = [];
  const seen = new Set<string>();
  
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const text = stripTags(match[2]).trim();
    
    // Resolve relative URLs
    let fullUrl: string;
    try {
      fullUrl = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    
    // Skip anchors, javascript, mailto
    if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
      continue;
    }
    
    const key = `${fullUrl}|${text}`;
    if (!seen.has(key) && text.length > 0 && text.length < 200) {
      seen.add(key);
      links.push({ text, href: fullUrl });
    }
  }
  
  return links.map(l => `- [${l.text}](${l.href})`).join("\n");
}

/**
 * Extract headings/outline from HTML content.
 */
function extractHeadings(html: string): string {
  const headings: Array<{ level: number; text: string }> = [];
  
  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    const level = Number.parseInt(match[1], 10);
    const text = stripTags(match[2]).trim();
    if (text.length > 0) {
      headings.push({ level, text });
    }
  }
  
  if (headings.length === 0) {
    return "No headings found.";
  }
  
  const minLevel = Math.min(...headings.map(h => h.level));
  return headings
    .map(h => `${"  ".repeat(h.level - minLevel)}- ${h.text}`)
    .join("\n");
}

/**
 * Extract article content using Readability or fallback.
 */
async function extractArticle(html: string, url: string, extractMode: ExtractMode): Promise<{ text: string; title?: string }> {
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
  
  const result = htmlToMarkdown(html);
  if (extractMode === "text") {
    return { text: markdownToPlainText(result.text), title: result.title };
  }
  return result;
}

/**
 * Truncate text at semantic boundaries.
 */
function truncateAtBoundary(text: string, maxChars: number, mode: TruncateMode): string {
  if (text.length <= maxChars) {
    return text;
  }
  
  const slice = text.slice(0, maxChars);
  
  switch (mode) {
    case "hard":
      return slice;
      
    case "paragraph": {
      // Find the last paragraph break before maxChars
      const lastPara = slice.lastIndexOf("\n\n");
      if (lastPara > maxChars * 0.5) {
        return slice.slice(0, lastPara);
      }
      // Fall through to sentence if no good paragraph break
    }
    // eslint-disable-next-line no-fallthrough
    case "sentence": {
      // Find sentence endings (.!?) followed by space or newline
      const sentenceEnd = /[.!?](?:\s|$)/g;
      let lastSentenceEnd = -1;
      let match;
      
      while ((match = sentenceEnd.exec(slice)) !== null) {
        lastSentenceEnd = match.index + 1;
      }
      
      if (lastSentenceEnd > maxChars * 0.3) {
        return slice.slice(0, lastSentenceEnd).trim();
      }
      
      // Last resort: word boundary
      const lastSpace = slice.lastIndexOf(" ");
      if (lastSpace > maxChars * 0.8) {
        return slice.slice(0, lastSpace);
      }
      
      return slice;
    }
    
    default:
      return slice;
  }
}

/**
 * Convert markdown to plain text.
 */
function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .trim();
}

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

/**
 * Extract content based on selector type.
 */
async function extractContentBySelector(
  html: string,
  url: string,
  selector: ContentSelector,
  extractMode: ExtractMode
): Promise<{ text: string; title?: string; extractionStats?: Record<string, number> }> {
  const startTime = Date.now();
  
  switch (selector) {
    case "code": {
      const code = extractCodeBlocks(html);
      return {
        text: code || "No code blocks found.",
        extractionStats: { codeBlocks: code.split("```").length / 2, timeMs: Date.now() - startTime }
      };
    }
    
    case "links": {
      const links = extractLinks(html, url);
      const count = links.split("\n").filter(l => l.startsWith("-")).length;
      return {
        text: links || "No links found.",
        extractionStats: { linksFound: count, timeMs: Date.now() - startTime }
      };
    }
    
    case "headings": {
      const headings = extractHeadings(html);
      const count = headings.split("\n").filter(h => h.trim().startsWith("-")).length;
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      return {
        text: headings,
        title: titleMatch ? stripTags(titleMatch[1]).trim() : undefined,
        extractionStats: { headingsFound: count, timeMs: Date.now() - startTime }
      };
    }
    
    case "article": {
      const result = await extractArticle(html, url, extractMode);
      return {
        ...result,
        extractionStats: { charsExtracted: result.text.length, timeMs: Date.now() - startTime }
      };
    }
    
    case "full":
    default: {
      const result = htmlToMarkdown(html);
      const text = extractMode === "text" ? markdownToPlainText(result.text) : result.text;
      return {
        text,
        title: result.title,
        extractionStats: { charsExtracted: text.length, timeMs: Date.now() - startTime }
      };
    }
  }
}

function getCacheKey(url: string, mode: string, extractMode?: string, contentSelector?: string): string {
  return `fetch:${url.toLowerCase()}:${mode}:${extractMode || "markdown"}:${contentSelector || "full"}`;
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
      "Fetch and extract readable content from a URL. Three modes: 'fetch' (full content), 'preview' (metadata only), 'archive' (use archive.org). Supports targeted extraction: article, code, links, headings. Use preview mode to check relevance before full fetch.",
    parameters: Type.Object({
      url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
      mode: Type.Optional(
        Type.Union([
          Type.Literal("fetch", { description: "Full content fetch (default)" }),
          Type.Literal("preview", { description: "Metadata only - title, description, size, paywall check" }),
          Type.Literal("archive", { description: "Use archive.org cached version" }),
        ], {
          description: "Fetch mode. Preview is fast and checks paywalls. Archive bypasses paywalls but may be outdated.",
          default: "fetch",
        })
      ),
      extractMode: Type.Optional(
        Type.Union([
          Type.Literal("markdown"),
          Type.Literal("text"),
        ], {
          description: 'Extraction mode: "markdown" (default) or "text" (plain text).',
          default: "markdown",
        })
      ),
      contentSelector: Type.Optional(
        Type.Union([
          Type.Literal("article", { description: "Extract main article content only (best for docs, articles)" }),
          Type.Literal("code", { description: "Extract code blocks only (best for GitHub, documentation)" }),
          Type.Literal("links", { description: "Extract all links as markdown list" }),
          Type.Literal("headings", { description: "Extract document outline/headings only" }),
          Type.Literal("full", { description: "Full page content (default, most tokens)" }),
        ], {
          description: "What content to extract. Use 'article' for most pages, 'code' for technical docs, 'headings' for overview, 'links' for discovery.",
          default: "article",
        })
      ),
      truncateAt: Type.Optional(
        Type.Union([
          Type.Literal("paragraph", { description: "End at paragraph boundary (cleanest)" }),
          Type.Literal("sentence", { description: "End at sentence boundary" }),
          Type.Literal("hard", { description: "Hard cut at maxChars (may cut words)" }),
        ], {
          description: "How to truncate when content exceeds maxChars. 'paragraph' is cleanest, 'sentence' preserves meaning, 'hard' is exact.",
          default: "paragraph",
        })
      ),
      maxChars: Type.Optional(
        Type.Number({
          description: "Maximum characters to return (truncates when exceeded). Approx ~0.75 tokens/char.",
          minimum: 100,
          default: 50000,
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
      const { 
        url, 
        mode = "fetch",
        extractMode = "markdown", 
        contentSelector = "article",
        truncateAt = "paragraph",
        maxChars = DEFAULT_MAX_CHARS,
        timeout: _timeout,
      } = params as {
        url: string;
        mode?: FetchMode;
        extractMode?: ExtractMode;
        contentSelector?: ContentSelector;
        truncateAt?: TruncateMode;
        maxChars?: number;
        timeout?: number;
      };

      if (!url || typeof url !== "string") {
        return {
          content: [{ type: "text", text: "Error: url parameter is required" }],
          details: { error: "invalid_url", confidence: "high" },
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
          details: { error: "invalid_url", confidence: "high" },
          isError: true,
        };
      }

      const cacheKey = getCacheKey(url, mode, extractMode, contentSelector);
      const cached = readCache(cacheKey);
      if (cached) {
        const cachedResult = cached as Record<string, unknown>;
        return {
          content: [{ type: "text", text: cachedResult.text as string }],
          details: { ...cachedResult, cached: true, expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS).toISOString() },
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `${mode === "preview" ? "Previewing" : mode === "archive" ? "Fetching archive" : "Fetching"} ${url}...` }],
      });

      const timeout = Math.min(MAX_TIMEOUT, Math.max(5, params.timeout ?? DEFAULT_TIMEOUT));
      
      const start = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timeoutId);
          controller.abort();
        });
      }

      try {
        // Handle archive mode
        let targetUrl = url;
        let isArchive = false;
        
        if (mode === "archive") {
          const archiveResult = await fetchFromArchive(url, controller.signal);
          if (!archiveResult) {
            return {
              content: [{ type: "text", text: "Error: No archive available for this URL" }],
              details: { error: "no_archive", url, confidence: "high" },
              isError: true,
            };
          }
          // For archive, we use the returned HTML directly
          const html = archiveResult.html;
          const metadata = extractMetadata(html, url, new Headers());
          
          const result = await extractContentBySelector(html, url, contentSelector, extractMode);
          
          const payload = {
            url,
            finalUrl: archiveResult.url,
            status: 200,
            contentType: "text/html",
            title: result.title || metadata.title,
            extractMode,
            contentSelector,
            mode: "archive",
            metadata: { ...metadata, isArchive: true },
            truncated: false,
            originalLength: result.text.length,
            length: result.text.length,
            fetchedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS * 4).toISOString(), // Archives cache longer
            tookMs: Date.now() - start,
            extractionStats: result.extractionStats,
            text: result.text,
          };

          writeCache(cacheKey, payload, DEFAULT_CACHE_TTL_MS * 4);

          return {
            content: [{ type: "text", text: result.text }],
            details: payload,
          };
        }

        // Regular fetch or preview
        const res = await fetch(targetUrl, {
          method: mode === "preview" ? "HEAD" : "GET",
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
        
        // Preview mode: return metadata only
        if (mode === "preview") {
          // For preview, we need to fetch a small amount of body to extract metadata
          const previewRes = await fetch(targetUrl, {
            method: "GET",
            headers: {
              "User-Agent": DEFAULT_USER_AGENT,
              Accept: "text/html",
              Range: "bytes=0-8192", // Only first 8KB
            },
            signal: controller.signal,
          });
          
          const previewBody = await previewRes.text();
          const metadata = extractMetadata(previewBody, url, res.headers);
          
          const metadataText = [
            `**Title:** ${metadata.title || "N/A"}`,
            `**Description:** ${metadata.description || "N/A"}`,
            `**Content-Type:** ${metadata.contentType || "N/A"}`,
            metadata.contentLength ? `**Size:** ${(metadata.contentLength / 1024).toFixed(1)}KB` : null,
            metadata.estimatedReadingTime ? `**Reading Time:** ~${metadata.estimatedReadingTime} min` : null,
            metadata.lastModified ? `**Last Modified:** ${new Date(metadata.lastModified).toLocaleDateString()}` : null,
            `**Paywall Detected:** ${metadata.hasPaywall ? "Yes ⚠️" : "No ✓"}`,
            `**Login Required:** ${metadata.hasLogin ? "Yes ⚠️" : "No ✓"}`,
            "",
            "Use mode='fetch' to retrieve full content.",
            metadata.hasPaywall ? "Use mode='archive' to try bypassing paywall." : null,
          ].filter(Boolean).join("\n");

          const payload = {
            url,
            finalUrl: res.url,
            status: res.status,
            contentType,
            mode: "preview",
            metadata: {
              ...metadata,
              sourceReliability: assessReliability(url),
            },
            fetchedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS).toISOString(),
            tookMs: Date.now() - start,
            text: metadataText,
          };

          writeCache(cacheKey, payload, DEFAULT_CACHE_TTL_MS);

          return {
            content: [{ type: "text", text: metadataText }],
            details: payload,
          };
        }

        // Full fetch mode
        const body = await res.text();

        let text: string;
        let title: string | undefined;
        let extractor = "raw";
        let extractionStats: Record<string, number> | undefined;
        let metadata: URLMetadata | undefined;

        if (contentType.includes("text/html")) {
          metadata = extractMetadata(body, url, res.headers);
          const extracted = await extractContentBySelector(body, url, contentSelector, extractMode);
          text = extracted.text;
          title = extracted.title;
          extractionStats = extracted.extractionStats;
          extractor = contentSelector === "full" ? "readability" : contentSelector;
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

        // Apply semantic truncation
        const originalLength = text.length;
        const truncatedText = truncateAtBoundary(text, maxChars, truncateAt);
        const truncated = truncatedText.length < originalLength;
        text = truncatedText;

        const payload = {
          url,
          finalUrl: res.url,
          status: res.status,
          contentType,
          title,
          extractMode,
          contentSelector,
          truncateAt,
          extractor,
          metadata: metadata ? {
            ...metadata,
            sourceReliability: assessReliability(url),
          } : undefined,
          truncated,
          originalLength,
          length: text.length,
          fetchedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS).toISOString(),
          tookMs: Date.now() - start,
          extractionStats,
          text,
        };

        writeCache(cacheKey, payload, DEFAULT_CACHE_TTL_MS);

        let resultText = text;
        if (truncated) {
          const savings = ((1 - maxChars / originalLength) * 100).toFixed(0);
          resultText += `\n\n[Content truncated at ${truncateAt} boundary: showing ${text.length} of ${originalLength} characters (${savings}% savings). Use offset parameters or increase maxChars for more.]`;
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
          details: { error: errorMessage, url, confidence: "high" },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_fetch "));
      text += theme.fg("accent", args.url);
      if (args.mode && args.mode !== "fetch") {
        text += theme.fg("muted", ` [${args.mode}]`);
      } else if (args.contentSelector && args.contentSelector !== "full") {
        text += theme.fg("muted", ` [${args.contentSelector}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as Record<string, unknown> | undefined;
      const status = details?.status as number | undefined;
      const title = details?.title as string | undefined;
      const extractor = details?.extractor as string | undefined;
      const cached = details?.cached === true;
      const mode = details?.mode as string | undefined;
      const metadata = details?.metadata as URLMetadata | undefined;
      const truncated = details?.truncated as boolean | undefined;
      const extractionStats = details?.extractionStats as Record<string, number> | undefined;

      let text = theme.fg(status === 200 ? "success" : "warning", `HTTP ${status ?? "?"}`);
      
      if (mode === "preview" && metadata) {
        text += theme.fg("info", " [preview]");
        if (metadata.hasPaywall) {
          text += theme.fg("warning", " 💰");
        }
        if (title) {
          text += ` ${theme.fg("accent", title.slice(0, 30))}${title.length > 30 ? "..." : ""}`;
        }
      } else if (title && metadata?.contentSelector !== "links") {
        text += ` ${theme.fg("accent", title.slice(0, 40))}${title.length > 40 ? "..." : ""}`;
      }
      
      if (extractor && mode !== "preview") {
        text += theme.fg("dim", ` (${extractor})`);
      }
      
      if (extractionStats) {
        const stats = Object.entries(extractionStats)
          .filter(([k]) => k !== "timeMs")
          .map(([k, v]) => `${v} ${k}`)
          .join(", ");
        if (stats) {
          text += theme.fg("dim", ` - ${stats}`);
        }
      }
      
      if (truncated) {
        text += theme.fg("warning", " [truncated]");
      }
      
      if (cached) {
        text += theme.fg("dim", " (cached)");
      }

      if (expanded && metadata?.sourceReliability) {
        const reliability = metadata.sourceReliability;
        if (reliability === "authoritative") {
          text += theme.fg("success", " ★ authoritative");
        } else if (reliability === "community") {
          text += theme.fg("dim", " community");
        }
      }

      return new Text(text, 0, 0);
    },
  });
}

/**
 * Assess source reliability.
 */
function assessReliability(url: string): "authoritative" | "community" | "unknown" {
  try {
    const domain = new URL(url).hostname.toLowerCase();
    
    const authoritativePatterns = [
      /\.(edu|gov|ac\.\w{2})$/,
      /(github\.com|stackoverflow\.com|mozilla\.org|w3\.org|ietf\.org)/,
      /(wikipedia\.org|wikibooks\.org)/,
      /(docs\.|developer\.|api\.)/,
    ];
    
    const communityPatterns = [
      /(medium\.com|dev\.to|hashnode\.com)/,
      /(reddit\.com|news\.ycombinator\.com)/,
    ];
    
    if (authoritativePatterns.some(p => p.test(domain))) {
      return "authoritative";
    }
    
    if (communityPatterns.some(p => p.test(domain))) {
      return "community";
    }
  } catch {
    // Invalid URL
  }
  
  return "unknown";
}
