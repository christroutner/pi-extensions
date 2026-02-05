import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { completeSimple } from "@mariozechner/pi-ai";

const DEFAULT_LIGHTRAG_URL = "http://192.168.0.173:9621";
const DEFAULT_CHUNK_COUNT = 30;
const DEFAULT_TIMEOUT = 30; // seconds
const MAX_TIMEOUT = 120; // seconds
const MAX_CHUNK_COUNT = 100;

// Chunk size presets in characters
const CHUNK_SIZES = {
  small: 500,   // ~100 tokens - facts, quotes
  medium: 1500, // ~300 tokens - paragraphs (default)
  large: 4000,  // ~800 tokens - full context
};

// Time range filters in milliseconds
const TIME_RANGES = {
  recent: 7 * 24 * 60 * 60 * 1000,      // 7 days
  month: 30 * 24 * 60 * 60 * 1000,      // 30 days
  year: 365 * 24 * 60 * 60 * 1000,      // 365 days
};

// Query tracking for feedback loop
const QUERY_HISTORY = new Map<string, {
  query: string;
  timestamp: number;
  chunks: string[];
  originalContext: string;
}>();

// LightRAG response types
type LightRAGUploadResponse = {
  status: string;
  track_id?: string;
  message?: string;
};

type LightRAGChunk = {
  content: string;
  file_path?: string;
  created_at?: string;
  score?: number;
};

type LightRAGQueryResponse = {
  status: string;
  data?: {
    chunks: LightRAGChunk[];
  };
};

// Tool details types
type RememberDetails = {
  trackId?: string;
  source?: string;
  contentLength: number;
  chunkSize: string;
  estimatedChunks: number;
  tookMs: number;
};

type RecallDetails = {
  originalContext: string;
  optimizedQuery: string;
  chunkCount: number;
  filteredCount?: number;
  timeRange?: string;
  sources?: string[];
  tookMs: number;
  queryId?: string;
};

type RecallFeedback = "more_like" | "less_like" | "too_broad" | "too_narrow";

function getLightRAGUrl(): string {
  return (process.env.LIGHTRAG_URL ?? "").trim() || DEFAULT_LIGHTRAG_URL;
}

/**
 * Detect content structure and suggest chunk size.
 */
function detectContentStructure(content: string): "small" | "medium" | "large" {
  const lines = content.split("\n");
  const avgLineLength = content.length / lines.length;
  
  // Code-heavy content tends to have short lines
  const codeIndicators = /```|[{};]|function\s+\w+|class\s+\w+|def\s+\w+/g;
  const codeMatches = content.match(codeIndicators);
  const codeDensity = codeMatches ? codeMatches.length / lines.length : 0;
  
  if (codeDensity > 0.3 || avgLineLength < 50) {
    return "small"; // Code, logs, structured data
  }
  
  if (avgLineLength > 200 && content.length > 5000) {
    return "large"; // Narrative, documentation
  }
  
  return "medium"; // Default
}

/**
 * Chunk content based on size preference.
 */
function chunkContent(content: string, chunkSize: keyof typeof CHUNK_SIZES | "auto"): string[] {
  const size = chunkSize === "auto" 
    ? CHUNK_SIZES[detectContentStructure(content)]
    : CHUNK_SIZES[chunkSize];
  
  if (content.length <= size) {
    return [content];
  }
  
  const chunks: string[] = [];
  const paragraphs = content.split(/\n\n+/);
  let currentChunk = "";
  
  for (const para of paragraphs) {
    if ((currentChunk + para).length > size && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = para;
    } else {
      currentChunk += "\n\n" + para;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

/**
 * Upload content to LightRAG for storage.
 */
async function uploadToLightRAG(params: {
  content: string;
  source?: string;
  chunkSize: string;
  timeout: number;
}): Promise<{ trackId?: string; tookMs: number; chunks: number }> {
  const start = Date.now();
  const lightragUrl = getLightRAGUrl();
  const url = `${lightragUrl}/documents/text`;
  
  // Chunk the content
  const chunks = chunkContent(params.content, params.chunkSize as keyof typeof CHUNK_SIZES);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeout * 1000);

  try {
    // Upload each chunk
    const uploadPromises = chunks.map(async (chunk, index) => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          text: chunk,
          file_source: params.source 
            ? `${params.source}#chunk-${index + 1}` 
            : `memory-extension#chunk-${index + 1}`,
        }),
        signal: controller.signal,
      });
      
      if (!res.ok) {
        throw new Error(`Upload failed: ${res.status}`);
      }
      
      return res.json() as Promise<LightRAGUploadResponse>;
    });
    
    const results = await Promise.all(uploadPromises);
    const trackId = results[0]?.track_id;

    return {
      trackId,
      tookMs: Date.now() - start,
      chunks: chunks.length,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${params.timeout} seconds`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Query LightRAG for relevant chunks.
 */
async function queryLightRAG(params: {
  query: string;
  chunkCount: number;
  timeout: number;
  timeRange?: string;
  sources?: string[];
}): Promise<{ chunks: LightRAGChunk[]; tookMs: number }> {
  const start = Date.now();
  const lightragUrl = getLightRAGUrl();
  const url = `${lightragUrl}/query/data`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeout * 1000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: params.query,
        mode: "mix",
        chunk_top_k: params.chunkCount * 2, // Request more for filtering
        ...(params.timeRange && { time_range: params.timeRange }),
        ...(params.sources && { sources: params.sources }),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`LightRAG API error (${res.status}): ${detail || res.statusText}`);
    }

    const data = (await res.json()) as LightRAGQueryResponse;

    if (data.status !== "success") {
      throw new Error("LightRAG query failed");
    }

    return {
      chunks: data.data?.chunks ?? [],
      tookMs: Date.now() - start,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${params.timeout} seconds`);
    }
    throw err;
  }
}

