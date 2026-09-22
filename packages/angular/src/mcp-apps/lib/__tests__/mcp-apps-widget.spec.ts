import type { AbstractAgent, RunAgentResult } from "@ag-ui/client";
import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import {
  CopilotKit,
  anyActivityContentSchema,
  provideCopilotKit,
} from "@copilotkit/angular";
import type { MCPAppsSnapshotContent } from "../mcp-apps-content";
import {
  CopilotMCPAppsActivityRenderer,
  mcpAppsActivityRendererConfig,
} from "../mcp-apps-activity-renderer";
import { CopilotMCPAppsWidget } from "../mcp-apps-widget";
import { provideMCPApps } from "../provide-mcp-apps";
import { expect, test, vi } from "vitest";

type AgentHarness = AbstractAgent & {
  addMessage: ReturnType<typeof vi.fn>;
  runAgent: ReturnType<typeof vi.fn>;
  finishRun(): void;
};

const snapshot: MCPAppsSnapshotContent = {
  serverHash: "server-hash",
  serverId: "demo",
  resourceUri: "ui://demo/widget.html",
  result: { content: [{ type: "text", text: "done" }] },
  toolInput: { city: "Paris" },
};

@Component({ template: "custom" })
class CustomMCPAppsRenderer extends CopilotMCPAppsActivityRenderer {}

function createAgent(resourceText = "<h1>MCP App</h1>"): AgentHarness {
  const subscribers: Array<{
    onRunFinalized?: () => void;
    onRunFailed?: () => void;
  }> = [];
  const agent = {
    agentId: "agent-1",
    threadId: "thread-1",
    isRunning: false,
    messages: [] as unknown[],
    setMessages(messages: unknown[]) {
      this.messages = messages;
    },
    addMessage: vi.fn(),
    subscribe: vi.fn(
      (subscriber: {
        onRunFinalized?: () => void;
        onRunFailed?: () => void;
      }) => {
        subscribers.push(subscriber);
        return {
          unsubscribe: () => {
            const index = subscribers.indexOf(subscriber);
            if (index >= 0) subscribers.splice(index, 1);
          },
        };
      },
    ),
    runAgent: vi.fn(
      async (parameters: {
        forwardedProps?: {
          __proxiedMCPRequest?: { method?: string };
        };
      }): Promise<RunAgentResult> => {
        const method = parameters.forwardedProps?.__proxiedMCPRequest?.method;
        if (method === "resources/read") {
          return {
            result: {
              contents: [
                {
                  uri: snapshot.resourceUri,
                  mimeType: "text/html",
                  text: resourceText,
                },
              ],
            },
            newMessages: [],
          };
        }
        return {
          result: { content: [{ type: "text", text: "tool response" }] },
          newMessages: [],
        };
      },
    ),
    finishRun() {
      this.isRunning = false;
      for (const subscriber of subscribers.slice()) {
        subscriber.onRunFinalized?.();
      }
    },
  };
  return agent as unknown as AgentHarness;
}

/**
 * The slice of `CopilotKitCore` the widget touches: it runs follow-ups and
 * explanations through `runAgent`, asks how final an activity's content is,
 * and listens for runs settling.
 */
type ExchangeState = "unknown" | "pending" | "settled" | "untracked";

function coreStub(
  runAgent = vi.fn(async () => ({ result: undefined, newMessages: [] })),
  exchangeState: ExchangeState = "unknown",
) {
  const settledCallbacks: Array<() => void> = [];
  let state = exchangeState;
  return {
    runAgent,
    getActivityExchangeState: vi.fn(() => state),
    subscribe: vi.fn((subscriber: { onActivityRunSettled?: () => void }) => {
      if (subscriber.onActivityRunSettled) {
        settledCallbacks.push(subscriber.onActivityRunSettled);
      }
      return { unsubscribe: vi.fn() };
    }),
    /** What the core would answer from here on. */
    setExchangeState(next: ExchangeState) {
      state = next;
    },
    /** Fire every run-settled subscription, as the core would at run end. */
    settleRuns() {
      for (const callback of settledCallbacks.slice()) callback();
    },
  };
}

function configureTestingModule(
  runAgent = vi.fn(async () => ({ result: undefined, newMessages: [] })),
  idleTimeoutMs = 30_000,
  initializationTimeoutMs = 30_000,
  core = coreStub(runAgent),
): typeof core {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideMCPApps({
        idleTimeoutMs,
        initializationTimeoutMs,
      }),
      {
        provide: CopilotKit,
        useValue: { core },
      },
    ],
  });
  return core;
}

