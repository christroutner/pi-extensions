import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { Bot } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";

// ============================================================================
// Configuration Constants
// ============================================================================

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const ALLOWED_USER_ID = (process.env.TELEGRAM_ALLOWED_USER_ID ?? "").trim();

// ============================================================================
// State
// ============================================================================

let bot: Bot | null = null;
let runner: RunnerHandle | null = null;
let lastChatId: number | null = null;

// ============================================================================
// Helpers
// ============================================================================

function isAllowedUser(userId: number | undefined): boolean {
  if (!ALLOWED_USER_ID) {
    return false;
  }
  if (!userId) {
    return false;
  }
  return String(userId) === ALLOWED_USER_ID;
}

function isDirectMessage(chatType: string | undefined): boolean {
  return chatType === "private";
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Don't initialize if no token configured
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set, extension disabled");
    return;
  }

  if (!ALLOWED_USER_ID) {
    console.warn("[telegram] TELEGRAM_ALLOWED_USER_ID not set, extension disabled");
    return;
  }

  // -------------------------------------------------------------------------
  // Session Start: Initialize and start the bot
  // -------------------------------------------------------------------------
  pi.on("session_start", async () => {
    try {
      bot = new Bot(TELEGRAM_BOT_TOKEN);

      // Error handler
      bot.catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[telegram] Bot error: ${message}`);
      });

      // Message handler
      bot.on("message", async (ctx) => {
        const msg = ctx.message;
        if (!msg) {
          return;
        }

        // Only process direct messages
        if (!isDirectMessage(msg.chat.type)) {
          return;
        }

        // Only process messages from the allowed user
        if (!isAllowedUser(msg.from?.id)) {
          return;
        }

        // Extract message text (support text messages and captions)
        const text = msg.text ?? msg.caption ?? "";
        if (!text.trim()) {
          return;
        }

        // Store chat ID for replies
        lastChatId = msg.chat.id;

        // Forward message to the agent
        pi.sendUserMessage(text.trim(), { deliverAs: "followUp" });
      });

      // Start long-polling with the runner
      runner = run(bot, {
        runner: {
          fetch: {
            timeout: 30,
          },
          silent: true,
        },
      });

      console.log(`[telegram] Bot started, listening for user ${ALLOWED_USER_ID}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] Failed to start bot: ${message}`);
    }
  });

  // -------------------------------------------------------------------------
  // Session Shutdown: Stop the bot
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    if (runner) {
      try {
        await runner.stop();
        runner = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[telegram] Failed to stop runner: ${message}`);
      }
    }
    bot = null;
    lastChatId = null;
    console.log("[telegram] Bot stopped");
  });

  // -------------------------------------------------------------------------
  // Tool: telegram_reply
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "telegram_reply",
    label: "Telegram Reply",
    description:
      "Send a message back to the Telegram user. Use this to respond to messages received from Telegram.",
    parameters: Type.Object({
      message: Type.String({
        description: "The text message to send to the Telegram user.",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { message } = params as { message: string };

      if (!message || typeof message !== "string" || !message.trim()) {
        return {
          content: [{ type: "text", text: "Error: message parameter is required" }],
          details: { error: "invalid_message" },
          isError: true,
        };
      }

      if (!bot) {
        return {
          content: [{ type: "text", text: "Error: Telegram bot is not running" }],
          details: { error: "bot_not_running" },
          isError: true,
        };
      }

      if (!lastChatId) {
        return {
          content: [
            { type: "text", text: "Error: No Telegram chat ID available. Wait for a message from the user first." },
          ],
          details: { error: "no_chat_id" },
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: "Sending message to Telegram..." }],
      });

      try {
        const result = await bot.api.sendMessage(lastChatId, message.trim(), {
          parse_mode: "Markdown",
        });

        return {
          content: [
            {
              type: "text",
              text: `Message sent to Telegram user (message_id: ${result.message_id})`,
            },
          ],
          details: {
            messageId: result.message_id,
            chatId: lastChatId,
            textLength: message.length,
          },
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Retry without Markdown if parsing failed
        if (errorMessage.includes("parse") || errorMessage.includes("markdown")) {
          try {
            const result = await bot.api.sendMessage(lastChatId, message.trim());
            return {
              content: [
                {
                  type: "text",
                  text: `Message sent to Telegram user (message_id: ${result.message_id}, plain text fallback)`,
                },
              ],
              details: {
                messageId: result.message_id,
                chatId: lastChatId,
                textLength: message.length,
                fallback: true,
              },
            };
          } catch (retryErr) {
            const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
            return {
              content: [{ type: "text", text: `Error sending message: ${retryMessage}` }],
              details: { error: retryMessage },
              isError: true,
            };
          }
        }

        return {
          content: [{ type: "text", text: `Error sending message: ${errorMessage}` }],
          details: { error: errorMessage },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("telegram_reply "));
      const preview = args.message.length > 50 ? args.message.slice(0, 50) + "..." : args.message;
      text += theme.fg("accent", `"${preview}"`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      if (result.isError) {
        return new Text(theme.fg("error", "Failed to send"), 0, 0);
      }

      const details = result.details as { messageId?: number; fallback?: boolean } | undefined;
      let text = theme.fg("success", "Sent");
      if (details?.messageId) {
        text += theme.fg("dim", ` (id: ${details.messageId})`);
      }
      if (details?.fallback) {
        text += theme.fg("dim", " [plain text]");
      }

      return new Text(text, 0, 0);
    },
  });
}