/**
 * Filter chunks by relevance score.
 */
function filterByRelevance(chunks: LightRAGChunk[], minScore: number): LightRAGChunk[] {
  // LightRAG doesn't return scores in the response, so we skip filtering if scores are missing
  // If score is present, use it; otherwise treat as 1.0 (passed from backend as relevant)
  return chunks.filter(chunk => {
    const score = chunk.score;
    if (score === undefined || score === null) {
      return true; // Keep chunks without scores (LightRAG already filtered them)
    }
    return score >= minScore;
  });
}

/**
 * Remove semantically similar chunks (simple deduplication based on content similarity).
 */
function deduplicateChunks(chunks: LightRAGChunk[], similarityThreshold: number = 0.8): LightRAGChunk[] {
  const unique: LightRAGChunk[] = [];
  
  for (const chunk of chunks) {
    let isDuplicate = false;
    const chunkWords = new Set(chunk.content.toLowerCase().split(/\s+/));
    
    for (const existing of unique) {
      const existingWords = new Set(existing.content.toLowerCase().split(/\s+/));
      const intersection = new Set([...chunkWords].filter(x => existingWords.has(x)));
      const union = new Set([...chunkWords, ...existingWords]);
      const similarity = intersection.size / union.size;
      
      if (similarity >= similarityThreshold) {
        isDuplicate = true;
        break;
      }
    }
    
    if (!isDuplicate) {
      unique.push(chunk);
    }
  }
  
  return unique;
}

/**
 * Filter chunks by time range.
 */
function filterByTimeRange(chunks: LightRAGChunk[], range: keyof typeof TIME_RANGES): LightRAGChunk[] {
  const cutoff = Date.now() - TIME_RANGES[range];
  return chunks.filter(chunk => {
    if (!chunk.created_at) return true;
    const chunkTime = new Date(chunk.created_at).getTime();
    return chunkTime >= cutoff;
  });
}

/**
 * Filter chunks by source.
 */
function filterBySource(chunks: LightRAGChunk[], sources: string[]): LightRAGChunk[] {
  const sourcePatterns = sources.map(s => new RegExp(s, "i"));
  return chunks.filter(chunk => 
    sourcePatterns.some(pattern => 
      pattern.test(chunk.file_path || "")
    )
  );
}

/**
 * Generate an optimized search query using the current LLM model.
 */