async function settle(fixture: {
  whenStable: () => Promise<unknown>;
  detectChanges: () => void;
}): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function dispatchFrameMessage(
  frame: HTMLIFrameElement,
  data: unknown,
  source: MessageEventSource | null = frame.contentWindow,
): void {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

async function bootWidget(
  agent: AgentHarness,
  messageId?: string,
): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<CopilotMCPAppsWidget>>;
  frame: HTMLIFrameElement;
  postMessage: ReturnType<typeof vi.spyOn>;
}> {
  const fixture = TestBed.createComponent(CopilotMCPAppsWidget);
  fixture.componentRef.setInput("data", snapshot);
  fixture.componentRef.setInput("agent", agent);
  if (messageId) fixture.componentRef.setInput("messageId", messageId);
  await settle(fixture);

  const frame = fixture.nativeElement.querySelector<HTMLIFrameElement>(
    "[data-testid='mcp-app-iframe']",
  );
  if (!frame?.contentWindow) throw new Error("MCP Apps iframe was not created");
  await waitFor(
    () => frame.srcdoc.includes("sandbox-proxy-ready"),
    "sandbox proxy was not installed",
  );

  const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-proxy-ready",
    params: {},
  });
  await settle(fixture);
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "initialize",
    method: "ui/initialize",
    params: {
      appInfo: { name: "test", version: "1" },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    },
  });
  await settle(fixture);
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    method: "ui/notifications/initialized",
    params: {},
  });
  await settle(fixture);

  return { fixture, frame, postMessage };
}

test("loads the resource through the selected agent and boots the sandbox", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { fixture, frame, postMessage } = await bootWidget(agent);

  expect(agent.runAgent).toHaveBeenCalledWith({
    forwardedProps: {
      __proxiedMCPRequest: {
        serverHash: "server-hash",
        serverId: "demo",
        method: "resources/read",
        params: { uri: "ui://demo/widget.html" },
      },
    },
  });
  expect(frame.getAttribute("sandbox")).toBe(
    "allow-scripts allow-same-origin allow-forms",
  );
  expect(frame.srcdoc).toContain("Content-Security-Policy");
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: "<h1>MCP App</h1>" },
    }),
    "*",
  );
  expect(postMessage).toHaveBeenCalledWith(
    {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: snapshot.toolInput },
    },
    "*",
  );
  expect(postMessage).toHaveBeenCalledWith(
    {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: snapshot.result,
    },
    "*",
  );
  expect(fixture.nativeElement.querySelector("[role='status']")).toBeNull();
});

test("decodes UTF-8 resource blobs without corrupting text", async () => {
  configureTestingModule();
  const agent = createAgent();
  const html = "<h1>Héllo 👋</h1>";
  const bytes = new TextEncoder().encode(html);
  const blob = btoa(String.fromCharCode(...bytes));
  agent.runAgent.mockResolvedValueOnce({
    result: {
      contents: [
        {
          uri: snapshot.resourceUri,
          mimeType: "text/html",
          blob,
        },
      ],
    },
    newMessages: [],
  });

  const { postMessage } = await bootWidget(agent);

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "ui/notifications/sandbox-resource-ready",
      params: expect.objectContaining({ html }),
    }),
    "*",
  );
});

test("preserves the sandbox across equivalent activity snapshot updates", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { fixture, frame } = await bootWidget(agent);
  const initialSrcdoc = frame.srcdoc;

  fixture.componentRef.setInput("data", {
    ...snapshot,
    result: { content: [{ type: "text", text: "done" }] },
    toolInput: { city: "Paris" },
  });
  await settle(fixture);

  expect(agent.runAgent).toHaveBeenCalledTimes(1);
  expect(frame.srcdoc).toBe(initialSrcdoc);
});

test("accepts JSON-RPC only from the exact iframe window", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { frame, postMessage } = await bootWidget(agent);
  postMessage.mockClear();

  dispatchFrameMessage(
    frame,
    { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} },
    window,
  );
  dispatchFrameMessage(frame, { id: 2, method: "ui/initialize", params: {} });
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: 3,
    method: "ui/initialize",
    params: {},
  });

  await waitFor(
    () => postMessage.mock.calls.length > 0,
    "initialize response missing",
  );
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ jsonrpc: "2.0", id: 3 }),
    "*",
  );
  expect(frame.getAttribute("data-mcp-app-initialized")).toBe("true");
});

