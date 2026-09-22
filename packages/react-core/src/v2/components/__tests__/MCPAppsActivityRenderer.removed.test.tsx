/**
 * A removal is the controller's verdict on ONE exchange (one resource/server
 * identity). The adapter must take that widget off screen and keep it off for
 * as long as the activity carries the same identity, and must mount again the
 * moment the activity switches to a different resource. A bare "removed" flag
 * fails the second half: the bind effect finds no container and never binds.
 *
 * The session is mocked so the hooks can be driven directly; the core is
 * mocked so the wiring the session relies on can be asserted.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { AbstractAgent } from "@ag-ui/client";

const { bindMcpAppSpy, sessionSpy, core } = vi.hoisted(() => {
  const session = {
    sendToolInput: vi.fn(),
    sendToolResult: vi.fn(),
    syncContent: vi.fn(),
    teardown: vi.fn(),
  };
  return {
    // Declares the options parameter so `mock.calls[n][0]` is typed.
    bindMcpAppSpy: vi.fn((_options: unknown) => session),
    sessionSpy: session,
    core: {
      runAgent: vi.fn(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      getActivityExchangeState: vi.fn(() => "settled"),
    },
  };
});

vi.mock("@copilotkit/mcp-apps-renderer", () => ({
  bindMcpApp: bindMcpAppSpy,
}));

vi.mock("../../providers/CopilotKitProvider", () => ({
  useCopilotKit: () => ({ copilotkit: core }),
}));

import {
  MCPAppsActivityRenderer,
  MCPAppsActivityType,
} from "../MCPAppsActivityRenderer";
import type { MCPAppsActivityContent } from "../MCPAppsActivityRenderer";

const agent = {
  agentId: "agent-1",
  threadId: "thread-1",
  isRunning: false,
  messages: [],
  runAgent: vi.fn(),
  addMessage: vi.fn(),
  subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
} as unknown as AbstractAgent;

const widgetA: MCPAppsActivityContent = {
  resourceUri: "ui://server/a",
  serverHash: "hash-1",
  result: { content: [] },
};
const widgetB: MCPAppsActivityContent = {
  resourceUri: "ui://server/b",
  serverHash: "hash-1",
  result: { content: [] },
};
const reason = { origin: "activity", kind: "tool-error", detail: [] };

type BindOptions = {
  getContent: () => unknown;
  getExchangeState?: () => string;
  subscribeRunSettled?: (callback: () => void) => unknown;
  hooks?: { onRemoved?: (reason: unknown) => void };
};

function renderWidget(content: MCPAppsActivityContent) {
  return render(
    <MCPAppsActivityRenderer
      activityType={MCPAppsActivityType}
      content={content}
      message={{ id: "act-1" }}
      agent={agent}
    />,
  );
}

function rerenderWidget(
  rerender: ReturnType<typeof render>["rerender"],
  content: MCPAppsActivityContent,
) {
  rerender(
    <MCPAppsActivityRenderer
      activityType={MCPAppsActivityType}
      content={content}
      message={{ id: "act-1" }}
      agent={agent}
    />,
  );
}

/** The options handed to the most recent bindMcpApp call. */
async function lastBind(): Promise<BindOptions> {
  await vi.waitFor(() => expect(bindMcpAppSpy).toHaveBeenCalled());
  return bindMcpAppSpy.mock.calls.at(-1)![0] as unknown as BindOptions;
}

describe("MCPAppsActivityRenderer removal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wires exchange state and run-settled notifications from the core", async () => {
    renderWidget(widgetA);
    const options = await lastBind();

    expect(options.getExchangeState!()).toBe("settled");
    expect(core.getActivityExchangeState).toHaveBeenCalledWith(
      "agent-1",
      "thread-1",
      "act-1",
      agent,
    );

    const callback = vi.fn();
    options.subscribeRunSettled!(callback);
    expect(core.subscribe).toHaveBeenCalledWith({
      onActivityRunSettled: callback,
    });
  });

  it("renders nothing once removed, and stays removed while the identity is unchanged", async () => {
    const { container, rerender } = renderWidget(widgetA);
    const options = await lastBind();
    expect(container.firstChild).not.toBeNull();

    act(() => options.hooks!.onRemoved!(reason));
    expect(container.firstChild).toBeNull();

    // Same widget, new tool result: still the removed exchange, so nothing
    // comes back and no session is bound for it.
    const bindsBefore = bindMcpAppSpy.mock.calls.length;
    rerenderWidget(rerender, {
      ...widgetA,
      result: { content: [{ type: "text", text: "late" }] },
    });
    expect(container.firstChild).toBeNull();
    expect(bindMcpAppSpy.mock.calls.length).toBe(bindsBefore);
  });

  it("mounts again when the activity switches to a different resource", async () => {
    const { container, rerender } = renderWidget(widgetA);
    const options = await lastBind();
    act(() => options.hooks!.onRemoved!(reason));
    expect(container.firstChild).toBeNull();

    const bindsBefore = bindMcpAppSpy.mock.calls.length;
    rerenderWidget(rerender, widgetB);

    // The new exchange gets its container back and its own session.
    expect(container.firstChild).not.toBeNull();
    await vi.waitFor(() =>
      expect(bindMcpAppSpy.mock.calls.length).toBe(bindsBefore + 1),
    );
    const next = await lastBind();
    expect(next.getContent()).toEqual(widgetB);
  });
});

// Referenced so the session stub is not tree-shaken out of the mock factory.
void sessionSpy;
