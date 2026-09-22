import type { AbstractAgent, ActivityMessage } from "@ag-ui/client";
import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import type {
  ActivityRenderer,
  RenderActivityMessageConfig,
} from "@copilotkit/angular";
import { ɵmarkHandlesInvalidMCPAppsContent } from "@copilotkit/mcp-apps-renderer/activity";
import {
  mcpAppsSnapshotContentSchema,
  type MCPAppsSnapshotContent,
} from "./mcp-apps-content";
import { CopilotMCPAppsWidget } from "./mcp-apps-widget";

/**
 * Activity renderer for `mcp-apps` snapshots. Renders the referenced MCP App
 * inline via {@link CopilotMCPAppsWidget}. Resource and tool requests are
 * proxied through the activity's selected AG-UI agent.
 */
@Component({
  selector: "copilot-mcp-apps-activity-renderer",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CopilotMCPAppsWidget],
  template: `
    <copilot-mcp-apps-widget
      [data]="content()"
      [agent]="agent()"
      [messageId]="message().id"
    />
  `,
})
export class CopilotMCPAppsActivityRenderer implements ActivityRenderer<MCPAppsSnapshotContent> {
  readonly activityType = input.required<string>();
  readonly content = input.required<MCPAppsSnapshotContent>();
  readonly message = input.required<ActivityMessage>();
  readonly agent = input<AbstractAgent | undefined>();
}

// This renderer owns the MCP Apps failure lifecycle, so the dispatcher must
// hand it content the schema rejected instead of dropping the message.
ɵmarkHandlesInvalidMCPAppsContent(CopilotMCPAppsActivityRenderer);

/**
 * Ready-to-register render config for `mcp-apps` activity messages. Pass it
 * to `provideCopilotKit({ renderActivityMessages: [...] })`.
 */
export const mcpAppsActivityRendererConfig: RenderActivityMessageConfig<MCPAppsSnapshotContent> =
  {
    activityType: "mcp-apps",
    content: mcpAppsSnapshotContentSchema,
    component: CopilotMCPAppsActivityRenderer,
  };