test("proxies tool calls through the selected agent", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { frame, postMessage } = await bootWidget(agent);
  postMessage.mockClear();

  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "tool-1",
    method: "tools/call",
    params: { name: "weather", arguments: { city: "Paris" } },
  });
  await waitFor(
    () => agent.runAgent.mock.calls.length === 2,
    "tool did not run",
  );
  await Promise.resolve();

  expect(agent.runAgent.mock.calls[1]?.[0]).toEqual({
    forwardedProps: {
      __proxiedMCPRequest: {
        serverHash: "server-hash",
        serverId: "demo",
        method: "tools/call",
        params: { name: "weather", arguments: { city: "Paris" } },
      },
    },
  });
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ jsonrpc: "2.0", id: "tool-1" }),
    "*",
  );
});

test("acknowledges UI messages and runs same-thread follow-ups through core", async () => {
  const runFollowUp = vi.fn(async () => ({
    result: undefined,
    newMessages: [],
  }));
  configureTestingModule(runFollowUp);
  const agent = createAgent();
  const { frame, postMessage } = await bootWidget(agent);
  postMessage.mockClear();

  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "message-1",
    method: "ui/message",
    params: {
      role: "user",
      content: [{ type: "text", text: "Book it" }],
      followUp: true,
    },
  });
  await waitFor(
    () => runFollowUp.mock.calls.length === 1,
    "follow-up did not run",
  );

  expect(agent.addMessage).toHaveBeenCalledWith(
    expect.objectContaining({ role: "user", content: "Book it" }),
  );
  expect(postMessage).toHaveBeenCalledWith(
    { jsonrpc: "2.0", id: "message-1", result: { isError: false } },
    "*",
  );
  expect(runFollowUp).toHaveBeenCalledWith({ agent });
});

test("drops a queued UI follow-up after its agent switches threads", async () => {
  const runFollowUp = vi.fn(async () => ({
    result: undefined,
    newMessages: [],
  }));
  configureTestingModule(runFollowUp);
  const agent = createAgent();
  const { frame } = await bootWidget(agent);
  agent.isRunning = true;

  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "message-1",
    method: "ui/message",
    params: {
      role: "user",
      content: [{ type: "text", text: "Do not leak me" }],
      followUp: true,
    },
  });
  // AppBridge dispatch is asynchronous; switch after the request was queued.
  await waitFor(
    () => agent.addMessage.mock.calls.length === 1,
    "message was not handled",
  );
  agent.threadId = "thread-2";
  agent.finishRun();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(runFollowUp).not.toHaveBeenCalled();
});

test("rejects unsafe open-link schemes without opening a window", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { frame, postMessage } = await bootWidget(agent);
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  postMessage.mockClear();

  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "unsafe-link",
    method: "ui/open-link",
    params: { url: "javascript:alert(document.cookie)" },
  });

  await waitFor(
    () => postMessage.mock.calls.length > 0,
    "open-link response missing",
  );
  expect(open).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "unsafe-link",
      result: { isError: true },
    }),
    "*",
  );
  open.mockRestore();
});

test("matches the React SDK sandbox and resource CSP contract", async () => {
  configureTestingModule();
  const agent = createAgent();
  agent.runAgent.mockResolvedValueOnce({
    result: {
      contents: [
        {
          uri: snapshot.resourceUri,
          text: "<h1>MCP App</h1>",
          _meta: {
            ui: {
              csp: {
                resourceDomains: ["https://cdn.example.com"],
              },
            },
          },
        },
      ],
    },
    newMessages: [],
  });
  const fixture = TestBed.createComponent(CopilotMCPAppsWidget);
  fixture.componentRef.setInput("data", snapshot);
  fixture.componentRef.setInput("agent", agent);
  await settle(fixture);
  const frame = fixture.nativeElement.querySelector<HTMLIFrameElement>(
    "[data-testid='mcp-app-iframe']",
  );
  if (!frame?.contentWindow) throw new Error("MCP Apps iframe was not created");
  await waitFor(() => Boolean(frame.srcdoc), "sandbox proxy was not installed");
  const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-proxy-ready",
    params: {},
  });
  await settle(fixture);

  const resourceReady = postMessage.mock.calls.find(
    ([message]) =>
      (message as { method?: string }).method ===
      "ui/notifications/sandbox-resource-ready",
  )?.[0];

  expect(frame.getAttribute("sandbox")).toBe(
    "allow-scripts allow-same-origin allow-forms",
  );
  expect(frame.getAttribute("src")).toBeNull();
  expect(frame.srcdoc).toContain(
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' 'unsafe-eval' blob: data: http://localhost:* https://localhost:* https://cdn.example.com",
  );
  expect(frame.srcdoc).toContain(
    'inner.setAttribute("sandbox","allow-scripts allow-same-origin allow-forms")',
  );
  expect(resourceReady).toEqual({
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-resource-ready",
    params: { html: "<h1>MCP App</h1>" },
  });
});

