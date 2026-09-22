import { defineComponent } from "vue";
import { render, screen } from "@testing-library/vue";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  ActivityMessage,
  AssistantMessage,
  Message,
  UserMessage,
} from "@ag-ui/core";
import { MCPAppsActivityContentSchema } from "@copilotkit/mcp-apps-renderer/activity";
import CopilotKitProvider from "../../../providers/CopilotKitProvider.vue";
import CopilotChatConfigurationProvider from "../../../providers/CopilotChatConfigurationProvider.vue";
import CopilotChatMessageView from "../CopilotChatMessageView.vue";

describe("CopilotChatMessageView activity rendering", () => {
  const agentId = "default";
  const threadId = "thread-test";

  function renderMessageView({
    messages,
    hostTemplate = `<CopilotChatMessageView :messages="messages" />`,
  }: {
    messages: Message[];
    hostTemplate?: string;
  }) {
    const ActivityRenderer = defineComponent({
      name: "ActivityRenderer",
      props: {
        content: { type: Object, required: true },
      },
      setup(props) {
        return {
          percent: (props.content as { percent: number }).percent,
        };
      },
      template: `
        <div data-testid="activity-renderer">
          Progress: {{ percent }}%
        </div>
      `,
    });

    const Host = defineComponent({
      components: {
        CopilotKitProvider,
        CopilotChatConfigurationProvider,
        CopilotChatMessageView,
        ActivityRenderer,
      },
      setup() {
        return { messages, agentId, threadId };
      },
      template: `
        <CopilotKitProvider runtime-url="/api/copilotkit">
          <CopilotChatConfigurationProvider :agent-id="agentId" :thread-id="threadId">
            ${hostTemplate}
          </CopilotChatConfigurationProvider>
        </CopilotKitProvider>
      `,
    });

    return render(Host);
  }

  it("renders activity messages via matching custom renderer", () => {
    const messages: Message[] = [
      {
        id: "act-1",
        role: "activity",
        activityType: "search-progress",
        content: { percent: 42 },
      } as ActivityMessage,
    ];

    const renderers = [
      {
        activityType: "search-progress",
        content: z.object({ percent: z.number() }),
      },
    ];
    expect(renderers).toHaveLength(1);

    renderMessageView({
      messages,
      hostTemplate: `
        <CopilotChatMessageView :messages="messages">
          <template #activity-search-progress="{ content }">
            <ActivityRenderer :content="content" />
          </template>
        </CopilotChatMessageView>
      `,
    });

    expect(screen.getByTestId("activity-renderer").textContent).toContain("42");
  });

  it("skips rendering when no activity renderer matches", () => {
    const messages: Message[] = [
      {
        id: "act-2",
        role: "activity",
        activityType: "unknown-type",
        content: { message: "should not render" },
      } as ActivityMessage,
    ];

    renderMessageView({
      messages,
      hostTemplate: `<CopilotChatMessageView :messages="messages" />`,
    });

    expect(screen.queryByTestId("activity-renderer")).toBeNull();
  });
});

// The chat view is the second Vue dispatch entry point (the first is the public
// `useRenderActivityMessage` hook). Both must grant the MCP Apps renderer, and
// only it, content the schema rejected: dropping it here would mean the widget
// never mounts, so nothing could decide whether the content is mid-stream,
// retire the widget, or explain its absence.
describe("CopilotChatMessageView invalid MCP Apps content", () => {
  const agentId = "default";
  const threadId = "thread-test";

  // Fails the schema: `serverHash` is required.
  const invalidMcpActivity = {
    id: "act-mcp",
    role: "activity",
    activityType: "mcp-apps",
    content: { resourceUri: "ui://server/app" },
  } as ActivityMessage;

  function renderMessageView({
    messages,
    renderActivityMessages,
  }: {
    messages: Message[];
    renderActivityMessages?: unknown[];
  }) {
    const Host = defineComponent({
      components: {
        CopilotKitProvider,
        CopilotChatConfigurationProvider,
        CopilotChatMessageView,
      },
      setup() {
        return { messages, agentId, threadId, renderActivityMessages };
      },
      template: `
        <CopilotKitProvider runtime-url="/api/copilotkit" :render-activity-messages="renderActivityMessages">
          <CopilotChatConfigurationProvider :agent-id="agentId" :thread-id="threadId">
            <CopilotChatMessageView :messages="messages" />
          </CopilotChatConfigurationProvider>
        </CopilotKitProvider>
      `,
    });

    return render(Host);
  }

  it("hands the built-in renderer content the schema rejected", async () => {
    renderMessageView({ messages: [invalidMcpActivity] });

    // The built-in renderer mounted with the raw content: with no agent
    // registered it reports that, which is a renderer on screen, not a
    // dropped message.
    expect(
      await screen.findByText(/No agent available to fetch resource/),
    ).toBeDefined();
  });

  it("skips a custom renderer that merely reuses the public MCP Apps schema", () => {
    const CustomMcpRenderer = defineComponent({
      name: "CustomMcpRenderer",
      template: `<div data-testid="custom-mcp-renderer">custom</div>`,
    });
    renderMessageView({
      messages: [invalidMcpActivity],
      renderActivityMessages: [
        {
          activityType: "mcp-apps",
          content: MCPAppsActivityContentSchema,
          render: CustomMcpRenderer,
        },
      ],
    });

    // Registering the public schema must not buy the failure-lifecycle
    // exception: this renderer expects parsed content and would break on the
    // raw value.
    expect(screen.queryByTestId("custom-mcp-renderer")).toBeNull();
    expect(screen.queryByText(/No agent available/)).toBeNull();
  });
});

