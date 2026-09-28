import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OdpApiError, type OdpClient } from "./odp-client.js";
import { LIMITS, type Settings } from "./settings.js";

/** Everything a tool handler needs for one MCP request: server settings and the caller's ODP client. */
export class ToolContext {
  constructor(
    readonly settings: Settings,
    readonly client: OdpClient,
  ) {}

  jsonResult(data: unknown): CallToolResult {
    const text = JSON.stringify(data, null, 2) ?? "null";
    const max = LIMITS.maxResponseChars;
    if (text.length <= max) return { content: [{ type: "text", text }] };
    return {
      content: [
        {
          type: "text",
          text:
            `${text.slice(0, max)}\n\n[truncated: response was ${text.length} characters, limit is ${max}. ` +
            `Request fewer fields or a smaller page size, or use an export job for bulk data.]`,
        },
      ],
    };
  }
}

/** An error caused by bad tool input; its message is shown to the model as-is. */
export class UserError extends Error {}

export function errorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof OdpApiError) {
    text = `${err.message}\n${JSON.stringify(err.body, null, 2)}`;
    if (err.status === 401 || err.status === 403) {
      text +=
        "\n\nCheck that the X-ODP-API-Key header is a valid ODP private API key with access to this API (ODP: Settings > APIs), " +
        "and that X-ODP-Region matches the account's region.";
    }
  } else if (err instanceof Error && err.name === "TimeoutError") {
    text = "ODP API request timed out. Try a narrower query, fewer fields or a smaller page size.";
  } else {
    text = err instanceof Error ? err.message : String(err);
  }
  return { isError: true, content: [{ type: "text", text }] };
}

/** Wraps a tool handler so thrown errors become MCP error results instead of protocol errors. */
export function safe<A>(handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