test("shows accessible loading and missing-resource errors", async () => {
  configureTestingModule();
  const agent = createAgent();
  agent.runAgent.mockResolvedValueOnce({
    result: { contents: [] },
    newMessages: [],
  });
  const fixture = TestBed.createComponent(CopilotMCPAppsWidget);
  fixture.componentRef.setInput("data", snapshot);
  fixture.componentRef.setInput("agent", agent);

  fixture.detectChanges();
  expect(
    fixture.nativeElement.querySelector("[role='status']")?.textContent,
  ).toContain("Loading MCP App");
  await settle(fixture);
  await waitFor(
    () => Boolean(fixture.nativeElement.querySelector("[role='alert']")),
    "missing resource error was not shown",
  );

  expect(
    fixture.nativeElement.querySelector("[role='alert']")?.textContent,
  ).toContain("No resource content in response");
});

test("shows an accessible error when the sandbox handshake times out", async () => {
  configureTestingModule(undefined, 30_000, 5);
  const agent = createAgent();
  const fixture = TestBed.createComponent(CopilotMCPAppsWidget);
  fixture.componentRef.setInput("data", snapshot);
  fixture.componentRef.setInput("agent", agent);
  await settle(fixture);
  await new Promise((resolve) => setTimeout(resolve, 10));
  fixture.detectChanges();

  expect(
    fixture.nativeElement.querySelector("[role='alert']")?.textContent,
  ).toContain("Timed out after 5ms waiting for the MCP App sandbox");
});

test("renders through the built-in activity config and passes the agent", async () => {
  configureTestingModule();
  const agent = createAgent();
  const fixture = TestBed.createComponent(CopilotMCPAppsActivityRenderer);
  fixture.componentRef.setInput("activityType", "mcp-apps");
  fixture.componentRef.setInput("content", snapshot);
  fixture.componentRef.setInput("message", {
    id: "activity-1",
    role: "activity",
    activityType: "mcp-apps",
    content: snapshot,
  });
  fixture.componentRef.setInput("agent", agent);
  await settle(fixture);

  expect(
    fixture.nativeElement.querySelector("copilot-mcp-apps-widget"),
  ).not.toBeNull();
  expect(mcpAppsActivityRendererConfig.activityType).toBe("mcp-apps");
  expect(mcpAppsActivityRendererConfig.component).toBe(
    CopilotMCPAppsActivityRenderer,
  );
});

test("provideMCPApps registers a lower-precedence built-in renderer", () => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideCopilotKit({
        renderActivityMessages: [
          {
            activityType: "mcp-apps",
            content: anyActivityContentSchema,
            component: CustomMCPAppsRenderer,
          },
        ],
      }),
      provideMCPApps(),
    ],
  });

  const renderers = TestBed.inject(CopilotKit)
    .activityMessageRenderConfigs()
    .filter((renderer) => renderer.activityType === "mcp-apps");

  expect(renderers.map((renderer) => renderer.component)).toEqual([
    CustomMCPAppsRenderer,
    CopilotMCPAppsActivityRenderer,
  ]);
});

test("forwards changed results without reloading the sandbox", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { fixture, frame, postMessage } = await bootWidget(agent);
  const srcdoc = frame.srcdoc;
  postMessage.mockClear();
  const result = {
    content: [{ type: "text", text: "updated" }],
    _meta: { private: true },
  };
  fixture.componentRef.setInput("data", { ...snapshot, result });
  await settle(fixture);
  expect(agent.runAgent).toHaveBeenCalledTimes(1);
  expect(frame.srcdoc).toBe(srcdoc);
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "ui/notifications/tool-result",
      params: result,
    }),
    "*",
  );
});

test("rejects a single resource with the wrong URI", async () => {
  configureTestingModule();
  const agent = createAgent();
  agent.runAgent.mockResolvedValueOnce({
    result: { contents: [{ uri: "ui://wrong", text: "wrong" }] },
    newMessages: [],
  });
  const fixture = TestBed.createComponent(CopilotMCPAppsWidget);
  fixture.componentRef.setInput("data", snapshot);
  fixture.componentRef.setInput("agent", agent);
  await settle(fixture);
  await waitFor(
    () => Boolean(fixture.nativeElement.querySelector("[role=alert]")),
    "missing error",
  );
  expect(fixture.nativeElement.querySelector("iframe").srcdoc).toBe("");
});

test("retains the positive finite height clamp", async () => {
  configureTestingModule();
  const { fixture, frame } = await bootWidget(createAgent());
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height: 6000 },
  });
  await settle(fixture);
  expect(frame.style.height).toBe("5000px");
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height: -2 },
  });
  await settle(fixture);
  expect(frame.style.height).toBe("5000px");
});

