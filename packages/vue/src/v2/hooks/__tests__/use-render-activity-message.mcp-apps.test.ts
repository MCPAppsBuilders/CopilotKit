/**
 * A renderer whose content schema rejected the message is normally skipped.
 * The MCP Apps renderer is the exception: it owns the failure lifecycle, so it
 * must receive the rejected content and decide whether the widget is merely
 * mid-stream, should be retired, or should be explained to the user.
 *
 * The exception is granted by a mark on the renderer, never inferred from its
 * content schema: `MCPAppsActivityContentSchema` is public, so a custom
 * renderer may register it while still expecting parsed content.
 */
import { computed, defineComponent } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityMessage } from "@ag-ui/core";
import {
  MCPAppsActivityType,
  MCPAppsActivityContentSchema,
} from "@copilotkit/mcp-apps-renderer/activity";
import { useRenderActivityMessage } from "../use-render-activity-message";
import { useCopilotKit } from "../../providers/useCopilotKit";
import { MCPAppsActivityRenderer } from "../../components/MCPAppsActivityRenderer";
import type { VueActivityMessageRenderer } from "../../types";

vi.mock("../../providers/useCopilotKit", () => ({
  useCopilotKit: vi.fn(),
}));

vi.mock("../../providers/useCopilotChatConfiguration", () => ({
  useCopilotChatConfiguration: () => computed(() => ({ agentId: "default" })),
}));

const mockUseCopilotKit = useCopilotKit as ReturnType<typeof vi.fn>;

// Fails the schema: `serverHash` is required.
const invalidContent = { resourceUri: "ui://server/app" };

const message = {
  id: "activity-1",
  role: "activity",
  activityType: MCPAppsActivityType,
  content: invalidContent,
} as unknown as ActivityMessage;

/** Resolve `message` through the hook against the given registrations. */
function dispatch(
  renderActivityMessages: VueActivityMessageRenderer<unknown>[],
  target: ActivityMessage = message,
) {
  mockUseCopilotKit.mockReturnValue({
    copilotkit: computed(() => ({
      renderActivityMessages,
      getAgent: () => undefined,
    })),
  });
  const { renderActivityMessage } = useRenderActivityMessage();
  return renderActivityMessage(target);
}

const builtIn: VueActivityMessageRenderer<unknown> = {
  activityType: MCPAppsActivityType,
  content: MCPAppsActivityContentSchema as never,
  render: MCPAppsActivityRenderer as never,
};

const CustomRenderer = defineComponent({
  name: "CustomMcpRenderer",
  render: () => null,
});

const custom: VueActivityMessageRenderer<unknown> = {
  activityType: MCPAppsActivityType,
  content: MCPAppsActivityContentSchema as never,
  render: CustomRenderer as never,
};

describe("useRenderActivityMessage invalid MCP Apps content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands the built-in renderer content the schema rejected", () => {
    // The built-in MCP Apps renderer is marked, so the dispatcher hands it
    // the raw, unparsed content instead of dropping the message.
    const result = dispatch([builtIn]);

    expect(result).not.toBeNull();
    expect(result!.props.content).toBe(invalidContent);
  });

  it("skips a custom renderer that merely reuses the public MCP Apps schema", () => {
    // Registering the public schema must not buy the failure-lifecycle
    // exception: this renderer expects parsed content and would break on the
    // raw value.
    expect(dispatch([custom])).toBeNull();
  });

  it("still renders a custom renderer when the content is valid", () => {
    const result = dispatch([custom], {
      ...message,
      content: {
        resourceUri: "ui://server/app",
        serverHash: "hash-1",
        result: { content: [] },
      },
    } as unknown as ActivityMessage);

    expect(result).not.toBeNull();
  });
});
