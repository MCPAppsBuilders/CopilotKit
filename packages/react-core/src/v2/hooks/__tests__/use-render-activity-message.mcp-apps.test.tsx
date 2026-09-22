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
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { ActivityMessage } from "@ag-ui/core";
import {
  MCPAppsActivityType,
  MCPAppsActivityContentSchema,
} from "@copilotkit/mcp-apps-renderer/activity";
import { CopilotKitProvider } from "../../providers";
import { useRenderActivityMessage } from "../use-render-activity-message";
import type { ReactActivityMessageRenderer } from "../../types";

// Fails the schema: `serverHash` is required.
const invalidContent = { resourceUri: "ui://server/app" };

const message = {
  id: "activity-1",
  role: "activity",
  activityType: MCPAppsActivityType,
  content: invalidContent,
} as unknown as ActivityMessage;

/** Resolve `message` through the hook and return what the dispatcher produced. */
function dispatch(
  renderActivityMessages?: ReactActivityMessageRenderer<any>[],
): React.ReactElement | null {
  let result: React.ReactElement | null = null;

  function Probe() {
    const { renderActivityMessage } = useRenderActivityMessage();
    result = renderActivityMessage(message);
    return null;
  }

  render(
    <CopilotKitProvider renderActivityMessages={renderActivityMessages}>
      <Probe />
    </CopilotKitProvider>,
  );

  return result;
}

describe("useRenderActivityMessage invalid MCP Apps content", () => {
  it("hands the built-in renderer content the schema rejected", () => {
    // No custom registration: the built-in MCP Apps renderer applies. It is
    // marked, so the dispatcher mounts it with the raw, unparsed content
    // instead of dropping the message.
    const element = dispatch();

    expect(element).not.toBeNull();
    expect((element!.props as { content: unknown }).content).toBe(
      invalidContent,
    );
  });

  it("skips a custom renderer that merely reuses the public MCP Apps schema", () => {
    const CustomRenderer = vi.fn(() => null);

    const element = dispatch([
      {
        activityType: MCPAppsActivityType,
        content: MCPAppsActivityContentSchema,
        render: CustomRenderer,
      } as unknown as ReactActivityMessageRenderer<any>,
    ]);

    // Registering the public schema must not buy the failure-lifecycle
    // exception: this renderer expects parsed content and would break on the
    // raw value.
    expect(element).toBeNull();
    expect(CustomRenderer).not.toHaveBeenCalled();
  });

  it("still renders a custom renderer when the content is valid", () => {
    const CustomRenderer = vi.fn(() => null);
    const validContent = {
      resourceUri: "ui://server/app",
      serverHash: "hash-1",
      result: { content: [] },
    };
    let result: React.ReactElement | null = null;

    function Probe() {
      const { renderActivityMessage } = useRenderActivityMessage();
      result = renderActivityMessage({
        ...message,
        content: validContent,
      } as unknown as ActivityMessage);
      return null;
    }

    render(
      <CopilotKitProvider
        renderActivityMessages={[
          {
            activityType: MCPAppsActivityType,
            content: MCPAppsActivityContentSchema,
            render: CustomRenderer,
          } as unknown as ReactActivityMessageRenderer<any>,
        ]}
      >
        <Probe />
      </CopilotKitProvider>,
    );

    expect(result).not.toBeNull();
  });
});