test("cancels a queued follow-up when the widget is destroyed", async () => {
  const runFollowUp = vi.fn(async () => ({
    result: undefined,
    newMessages: [],
  }));
  configureTestingModule(runFollowUp);
  const agent = createAgent();
  const { fixture, frame } = await bootWidget(agent);
  agent.isRunning = true;
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "queued",
    method: "ui/message",
    params: { content: [{ type: "text", text: "hello" }] },
  });
  await waitFor(
    () => agent.addMessage.mock.calls.length === 1,
    "message was not queued",
  );
  fixture.destroy();
  agent.finishRun();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runFollowUp).not.toHaveBeenCalled();
});

test("uses the shared metadata follow-up extension", async () => {
  const runFollowUp = vi.fn(async () => ({
    result: undefined,
    newMessages: [],
  }));
  configureTestingModule(runFollowUp);
  const agent = createAgent();
  const { fixture, frame } = await bootWidget(agent);
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "meta",
    method: "ui/message",
    params: {
      content: [{ type: "text", text: "hello" }],
      _meta: { copilotkit: { role: "assistant", followUp: false } },
    },
  });
  await settle(fixture);
  expect(agent.addMessage).toHaveBeenCalledWith(
    expect.objectContaining({ role: "assistant", content: "hello" }),
  );
  expect(runFollowUp).not.toHaveBeenCalled();
});

test("reads store updates by message id and recovers from invalid content", async () => {
  configureTestingModule();
  const agent = createAgent();
  const activity = {
    id: "act-1",
    role: "activity" as const,
    activityType: "mcp-apps",
    content: snapshot,
  };
  agent.messages = [activity];
  const { fixture, frame, postMessage } = await bootWidget(agent, "act-1");
  const listener = vi
    .mocked(agent.subscribe)
    .mock.calls.map(([callbacks]) => callbacks)
    .find((callbacks) => callbacks.onMessagesChanged);
  expect(listener).toBeDefined();
  const emit = (content: unknown) => {
    agent.messages = [{ ...activity, content: content as typeof snapshot }];
    listener!.onMessagesChanged!({ messages: agent.messages } as Parameters<
      NonNullable<typeof listener.onMessagesChanged>
    >[0]);
  };
  postMessage.mockClear();
  emit({ ...snapshot, result: { content: [{ type: "unknown" }] } });
  await settle(fixture);
  expect(fixture.nativeElement.querySelector("[role=alert]")).not.toBeNull();
  const result = { content: [{ type: "text", text: "recovered" }] };
  emit({ ...snapshot, result });
  await settle(fixture);
  expect(fixture.nativeElement.querySelector("[role=alert]")).toBeNull();
  expect(frame.srcdoc).toContain("sandbox-proxy-ready");
  expect(agent.runAgent).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "ui/notifications/tool-result",
      params: result,
    }),
    "*",
  );
});

// ---------------------------------------------------------------------------
// Failure lifecycle, through the real shared session: the widget must hand the
// session the core's run tracking (`getExchangeState`, `subscribeRunSettled`)
// and act on its verdict (`onRemoved`). Without that wiring every activity
// error reads as `unknown` and is never terminal, and a retirement decided by
// the session never leaves the screen.
// ---------------------------------------------------------------------------

const failedSnapshot: MCPAppsSnapshotContent = {
  ...snapshot,
  result: { content: [], isError: true },
};

async function bootFailedWidget(core: ReturnType<typeof coreStub>) {
  const agent = createAgent();
  agent.messages = [
    {
      id: "act-1",
      role: "activity",
      activityType: "mcp-apps",
      content: failedSnapshot,
    },
  ];
  const fixture = TestBed.createComponent(CopilotMCPAppsWidget);
  fixture.componentRef.setInput("data", failedSnapshot);
  fixture.componentRef.setInput("agent", agent);
  fixture.componentRef.setInput("messageId", "act-1");
  await settle(fixture);
  await waitFor(
    () => (core.runAgent as ReturnType<typeof vi.fn>).mock.calls.length === 1,
    "the explanation run never started",
  );
  await settle(fixture);
  return { agent, fixture };
}