async function generateSearchQuery(context: string, ctx: ExtensionContext, feedback?: { previousQueryId: string; feedback: RecallFeedback }): Promise<string> {
  let baseContext = context;
  
  // Apply feedback-based refinement
  if (feedback) {
    const previous = QUERY_HISTORY.get(feedback.previousQueryId);
    if (previous) {
      switch (feedback.feedback) {
        case "more_like":
          baseContext = `${context}\n\nFocus on content similar to: ${previous.chunks.slice(0, 2).join(" ")}`;
          break;
        case "less_like":
          baseContext = `${context}\n\nAvoid content about: ${previous.chunks.slice(0, 2).join(" ")}`;
          break;
        case "too_broad":
          baseContext = `${context}\n\nBe very specific and focused.`;
          break;
        case "too_narrow":
          baseContext = `${context}\n\nConsider broader related concepts.`;
          break;
      }
    }
  }
  
  const model = ctx.model;
  if (!model) {
    return baseContext;
  }

  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
  if (!apiKey) {
    return baseContext;
  }

  const systemPrompt = `You are a search query optimizer. Given a user's question or context, generate a concise, semantically rich search query that will retrieve the most relevant information from a knowledge base. Output ONLY the search query, nothing else. Do not include any explanation or formatting.`;

  try {
    const result = await completeSimple(model, {
      systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: baseContext }] }],
    }, {
      apiKey,
      maxTokens: 100,
    });

    const textContent = result.content.find((c) => c.type === "text");
    if (textContent && textContent.type === "text") {
      return textContent.text.trim() || baseContext;
    }
    return baseContext;
  } catch {
    return baseContext;
  }
}

/**
 * Format chunks for LLM consumption.
 */
function formatChunks(chunks: LightRAGChunk[], includeMetadata: boolean = true): string {
  if (chunks.length === 0) {
    return "No relevant memories found.";
  }

  let result = `Retrieved ${chunks.length} memory chunk${chunks.length !== 1 ? "s" : ""}:\n`;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const source = chunk.file_path
      ? chunk.file_path.replace(/^.*\/knowledge\//, "")
      : "unknown";

    result += `\n**Chunk ${i + 1} of ${chunks.length}**`;
    
    if (includeMetadata) {
      result += `\n**Source:** ${source}`;
      if (chunk.score !== undefined) {
        result += ` | **Relevance:** ${(chunk.score * 100).toFixed(0)}%`;
      }
      if (chunk.created_at) {
        const date = new Date(chunk.created_at).toLocaleDateString();
        result += ` | **Date:** ${date}`;
      }
    }
    
    result += `\n${chunk.content}\n`;
  }

  return result;
}

/**
 * Generate unique query ID.
 */
