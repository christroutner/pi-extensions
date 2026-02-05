import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { completeSimple } from "@mariozechner/pi-ai";

const DEFAULT_LIGHTRAG_URL = "http://192.168.0.173:9621";
const DEFAULT_CHUNK_COUNT = 30;
const DEFAULT_TIMEOUT_SECONDS = 30;

// LightRAG response types
type LightRAGUploadResponse = {
  status: string;
  track_id?: string;
  message?: string;
};

type LightRAGChunk = {
  content: string;
  file_path?: string;
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
  tookMs: number;
};

type RecallDetails = {
  originalContext: string;
  optimizedQuery: string;
  chunkCount: number;
  tookMs: number;
};

function getLightRAGUrl(): string {
  return (process.env.LIGHTRAG_URL ?? "").trim() || DEFAULT_LIGHTRAG_URL;
}

/**
 * Upload content to LightRAG for storage.
 */
async function uploadToLightRAG(params: {
  content: string;
  source?: string;
  timeoutSeconds: number;
}): Promise<{ trackId?: string; tookMs: number }> {
  const start = Date.now();
  const lightragUrl = getLightRAGUrl();
  const url = `${lightragUrl}/documents/text`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        text: params.content,
        file_source: params.source || "memory-extension",
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`LightRAG API error (${res.status}): ${detail || res.statusText}`);
    }

    const data = (await res.json()) as LightRAGUploadResponse;
    return {
      trackId: data.track_id,
      tookMs: Date.now() - start,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${params.timeoutSeconds} seconds`);
    }
    throw err;
  }
}

/**
 * Query LightRAG for relevant chunks.
 */
async function queryLightRAG(params: {
  query: string;
  chunkCount: number;
  timeoutSeconds: number;
}): Promise<{ chunks: LightRAGChunk[]; tookMs: number }> {
  const start = Date.now();
  const lightragUrl = getLightRAGUrl();
  const url = `${lightragUrl}/query/data`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

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
        chunk_top_k: params.chunkCount,
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
      throw new Error(`Request timeout after ${params.timeoutSeconds} seconds`);
    }
    throw err;
  }
}

/**
 * Generate an optimized search query using the current LLM model.
 */
async function generateSearchQuery(context: string, ctx: ExtensionContext): Promise<string> {
  const model = ctx.model;
  if (!model) {
    // Fall back to using the context directly if no model available
    return context;
  }

  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
  if (!apiKey) {
    // Fall back to using the context directly if no API key
    return context;
  }

  const systemPrompt = `You are a search query optimizer. Given a user's question or context, generate a concise, semantically rich search query that will retrieve the most relevant information from a knowledge base. Output ONLY the search query, nothing else. Do not include any explanation or formatting.`;

  try {
    const result = await completeSimple(model, {
      systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: context }] }],
    }, {
      apiKey,
      maxTokens: 100,
    });

    // Extract text from the response
    const textContent = result.content.find((c) => c.type === "text");
    if (textContent && textContent.type === "text") {
      return textContent.text.trim() || context;
    }
    return context;
  } catch {
    // Fall back to using the context directly on error
    return context;
  }
}

/**
 * Format chunks for LLM consumption.
 */
function formatChunks(chunks: LightRAGChunk[]): string {
  if (chunks.length === 0) {
    return "No relevant memories found.";
  }

  let result = `Retrieved ${chunks.length} memory chunk${chunks.length !== 1 ? "s" : ""}:\n`;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const source = chunk.file_path
      ? chunk.file_path.replace(/^.*\/knowledge\//, "")
      : "unknown";

    result += `\n**Chunk ${i + 1} of ${chunks.length}**\n`;
    result += `**Source:** ${source}\n`;
    result += chunk.content;
    result += "\n";
  }

  return result;
}

export default function (pi: ExtensionAPI) {
  // Register the "remember" tool
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Store a piece of information in long-term memory for future retrieval. Use this to save important facts, context, or knowledge that should persist across sessions.",
    parameters: Type.Object({
      content: Type.String({
        description: "The text content to store in memory.",
      }),
      source: Type.Optional(
        Type.String({
          description: "An optional source identifier or file path for the content.",
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { content, source } = params as {
        content: string;
        source?: string;
      };

      if (!content || typeof content !== "string" || !content.trim()) {
        return {
          content: [{ type: "text", text: "Error: content parameter is required" }],
          details: { error: "invalid_content" },
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: "Storing in memory..." }],
      });

      try {
        const result = await uploadToLightRAG({
          content: content.trim(),
          source,
          timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        });

        const details: RememberDetails = {
          trackId: result.trackId,
          source,
          contentLength: content.length,
          tookMs: result.tookMs,
        };

        return {
          content: [
            {
              type: "text",
              text: `Successfully stored ${content.length} characters in memory.${source ? ` Source: ${source}` : ""}`,
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
      if (details?.source) {
        text += theme.fg("dim", ` (${details.source})`);
      }

      return new Text(text, 0, 0);
    },
  });

  // Register the "recall" tool
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Retrieve relevant information from long-term memory based on a context or question. The tool generates an optimized search query and returns the most relevant memory chunks.",
    parameters: Type.Object({
      context: Type.String({
        description: "The current context or question to search for in memory.",
      }),
      chunk_count: Type.Optional(
        Type.Number({
          description: "Number of memory chunks to retrieve (default: 30).",
          minimum: 1,
          maximum: 100,
        })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { context, chunk_count } = params as {
        context: string;
        chunk_count?: number;
      };

      if (!context || typeof context !== "string" || !context.trim()) {
        return {
          content: [{ type: "text", text: "Error: context parameter is required" }],
          details: { error: "invalid_context" },
          isError: true,
        };
      }

      const chunkCount = Math.max(1, Math.min(100, Math.floor(chunk_count ?? DEFAULT_CHUNK_COUNT)));

      onUpdate?.({
        content: [{ type: "text", text: "Generating optimized search query..." }],
      });

      const startTime = Date.now();

      try {
        // Generate optimized search query using LLM
        const optimizedQuery = await generateSearchQuery(context.trim(), ctx);

        onUpdate?.({
          content: [{ type: "text", text: `Searching memory for: "${optimizedQuery}"...` }],
        });

        // Query LightRAG with the optimized query
        const result = await queryLightRAG({
          query: optimizedQuery,
          chunkCount,
          timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        });

        const formattedChunks = formatChunks(result.chunks);

        const details: RecallDetails = {
          originalContext: context,
          optimizedQuery,
          chunkCount: result.chunks.length,
          tookMs: Date.now() - startTime,
        };

        return {
          content: [{ type: "text", text: formattedChunks }],
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
      if (args.chunk_count) {
        text += theme.fg("muted", ` (${args.chunk_count} chunks)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as RecallDetails | undefined;

      if (result.isError) {
        return new Text(theme.fg("error", "Failed to recall"), 0, 0);
      }

      let text = theme.fg("success", `${details?.chunkCount ?? 0} chunk${(details?.chunkCount ?? 0) !== 1 ? "s" : ""}`);
      if (expanded && details?.optimizedQuery) {
        text += `\n${theme.fg("dim", `Query: "${details.optimizedQuery}"`)}`;
      }

      return new Text(text, 0, 0);
    },
  });
}