test("removes the widget and explains a tool error that was already settled at bind", async () => {
  const explain = vi.fn(async () => ({ result: undefined, newMessages: [] }));
  const core = configureTestingModule(
    explain,
    30_000,
    30_000,
    coreStub(explain, "settled"),
  );
  const { agent, fixture } = await bootFailedWidget(core);

  // Off screen, and never fetched: the controller refused the mount.
  expect(
    fixture.nativeElement.querySelector("[data-testid='mcp-app-iframe']"),
  ).toBeNull();
  expect(
    agent.runAgent.mock.calls.filter(
      ([input]) =>
        input?.forwardedProps?.__proxiedMCPRequest?.method === "resources/read",
    ),
  ).toHaveLength(0);
  // Removed from the store, explained once, in one run.
  expect(agent.messages).toEqual([]);
  expect(agent.addMessage).toHaveBeenCalledTimes(1);
  expect(agent.addMessage.mock.calls[0]?.[0]).toMatchObject({
    role: "developer",
  });
  expect(explain).toHaveBeenCalledTimes(1);
  expect(explain).toHaveBeenCalledWith({ agent });
  // The verdict came from the core's run tracking, not a default.
  expect(core.getActivityExchangeState).toHaveBeenCalledWith(
    "agent-1",
    "thread-1",
    "act-1",
    agent,
  );
  expect(core.subscribe).toHaveBeenCalledWith(
    expect.objectContaining({ onActivityRunSettled: expect.any(Function) }),
  );
});

test("stays removed for the same resource, and mounts again for a different one", async () => {
  const explain = vi.fn(async () => ({ result: undefined, newMessages: [] }));
  const core = configureTestingModule(
    explain,
    30_000,
    30_000,
    coreStub(explain, "settled"),
  );
  const { agent, fixture } = await bootFailedWidget(core);
  expect(
    fixture.nativeElement.querySelector("[data-testid='mcp-app-iframe']"),
  ).toBeNull();

  // Same widget, a later update: the removed exchange stays removed.
  fixture.componentRef.setInput("data", {
    ...failedSnapshot,
    result: { content: [{ type: "text", text: "late" }] },
  });
  await settle(fixture);
  expect(
    fixture.nativeElement.querySelector("[data-testid='mcp-app-iframe']"),
  ).toBeNull();
  expect(explain).toHaveBeenCalledTimes(1);

  // A different resource is a new exchange: it gets its frame and is fetched.
  const other = { ...snapshot, resourceUri: "ui://demo/other.html" };
  fixture.componentRef.setInput("data", other);
  await settle(fixture);
  await waitFor(
    () =>
      agent.runAgent.mock.calls.some(
        ([input]) =>
          input?.forwardedProps?.__proxiedMCPRequest?.method ===
            "resources/read" &&
          input?.forwardedProps?.__proxiedMCPRequest?.params?.uri ===
            other.resourceUri,
      ),
    "the new exchange was never fetched",
  );
  expect(
    fixture.nativeElement.querySelector("[data-testid='mcp-app-iframe']"),
  ).not.toBeNull();
});

test("keeps a provisional fragment mounted, then removes and explains it when the run ends without another update", async () => {
  const explain = vi.fn(async () => ({ result: undefined, newMessages: [] }));
  const core = configureTestingModule(
    explain,
    30_000,
    30_000,
    coreStub(explain, "pending"),
  );
  const agent = createAgent();
  // A usable identity but no result yet, while the run is still open.
  const fragment = {
    resourceUri: snapshot.resourceUri,
    serverHash: snapshot.serverHash,
    serverId: snapshot.serverId,
    toolInput: { city: "Paris" },
  } as unknown as MCPAppsSnapshotContent;
  agent.messages = [
    {
      id: "act-1",
      role: "activity",
      activityType: "mcp-apps",
      content: fragment,
    },
  ];
  const fixture = TestBed.createComponent(CopilotMCPAppsWidget);
  fixture.componentRef.setInput("data", fragment);
  fixture.componentRef.setInput("agent", agent);
  fixture.componentRef.setInput("messageId", "act-1");
  await settle(fixture);
  const frame = fixture.nativeElement.querySelector<HTMLIFrameElement>(
    "[data-testid='mcp-app-iframe']",
  );
  if (!frame) throw new Error("MCP Apps iframe was not created");
  await waitFor(
    () => frame.srcdoc.includes("sandbox-proxy-ready"),
    "sandbox proxy was not installed",
  );

  // Provisional: mounted, fetched, nothing reported.
  expect(explain).not.toHaveBeenCalled();
  expect(agent.addMessage).not.toHaveBeenCalled();

  // The run ends and the fragment never completed. No content changed, so only
  // the run-settled notification can tell the session to look again.
  core.setExchangeState("settled");
  core.settleRuns();
  await waitFor(
    () => explain.mock.calls.length === 1,
    "explanation did not run",
  );
  await settle(fixture);

  expect(
    fixture.nativeElement.querySelector("[data-testid='mcp-app-iframe']"),
  ).toBeNull();
  expect(agent.messages).toEqual([]);
  expect(agent.addMessage).toHaveBeenCalledTimes(1);
  expect(agent.addMessage.mock.calls[0]?.[0]).toMatchObject({
    role: "developer",
  });
});

