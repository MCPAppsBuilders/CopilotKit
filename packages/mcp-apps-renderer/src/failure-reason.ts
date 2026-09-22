import type { ZodError } from "zod";

/** Where an unusable result was observed. */
export type McpFailureOrigin = "activity" | "proxy";

/**
 * What was wrong with it.
 *
 * - `invalid-result`: the payload does not satisfy the MCP result contract, so
 *   the host itself cannot read it.
 * - `tool-error`: a well-formed result whose `isError` is true. The tool failed;
 *   the contract did not.
 */
export type McpFailureKind = "invalid-result" | "tool-error";

/**
 * One bounded detail about a rejection: a schema issue code and the path it
 * was raised at. Deliberately not the offending value, and never free text
 * from the server: this ends up in a message handed to a model, so it carries
 * facts the host produced, not payload it merely passed along.
 */
export interface McpFailureDetail {
  code: string;
  path?: string;
}

export interface McpFailureReason {
  origin: McpFailureOrigin;
  kind: McpFailureKind;
  detail: McpFailureDetail[];
}

/** How many issues a reason carries at most, so one message stays bounded. */
const MAX_DETAILS = 5;

export function reasonFromZodError(
  origin: McpFailureOrigin,
  error: ZodError,
): McpFailureReason {
  return {
    origin,
    kind: "invalid-result",
    detail: error.issues.slice(0, MAX_DETAILS).map((issue) => ({
      code: issue.code,
      ...(issue.path.length > 0 ? { path: issue.path.join(".") } : {}),
    })),
  };
}

export function reasonFromToolError(
  origin: McpFailureOrigin,
): McpFailureReason {
  return { origin, kind: "tool-error", detail: [] };
}

/**
 * A templated, bounded sentence for the message the agent is asked to explain.
 * Built from the host's own vocabulary only.
 */
export function describeFailure(reason: McpFailureReason): string {
  const where =
    reason.origin === "proxy"
      ? "a tool the widget called"
      : "the tool that produced this widget";
  const what =
    reason.kind === "tool-error"
      ? `${where} reported an error`
      : `${where} returned a result this host cannot read`;
  const detail = reason.detail
    .map((entry) =>
      entry.path ? `${entry.code} at ${entry.path}` : entry.code,
    )
    .join(", ");
  return detail ? `${what} (${detail}).` : `${what}.`;
}