describe("CopilotChatMessageView duplicate message deduplication", () => {
  const agentId = "default";
  const threadId = "thread-test";

  function renderMessageView({ messages }: { messages: Message[] }) {
    const Host = defineComponent({
      components: {
        CopilotKitProvider,
        CopilotChatConfigurationProvider,
        CopilotChatMessageView,
      },
      setup() {
        return { messages, agentId, threadId };
      },
      template: `
        <CopilotKitProvider runtime-url="/api/copilotkit">
          <CopilotChatConfigurationProvider :agent-id="agentId" :thread-id="threadId">
            <CopilotChatMessageView :messages="messages" />
          </CopilotChatConfigurationProvider>
        </CopilotKitProvider>
      `,
    });

    return render(Host);
  }

  it("preserves assistant text content when later duplicate has empty content (multi-tool-call scenario)", () => {
    const messages: Message[] = [
      {
        id: "user-1",
        role: "user",
        content: "Record a headache",
      } as UserMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: "Let me record that...",
      } as AssistantMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "captureData", arguments: "{}" },
          },
        ],
      } as AssistantMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "captureData", arguments: "{}" },
          },
          {
            id: "tc-2",
            type: "function",
            function: { name: "updateMemory", arguments: "{}" },
          },
        ],
      } as AssistantMessage,
    ];

    renderMessageView({ messages });

    const assistantMessages = screen.getAllByTestId(
      "copilot-assistant-message",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.textContent).toContain(
      "Let me record that...",
    );
  });

  it("uses latest content when all assistant duplicates have non-empty content", () => {
    const messages: Message[] = [
      {
        id: "user-1",
        role: "user",
        content: "Hello",
      } as UserMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: "Partial response...",
      } as AssistantMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: "Full response from the assistant.",
      } as AssistantMessage,
    ];

    renderMessageView({ messages });

    const assistantMessages = screen.getAllByTestId(
      "copilot-assistant-message",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.textContent).toContain(
      "Full response from the assistant.",
    );

    const userMessages = screen.getAllByTestId("copilot-user-message");
    expect(userMessages).toHaveLength(1);
  });

  it("uses later content when earlier content is empty", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
      } as AssistantMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: "Here is the result.",
      } as AssistantMessage,
    ];

    const Host = defineComponent({
      components: {
        CopilotKitProvider,
        CopilotChatConfigurationProvider,
        CopilotChatMessageView,
      },
      setup() {
        return { messages, agentId, threadId };
      },
      template: `
        <CopilotKitProvider runtime-url="/api/copilotkit">
          <CopilotChatConfigurationProvider :agent-id="agentId" :thread-id="threadId">
            <CopilotChatMessageView :messages="messages">
              <template #assistant-message="{ message }">
                <div data-testid="assistant-content">{{ message.content }}</div>
              </template>
            </CopilotChatMessageView>
          </CopilotChatConfigurationProvider>
        </CopilotKitProvider>
      `,
    });

    render(Host);

    expect(screen.getByTestId("assistant-content").textContent).toContain(
      "Here is the result.",
    );
  });

  it("recovers toolCalls when later duplicate has content but undefined toolCalls", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "captureData", arguments: "{}" },
          },
        ],
      } as AssistantMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: "Here is the result.",
      } as AssistantMessage,
    ];

    const Host = defineComponent({
      components: {
        CopilotKitProvider,
        CopilotChatConfigurationProvider,
        CopilotChatMessageView,
      },
      setup() {
        return { messages, agentId, threadId };
      },
      template: `
        <CopilotKitProvider runtime-url="/api/copilotkit">
          <CopilotChatConfigurationProvider :agent-id="agentId" :thread-id="threadId">
            <CopilotChatMessageView :messages="messages">
              <template #assistant-message="{ message }">
                <div data-testid="assistant-tool-calls-count">{{ message.toolCalls?.length ?? 0 }}</div>
                <div data-testid="assistant-content">{{ message.content }}</div>
              </template>
            </CopilotChatMessageView>
          </CopilotChatConfigurationProvider>
        </CopilotKitProvider>
      `,
    });

    render(Host);

    expect(screen.getByTestId("assistant-content").textContent).toContain(
      "Here is the result.",
    );
    expect(screen.getByTestId("assistant-tool-calls-count").textContent).toBe(
      "1",
    );
  });

  it("keeps empty toolCalls array from later chunk", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "captureData", arguments: "{}" },
          },
        ],
      } as AssistantMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: "Done.",
        toolCalls: [],
      } as AssistantMessage,
    ];

    const Host = defineComponent({
      components: {
        CopilotKitProvider,
        CopilotChatConfigurationProvider,
        CopilotChatMessageView,
      },
      setup() {
        return { messages, agentId, threadId };
      },
      template: `
        <CopilotKitProvider runtime-url="/api/copilotkit">
          <CopilotChatConfigurationProvider :agent-id="agentId" :thread-id="threadId">
            <CopilotChatMessageView :messages="messages">
              <template #assistant-message="{ message }">
                <div data-testid="assistant-tool-calls-count">{{ message.toolCalls?.length ?? 0 }}</div>
              </template>
            </CopilotChatMessageView>
          </CopilotChatConfigurationProvider>
        </CopilotKitProvider>
      `,
    });

    render(Host);

    expect(screen.getByTestId("assistant-tool-calls-count").textContent).toBe(
      "0",
    );
  });

  it("handles undefined content on both occurrences", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: undefined,
      } as AssistantMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: undefined,
      } as AssistantMessage,
    ];

    const Host = defineComponent({
      components: {
        CopilotKitProvider,
        CopilotChatConfigurationProvider,
        CopilotChatMessageView,
      },
      setup() {
        return { messages, agentId, threadId };
      },
      template: `
        <CopilotKitProvider runtime-url="/api/copilotkit">
          <CopilotChatConfigurationProvider :agent-id="agentId" :thread-id="threadId">
            <CopilotChatMessageView :messages="messages">
              <template #assistant-message="{ message }">
                <div data-testid="assistant-content">{{ message.content }}</div>
              </template>
            </CopilotChatMessageView>
          </CopilotChatConfigurationProvider>
        </CopilotKitProvider>
      `,
    });

    render(Host);

    expect(screen.getByTestId("assistant-content").textContent).toBe("");
  });

  it("keeps last entry for non-assistant roles", () => {
    const messages: Message[] = [
      {
        id: "user-1",
        role: "user",
        content: "Hello",
      } as UserMessage,
      {
        id: "user-1",
        role: "user",
        content: "Hello (updated)",
      } as UserMessage,
    ];

    const Host = defineComponent({
      components: {
        CopilotKitProvider,
        CopilotChatConfigurationProvider,
        CopilotChatMessageView,
      },
      setup() {
        return { messages, agentId, threadId };
      },
      template: `
        <CopilotKitProvider runtime-url="/api/copilotkit">
          <CopilotChatConfigurationProvider :agent-id="agentId" :thread-id="threadId">
            <CopilotChatMessageView :messages="messages">
              <template #user-message="{ message }">
                <div data-testid="user-content">{{ message.content }}</div>
              </template>
            </CopilotChatMessageView>
          </CopilotChatConfigurationProvider>
        </CopilotKitProvider>
      `,
    });

    render(Host);

    expect(screen.getByTestId("user-content").textContent).toBe(
      "Hello (updated)",
    );
  });

  it("preserves order of unique messages", () => {
    const messages: Message[] = [
      {
        id: "user-1",
        role: "user",
        content: "First question",
      } as UserMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: "First answer",
      } as AssistantMessage,
      {
        id: "user-2",
        role: "user",
        content: "Second question",
      } as UserMessage,
      {
        id: "assistant-2",
        role: "assistant",
        content: "Second answer",
      } as AssistantMessage,
    ];

    renderMessageView({ messages });

    const userMessages = screen.getAllByTestId("copilot-user-message");
    const assistantMessages = screen.getAllByTestId(
      "copilot-assistant-message",
    );
    expect(userMessages).toHaveLength(2);
    expect(assistantMessages).toHaveLength(2);
  });
});