function generateQueryId(): string {
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export default function (pi: ExtensionAPI) {
  // Register the "remember" tool
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Store a piece of information in long-term memory for future retrieval. Automatically chunks content based on type (code, prose, docs) for optimal retrieval.",
    parameters: Type.Object({
      content: Type.String({
        description: "The text content to store in memory.",
      }),
      source: Type.Optional(
        Type.String({
          description: "An optional source identifier or file path for the content.",
        })
      ),
      chunkSize: Type.Optional(
        Type.Union([
          Type.Literal("small", { description: "~500 chars - best for facts, quotes, code snippets" }),
          Type.Literal("medium", { description: "~1500 chars - best for paragraphs (default)" }),
          Type.Literal("large", { description: "~4000 chars - best for full documentation sections" }),
          Type.Literal("auto", { description: "Auto-detect based on content structure" }),
        ], {
          description: "How to chunk the content for storage. 'auto' detects code vs prose.",
          default: "auto",
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
      const { content, source, chunkSize = "auto" } = params as {
        content: string;
        source?: string;
        chunkSize?: "small" | "medium" | "large" | "auto";
      };

      if (!content || typeof content !== "string" || !content.trim()) {
        return {
          content: [{ type: "text", text: "Error: content parameter is required" }],
          details: { error: "invalid_content" },
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Storing in memory (${chunkSize} chunks)...` }],
      });

      try {
        const timeout = Math.min(MAX_TIMEOUT, Math.max(5, params.timeout ?? DEFAULT_TIMEOUT));
        
        const result = await uploadToLightRAG({
          content: content.trim(),
          source,
          chunkSize,
          timeout,
        });

        const detectedSize = chunkSize === "auto" ? detectContentStructure(content) : chunkSize;
        
        const details: RememberDetails = {
          trackId: result.trackId,
          source,
          contentLength: content.length,
          chunkSize: detectedSize,
          estimatedChunks: result.chunks,
          tookMs: result.tookMs,
        };

        return {
          content: [
            {
              type: "text",
              text: `Successfully stored ${content.length} characters as ${result.chunks} ${detectedSize} chunk(s) in memory.${source ? ` Source: ${source}` : ""}`,
            },
          ],
          details,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error storing memory: ${errorMessage}` }],
          details: { error: errorMessage },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("remember "));
      const preview = args.content.length > 50 ? args.content.slice(0, 50) + "..." : args.content;
      text += theme.fg("accent", `"${preview}"`);
      if (args.chunkSize && args.chunkSize !== "auto") {
        text += theme.fg("muted", ` [${args.chunkSize}]`);
      }
      if (args.source) {
        text += theme.fg("muted", ` (${args.source})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as RememberDetails | undefined;

      if (result.isError) {
        return new Text(theme.fg("error", "Failed to store"), 0, 0);
      }

      let text = theme.fg("success", `Stored ${details?.contentLength ?? 0} chars`);
      if (details?.estimatedChunks) {
        text += theme.fg("dim", ` (${details.estimatedChunks} ${details.chunkSize} chunks)`);
      }
      if (details?.source) {
        text += theme.fg("dim", ` - ${details.source}`);
      }

      return new Text(text, 0, 0);
    },
  });

  // Register the "recall" tool
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Retrieve relevant information from long-term memory. Supports relevance filtering, deduplication, time ranges, and source filtering. Use feedback parameters to refine follow-up queries.",
    parameters: Type.Object({
      context: Type.String({
        description: "The current context or question to search for in memory.",
      }),
      count: Type.Optional(
        Type.Number({
          description: "Number of memory chunks to retrieve (1-100).",
          minimum: 1,
          maximum: MAX_CHUNK_COUNT,
          default: DEFAULT_CHUNK_COUNT,
        })
      ),
      minRelevance: Type.Optional(
        Type.Number({
          description: "Minimum relevance score 0-1. Higher = more selective. 0.7 is a good default.",
          minimum: 0,
          maximum: 1,
          default: 0.7,
        })
      ),
      deduplicate: Type.Optional(
        Type.Boolean({
          description: "Remove semantically similar chunks to increase diversity.",
          default: true,
        })
      ),
      timeRange: Type.Optional(
        Type.Union([
          Type.Literal("recent", { description: "Last 7 days" }),
          Type.Literal("month", { description: "Last 30 days" }),
          Type.Literal("year", { description: "Last 365 days" }),
          Type.Literal("all", { description: "All time (default)" }),
        ], {
          description: "Filter memories by recency.",
          default: "all",
        })
      ),
      sources: Type.Optional(
        Type.Array(Type.String(), {
          description: "Only recall from specific sources (regex patterns supported).",
        })
      ),
      previousQueryId: Type.Optional(
        Type.String({
          description: "ID from a previous recall to refine results based on feedback.",
        })
      ),
      feedback: Type.Optional(
        Type.Union([
          Type.Literal("more_like", { description: "Want more content like previous results" }),
          Type.Literal("less_like", { description: "Want to exclude previous result topics" }),
          Type.Literal("too_broad", { description: "Results were too broad, need focus" }),
          Type.Literal("too_narrow", { description: "Results too narrow, need broader context" }),
        ], {
          description: "Feedback on previous query to refine this search.",
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
        context, 
        count, 
        minRelevance = 0.7, 
        deduplicate = true,
        timeRange = "all",
        sources,
        previousQueryId,
        feedback,
      } = params as {
        context: string;
        count?: number;
        minRelevance?: number;
        deduplicate?: boolean;
        timeRange?: "recent" | "month" | "year" | "all";
        sources?: string[];
        previousQueryId?: string;
        feedback?: RecallFeedback;
      };

      if (!context || typeof context !== "string" || !context.trim()) {
        return {
          content: [{ type: "text", text: "Error: context parameter is required" }],
          details: { error: "invalid_context" },
          isError: true,
        };
      }

      const chunkCount = Math.max(1, Math.min(MAX_CHUNK_COUNT, Math.floor(count ?? DEFAULT_CHUNK_COUNT)));
      const queryId = generateQueryId();

      onUpdate?.({
        content: [{ type: "text", text: "Generating optimized search query..." }],
      });

      const startTime = Date.now();

      try {
        // Generate optimized search query using LLM
        const feedbackData = previousQueryId && feedback 
          ? { previousQueryId, feedback } 
          : undefined;
        const optimizedQuery = await generateSearchQuery(context.trim(), ctx, feedbackData);

        onUpdate?.({
          content: [{ type: "text", text: `Searching memory for: "${optimizedQuery}"...` }],
        });

        const timeout = Math.min(MAX_TIMEOUT, Math.max(5, params.timeout ?? DEFAULT_TIMEOUT));
        
        // Query LightRAG
        const result = await queryLightRAG({
          query: optimizedQuery,
          chunkCount,
          timeout,
          timeRange: timeRange !== "all" ? timeRange : undefined,
          sources,
        });

        let chunks = result.chunks;
        const originalCount = chunks.length;

        // Apply filters
        if (minRelevance > 0) {
          chunks = filterByRelevance(chunks, minRelevance);
        }

        if (timeRange !== "all") {
          chunks = filterByTimeRange(chunks, timeRange);
        }

        if (sources && sources.length > 0) {
          chunks = filterBySource(chunks, sources);
        }

        if (deduplicate) {
          chunks = deduplicateChunks(chunks);
        }

        // Limit to requested count
        chunks = chunks.slice(0, chunkCount);

        // Store query history for feedback
        QUERY_HISTORY.set(queryId, {
          query: optimizedQuery,
          timestamp: Date.now(),
          chunks: chunks.map(c => c.content.slice(0, 200)),
          originalContext: context,
        });

        // Clean old history
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        for (const [key, value] of QUERY_HISTORY) {
          if (value.timestamp < oneHourAgo) {
            QUERY_HISTORY.delete(key);
          }
        }

        const formattedChunks = formatChunks(chunks);

        const details: RecallDetails = {
          originalContext: context,
          optimizedQuery,
          chunkCount: chunks.length,
          filteredCount: originalCount > chunks.length ? originalCount - chunks.length : undefined,
          timeRange: timeRange !== "all" ? timeRange : undefined,
          sources,
          tookMs: Date.now() - startTime,
          queryId,
        };

        const feedbackHint = `\n\n[Query ID: ${queryId}. Use previousQueryId="${queryId}" with feedback="more_like|less_like|too_broad|too_narrow" to refine.]`;

        return {
          content: [{ type: "text", text: formattedChunks + feedbackHint }],
          details,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error recalling memory: ${errorMessage}` }],
          details: { error: errorMessage },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("recall "));
      const preview = args.context.length > 50 ? args.context.slice(0, 50) + "..." : args.context;
      text += theme.fg("accent", `"${preview}"`);
      if (args.count) {
        text += theme.fg("muted", ` (${args.count} chunks)`);
      }
      if (args.minRelevance !== undefined && args.minRelevance !== 0.7) {
        text += theme.fg("muted", ` [rel>${args.minRelevance}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as RecallDetails | undefined;

      if (result.isError) {
        return new Text(theme.fg("error", "Failed to recall"), 0, 0);
      }

      let text = theme.fg("success", `${details?.chunkCount ?? 0} chunk${(details?.chunkCount ?? 0) !== 1 ? "s" : ""}`);
      
      if (details?.filteredCount) {
        text += theme.fg("dim", ` (${details.filteredCount} filtered)`);
      }
      
      if (expanded && details?.optimizedQuery) {
        text += `\n${theme.fg("dim", `Query: "${details.optimizedQuery}"`)}`;
        if (details.queryId) {
          text += `\n${theme.fg("dim", `ID: ${details.queryId}`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
