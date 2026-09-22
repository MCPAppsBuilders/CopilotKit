/**
 * Activity type for MCP Apps events - must match the middleware's MCPAppsActivityType.
 */
export const MCPAppsActivityType = "mcp-apps";

/**
 * URL schemes a widget may NOT open via ui/open-link. The ext-apps schema
 * validates `url` as a plain string only (noopener/noreferrer does not restrict
 * the scheme), so ui/open-link could otherwise become an XSS vector.
 *
 * We use a denylist rather than an allowlist on purpose: deep links use
 * arbitrary, app-defined schemes (`myapp:`, `whatsapp:`, `slack:`, `spotify:`,
 * `sms:`, ...) that an allowlist could never enumerate, and `window.open`ing them
 * just hands off to an OS handler - it does not execute script in the page, so
 * it is not an XSS risk. Universal links / App Links are plain `https:` URLs and
 * pass regardless. What IS dangerous is the small, well-known set of schemes
 * that execute script or render attacker HTML in the page context; block those
 * and allow everything else (including deep links).
 */
export const MCP_OPEN_LINK_BLOCKED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "blob:",
  "file:",
]);

/**
 * Stable key for the widget resource a session is bound to. A session fetches
 * and renders exactly ONE resource: this key is what tells a remount of the
 * same widget from a switch to a different one, both in the session (which
 * refuses to forward another identity's content into its iframe) and in the
 * failure controller (which keeps a removed widget removed across remounts,
 * but starts a fresh report cycle for a new identity).
 *
 * Serialised as a tuple rather than joined with a delimiter: a resourceUri is
 * arbitrary text, so any separator can appear inside it and make two distinct
 * widgets share a key (`"a::b" + "c"` vs `"a" + "b::c"`). JSON also keeps
 * `undefined` distinct from `""` instead of collapsing both to empty.
 */
export function ɵmcpAppsIdentityKey(content: {
  resourceUri?: string;
  serverHash?: string;
  serverId?: string;
}): string {
  return JSON.stringify([
    content.resourceUri ?? null,
    content.serverHash ?? null,
    content.serverId ?? null,
  ]);
}

/**
 * Marks a renderer as the owner of the MCP Apps failure lifecycle: it
 * re-validates content itself, so a framework dispatcher must hand it content
 * the schema rejected instead of dropping the message. Dropping it would mean
 * the widget never mounts, and nothing could then decide whether the content is
 * merely mid-stream, retire the widget, or tell the user why it is gone.
 *
 * Carried by the renderer rather than inferred from its content schema: the
 * schema is public, so a custom renderer may legitimately reuse it while still
 * expecting parsed content and crashing on anything else.
 *
 * `Symbol.for` so the mark survives two copies of this package in one app.
 */
const HANDLES_INVALID_CONTENT = Symbol.for(
  "copilotkit.mcp-apps.handles-invalid-content",
);

/** Apply {@link ɵhandlesInvalidMCPAppsContent}'s mark to a renderer. */
export function ɵmarkHandlesInvalidMCPAppsContent<T extends object>(
  renderer: T,
): T {
  Object.defineProperty(renderer, HANDLES_INVALID_CONTENT, { value: true });
  return renderer;
}

/** True for a renderer marked as owning the MCP Apps failure lifecycle. */
export function ɵhandlesInvalidMCPAppsContent(renderer: unknown): boolean {
  return (
    (typeof renderer === "object" || typeof renderer === "function") &&
    renderer !== null &&
    (renderer as Record<symbol, unknown>)[HANDLES_INVALID_CONTENT] === true
  );
}
