/**
 * A removal is the controller's verdict on ONE exchange (one resource/server
 * identity). The adapter must take that widget off screen and keep it off for
 * as long as the activity carries the same identity, and must mount again the
 * moment the activity switches to a different resource. A bare "removed" flag
 * fails the second half: the bind watcher finds no container and never binds.
 *
 * The session is mocked so the hooks can be driven directly; the core is
 * mocked so the wiring the session relies on can be asserted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
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

vi.mock("../../providers/useCopilotKit", () => ({
  useCopilotKit: () => ({
    copilotkit: { value: core },
  }),
}));

import {
  MCPAppsActivityRenderer,
  MCPAppsActivityType,
} from "../MCPAppsActivityRenderer";

const agent = {
  agentId: "agent-1",
  threadId: "thread-1",
  isRunning: false,
  messages: [],
  runAgent: vi.fn(),
  addMessage: vi.fn(),
  subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
} as unknown as AbstractAgent;

const widgetA = {
  resourceUri: "ui://server/a",
  serverHash: "hash-1",
  result: { content: [] },
};
const widgetB = {
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

function mountWidget(content: typeof widgetA) {
  return mount(MCPAppsActivityRenderer, {
    props: {
      activityType: MCPAppsActivityType,
      content,
      message: {
        id: "act-1",
        role: "activity",
        content: {},
        activityType: MCPAppsActivityType,
      },
      agent,
    },
  });
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
    mountWidget(widgetA);
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
    const wrapper = mountWidget(widgetA);
    const options = await lastBind();
    expect(wrapper.find("div").exists()).toBe(true);

    options.hooks!.onRemoved!(reason);
    await nextTick();
    expect(wrapper.find("div").exists()).toBe(false);

    // Same widget, new tool result: still the removed exchange, so nothing
    // comes back and no session is bound for it.
    const bindsBefore = bindMcpAppSpy.mock.calls.length;
    await wrapper.setProps({
      content: {
        ...widgetA,
        result: { content: [{ type: "text", text: "late" }] },
      },
    });
    await nextTick();
    expect(wrapper.find("div").exists()).toBe(false);
    expect(bindMcpAppSpy.mock.calls.length).toBe(bindsBefore);
  });

  it("mounts again when the activity switches to a different resource", async () => {
    const wrapper = mountWidget(widgetA);
    const options = await lastBind();
    options.hooks!.onRemoved!(reason);
    await nextTick();
    expect(wrapper.find("div").exists()).toBe(false);

    const bindsBefore = bindMcpAppSpy.mock.calls.length;
    await wrapper.setProps({ content: widgetB });
    await nextTick();

    // The new exchange gets its container back and its own session.
    expect(wrapper.find("div").exists()).toBe(true);
    await vi.waitFor(() =>
      expect(bindMcpAppSpy.mock.calls.length).toBe(bindsBefore + 1),
    );
    const next = await lastBind();
    expect(next.getContent()).toEqual(widgetB);
  });
});

// Referenced so the session stub is not tree-shaken out of the mock factory.
void sessionSpy;
