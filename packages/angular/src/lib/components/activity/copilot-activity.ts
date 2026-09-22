import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
} from "@angular/core";
import { NgComponentOutlet } from "@angular/common";
import type { ActivityMessage } from "@ag-ui/core";
import type { AbstractAgent } from "@ag-ui/client";
import {
  MCPAppsActivityType as MCP_APPS_ACTIVITY_TYPE,
  ɵhandlesInvalidMCPAppsContent,
} from "@copilotkit/mcp-apps-renderer/activity";
import { CopilotKit } from "../../copilotkit";
import type { RenderActivityMessageConfig } from "../../activity-renderer";
import { pickActivityRenderer } from "./pick-activity-renderer";

interface ActivityRender {
  component: RenderActivityMessageConfig["component"];
  inputs: {
    activityType: string;
    content: unknown;
    message: ActivityMessage;
    agent: AbstractAgent | undefined;
  };
}

/**
 * Renders a single activity message through the activity renderer registered
 * for its `activityType` (see `provideCopilotKit({ renderActivityMessages })`
 * and `registerRenderActivityMessage`).
 *
 * This is the activity counterpart of `RenderToolCalls` and the Angular
 * equivalent of React's `useRenderActivityMessage()`: `CopilotChatMessageView`
 * uses it for the `activity` role, and custom chat shells or non-chat surfaces
 * (dashboards, side panels) can host an activity with it directly instead of
 * instantiating the whole message view.
 *
 * ```html
 * <copilot-activity [message]="activityMessage" [agentId]="agentId" />
 * ```
 *
 * Renders nothing when no renderer matches or when the renderer's content
 * schema rejects the message content (a warning is logged in that case).
 */
@Component({
  selector: "copilot-activity",
  imports: [NgComponentOutlet],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @let render = resolveRender(message());
    @if (render) {
      <ng-container *ngComponentOutlet="render.component; inputs: render.inputs" />
    }
  `,
})
export class CopilotActivity {
  readonly #copilotKit = inject(CopilotKit);

  /** The activity message to render. */
  readonly message = input.required<ActivityMessage>();
  /** Agent scope used for renderer resolution and passed to the renderer. */
  readonly agentId = input<string | undefined>();

  protected resolveRender(
    message: ActivityMessage,
  ): ActivityRender | undefined {
    const agentId = this.agentId();
    const renderer = pickActivityRenderer({
      activityType: message.activityType,
      agentId,
      renderers: this.#copilotKit.activityMessageRenderConfigs(),
    });
    if (!renderer) return undefined;

    const parseResult = renderer.content.safeParse(message.content);
    if (parseResult.success === false) {
      console.warn(
        `Failed to parse content for activity message '${message.activityType}':`,
        parseResult.error,
      );
      // An MCP Apps activity is still handed to its renderer, which owns the
      // failure lifecycle and re-validates for itself. Returning undefined here
      // would drop it for good: the widget would never mount, so nothing
      // could ever decide whether the content is merely mid-stream, remove
      // the widget, or tell the user why it is missing.
      // Only a renderer that declares it owns the failure lifecycle gets the
      // unparsed content. Checking the mark rather than the content schema
      // matters: the MCP Apps schema is public, so a custom renderer may reuse
      // it while still expecting parsed content.
      if (
        message.activityType !== MCP_APPS_ACTIVITY_TYPE ||
        !ɵhandlesInvalidMCPAppsContent(renderer.component)
      ) {
        return undefined;
      }
    }

    return {
      component: renderer.component,
      inputs: {
        activityType: message.activityType,
        content: parseResult.success ? parseResult.data : message.content,
        message,
        agent: agentId ? this.#copilotKit.getAgent(agentId) : undefined,
      },
    };
  }
}
