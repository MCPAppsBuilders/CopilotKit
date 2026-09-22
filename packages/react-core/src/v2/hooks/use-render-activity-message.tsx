import type { ActivityMessage } from "@ag-ui/core";
import { DEFAULT_AGENT_ID } from "@copilotkit/shared";
// Bridge-free entry: keeps the MCP Apps host (and the ext-apps bundle it pulls)
// out of an app that renders no MCP activity.
import { MCPAppsActivityType as MCP_APPS_ACTIVITY_TYPE } from "@copilotkit/mcp-apps-renderer/activity";
import { useCopilotKit, useCopilotChatConfiguration } from "../providers";
import { useCallback, useMemo } from "react";
import type { ReactActivityMessageRenderer } from "../types";

export function useRenderActivityMessage() {
  const { copilotkit } = useCopilotKit();
  const agentId = useCopilotChatConfiguration()?.agentId ?? DEFAULT_AGENT_ID;

  const renderers = copilotkit.renderActivityMessages;

  // Find the renderer for a given activity type
  const findRenderer = useCallback(
    (activityType: string): ReactActivityMessageRenderer<unknown> | null => {
      if (!renderers.length) {
        return null;
      }

      const matches = renderers.filter(
        (renderer) => renderer.activityType === activityType,
      );

      return (
        matches.find((candidate) => candidate.agentId === agentId) ??
        matches.find((candidate) => candidate.agentId === undefined) ??
        renderers.find((candidate) => candidate.activityType === "*") ??
        null
      );
    },
    [agentId, renderers],
  );

  const renderActivityMessage = useCallback(
    (message: ActivityMessage): React.ReactElement | null => {
      const renderer = findRenderer(message.activityType);

      if (!renderer) {
        return null;
      }

      const parseResult = renderer.content["~standard"].validate(
        message.content,
      );

      if (parseResult instanceof Promise) {
        console.warn(
          `Async content validation is not supported for activity message '${message.activityType}'`,
        );
        return null;
      }

      if (parseResult.issues) {
        console.warn(
          `Failed to parse content for activity message '${message.activityType}':`,
          parseResult.issues,
        );
        // An MCP Apps activity is still handed to its renderer, which owns the
        // failure lifecycle and re-validates for itself. Returning null here
        // would drop it for good: the widget would never mount, so nothing
        // could ever decide whether the content is merely mid-stream, remove
        // the widget, or tell the user why it is missing.
        if (message.activityType !== MCP_APPS_ACTIVITY_TYPE) {
          return null;
        }
      }

      const Component = renderer.render;
      const agent = copilotkit.getAgent(agentId);

      return (
        <Component
          key={message.id}
          activityType={message.activityType}
          content={parseResult.issues ? message.content : parseResult.value}
          message={message}
          agent={agent}
        />
      );
    },
    [agentId, copilotkit, findRenderer],
  );

  return useMemo(
    () => ({ renderActivityMessage, findRenderer }),
    [renderActivityMessage, findRenderer],
  );
}