test("answers a failing tools/call before the frame is removed, then explains it once", async () => {
  const explain = vi.fn(async () => ({ result: undefined, newMessages: [] }));
  configureTestingModule(explain);
  const agent = createAgent();
  agent.messages = [
    {
      id: "act-1",
      role: "activity",
      activityType: "mcp-apps",
      content: snapshot,
    },
  ];
  const { fixture, frame } = await bootWidget(agent, "act-1");

  // Record, for every message posted to the widget, whether its frame was
  // still on screen at that moment. The response must go out while it is;
  // removal may only follow.
  const posted: Array<{ message: Record<string, any>; attached: boolean }> = [];
  const cw = frame.contentWindow!;
  const origPostMessage = cw.postMessage.bind(cw);
  cw.postMessage = ((message: unknown, ...args: unknown[]) => {
    posted.push({
      message: message as Record<string, any>,
      attached: fixture.nativeElement.contains(frame),
    });
    return (origPostMessage as (...a: unknown[]) => void)(message, ...args);
  }) as typeof cw.postMessage;

  agent.runAgent.mockImplementationOnce(async () => ({
    result: {
      content: [{ type: "text", text: "Payment declined." }],
      isError: true,
    },
    newMessages: [],
  }));

  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "pay-1",
    method: "tools/call",
    params: { name: "pay", arguments: {} },
  });
  await waitFor(
    () => posted.some((p) => p.message?.id === "pay-1"),
    "the failing tools/call was never answered",
  );

  // The widget got the real error result, while it was still mounted.
  const response = posted.find((p) => p.message?.id === "pay-1")!;
  expect(response.message.result).toMatchObject({ isError: true });
  expect(response.attached).toBe(true);

  // Then, and only then, the frame goes and the agent is told once.
  await waitFor(
    () => explain.mock.calls.length === 1,
    "explanation did not run",
  );
  await settle(fixture);
  expect(
    fixture.nativeElement.querySelector("[data-testid='mcp-app-iframe']"),
  ).toBeNull();
  expect(agent.addMessage).toHaveBeenCalledTimes(1);
  expect(agent.addMessage.mock.calls[0]?.[0]).toMatchObject({
    role: "developer",
  });
});

test("reports failed follow-ups through the Angular error UI", async () => {
  configureTestingModule(
    vi.fn(async () => {
      throw new Error("follow-up failed");
    }),
  );
  const { fixture, frame } = await bootWidget(createAgent());
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "failure",
    method: "ui/message",
    params: { content: [{ type: "text", text: "hello" }] },
  });
  await settle(fixture);
  expect(
    fixture.nativeElement.querySelector("[role=alert]")?.textContent,
  ).toContain("follow-up failed");
  expect(frame.srcdoc).toBe("");
});

test.each([0, -1, Infinity, NaN])(
  "rejects invalid idle timeouts: %s",
  (idleTimeoutMs) => {
    expect(() => provideMCPApps({ idleTimeoutMs })).toThrow(/positive finite/);
  },
);

test("names the missing packages when the MCP Apps bridge cannot be loaded", async () => {
  // The bridge is imported lazily. A raw module-resolution failure ("Failed to
  // fetch dynamically imported module...") tells a user nothing about what to
  // install, so the widget must translate it into the same actionable message
  // React and Vue already show.
  vi.doMock("@copilotkit/mcp-apps-renderer", () => {
    throw new Error("Failed to fetch dynamically imported module");
  });
  try {
    configureTestingModule();
    const agent = createAgent();
    const fixture = TestBed.createComponent(CopilotMCPAppsWidget);
    fixture.componentRef.setInput("data", snapshot);
    fixture.componentRef.setInput("agent", agent);
    await settle(fixture);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle(fixture);

    const alert: HTMLElement | null =
      fixture.nativeElement.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "MCP Apps require '@copilotkit/mcp-apps-renderer'",
    );
    expect(alert?.textContent).toContain("@modelcontextprotocol/ext-apps");
    expect(alert?.textContent).toContain("Reinstall your dependencies");
  } finally {
    vi.doUnmock("@copilotkit/mcp-apps-renderer");
  }
});

// ---------------------------------------------------------------------------
// Adaptation of react-core's `MCPAppsProxy.e2e.test.tsx`.
//
// Angular now speaks the protocol through the same shared session as React, so
// the negotiation and proxy-error contracts must be verified here too - the
// existing Angular suite covered the happy paths and its own UI guarantees, not
// these. Case names are kept word-for-word with React where the behaviour is
// identical; the two intentional divergences are called out inline.
// ---------------------------------------------------------------------------

