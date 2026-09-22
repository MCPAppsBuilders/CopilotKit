import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SafeParseReturnType } from "zod";
import { MCPAppsActivityContentSchema } from "./content-schema";
import type { McpFailureReason } from "./failure-reason";
import { reasonFromToolError, reasonFromZodError } from "./failure-reason";

/**
 * Whether a value can back a widget, or the widget has nothing left to show.
 *
 * Says nothing about WHEN to act on it: a retire verdict on content that is
 * still streaming is provisional. Pairing the verdict with the exchange state
 * is the widget controller's job.
 */
export type McpContentVerdict =
  | { kind: "keep" }
  | { kind: "retire"; reason: McpFailureReason };

const KEEP: McpContentVerdict = { kind: "keep" };

/**
 * Judge activity content. Pure and registry-free, so a framework's render pass
 * can call it without touching shared state.
 */
export function classifyActivityContent(content: unknown): McpContentVerdict {
  const parsed = MCPAppsActivityContentSchema.safeParse(content);
  if (!parsed.success) {
    return {
      kind: "retire",
      reason: reasonFromZodError("activity", parsed.error),
    };
  }
  if (parsed.data.result?.isError === true) {
    return { kind: "retire", reason: reasonFromToolError("activity") };
  }
  return KEEP;
}

/**
 * Judge a proxied `tools/call` result the widget asked for. A received response
 * is complete by definition, so this verdict is never provisional.
 */
export function classifyProxyResult(
  parsed: SafeParseReturnType<unknown, CallToolResult>,
): McpContentVerdict {
  if (!parsed.success) {
    return {
      kind: "retire",
      reason: reasonFromZodError("proxy", parsed.error),
    };
  }
  if (parsed.data.isError === true) {
    return { kind: "retire", reason: reasonFromToolError("proxy") };
  }
  return KEEP;
}