test("negotiates and returns the host context for a well-formed initialize", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { frame, postMessage } = await bootWidget(agent);

  postMessage.mockClear();
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "init-ok",
    method: "ui/initialize",
    params: {
      appInfo: { name: "test-widget", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    },
  });
  await waitFor(
    () =>
      postMessage.mock.calls.some(
        ([message]) => (message as { id?: string })?.id === "init-ok",
      ),
    "initialize was never answered",
  );

  const response = postMessage.mock.calls
    .map(([message]) => message as Record<string, any>)
    .find((message) => message?.id === "init-ok");
  expect(response?.error).toBeUndefined();
  expect(response?.result?.protocolVersion).toBe("2026-01-26");
  expect(response?.result?.hostContext).toMatchObject({ platform: "web" });
});

test("rejects an initialize that omits required fields with -32603", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { frame, postMessage } = await bootWidget(agent);

  postMessage.mockClear();
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "init-bad",
    method: "ui/initialize",
    params: {},
  });
  await waitFor(
    () =>
      postMessage.mock.calls.some(
        ([message]) => (message as { id?: string })?.id === "init-bad",
      ),
    "invalid initialize was never answered",
  );

  const response = postMessage.mock.calls
    .map(([message]) => message as Record<string, any>)
    .find((message) => message?.id === "init-bad");
  expect(response?.error?.code).toBe(-32603);
});

test("returns the host protocol version, not the widget's, when they differ", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { frame, postMessage } = await bootWidget(agent);

  postMessage.mockClear();
  // "2025-06-18" is what Angular's hand-rolled router used to hardcode before
  // the migration: the bridge answers with its own version instead of echoing.
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "init-version",
    method: "ui/initialize",
    params: {
      appInfo: { name: "legacy-widget", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: "2025-06-18",
    },
  });
  await waitFor(
    () =>
      postMessage.mock.calls.some(
        ([message]) => (message as { id?: string })?.id === "init-version",
      ),
    "legacy initialize was never answered",
  );

  const response = postMessage.mock.calls
    .map(([message]) => message as Record<string, any>)
    .find((message) => message?.id === "init-version");
  expect(response?.result?.protocolVersion).toBe("2026-01-26");
});

test("returns a JSON-RPC error when the agent throws during tools/call", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { frame, postMessage } = await bootWidget(agent);

  agent.runAgent.mockRejectedValueOnce(new Error("agent exploded"));
  postMessage.mockClear();
  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "call-fails",
    method: "tools/call",
    params: { name: "do_thing", arguments: {} },
  });
  await waitFor(
    () =>
      postMessage.mock.calls.some(
        ([message]) => (message as { id?: string })?.id === "call-fails",
      ),
    "failing tools/call was never answered",
  );

  // The widget gets an explicit error rather than waiting forever.
  const response = postMessage.mock.calls
    .map(([message]) => message as Record<string, any>)
    .find((message) => message?.id === "call-fails");
  expect(response?.error).toBeDefined();
});

test("calls window.open with the correct URL when the iframe sends ui/open-link", async () => {
  configureTestingModule();
  const agent = createAgent();
  const { frame } = await bootWidget(agent);
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "open-ok",
    method: "ui/open-link",
    params: { url: "https://example.com/docs" },
  });
  await waitFor(
    () => openSpy.mock.calls.length > 0,
    "open-link was never opened",
  );

  expect(openSpy).toHaveBeenCalledWith(
    "https://example.com/docs",
    "_blank",
    "noopener,noreferrer",
  );
  openSpy.mockRestore();
});

test("allows a custom-scheme deep link (only script/HTML schemes are blocked)", async () => {
  // Angular used to opt into an https-only policy here. The frontends now share
  // ONE link policy, so this case is word-for-word React's: a deep link hands
  // off to an OS handler and is not a script-execution vector.
  configureTestingModule();
  const agent = createAgent();
  const { frame } = await bootWidget(agent);
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

  dispatchFrameMessage(frame, {
    jsonrpc: "2.0",
    id: "deep-link",
    method: "ui/open-link",
    params: { url: "myapp://open/thing" },
  });
  await waitFor(
    () => openSpy.mock.calls.length > 0,
    "custom-scheme deep link was never opened",
  );

  expect(openSpy).toHaveBeenCalledWith(
    "myapp://open/thing",
    "_blank",
    "noopener,noreferrer",
  );
  openSpy.mockRestore();
});
