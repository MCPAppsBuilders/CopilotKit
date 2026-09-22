import { Component, computed, input, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActivityMessage } from "@ag-ui/core";
import type { AbstractAgent } from "@ag-ui/client";
import {
  MCPAppsActivityContentSchema,
  ɵmarkHandlesInvalidMCPAppsContent,
} from "@copilotkit/mcp-apps-renderer/activity";
import type { ActivityRenderer } from "../../../activity-renderer";
import { CopilotActivity } from "../copilot-activity";
import { CopilotKit } from "../../../copilotkit";
import { anyActivityContentSchema } from "../../../activity-renderer";
import type { RenderActivityMessageConfig } from "../../../activity-renderer";
import {
  PrimaryActivityRenderer,
  WildcardActivityRenderer,
} from "./activity-renderer-stubs";

@Component({
  imports: [CopilotActivity],
  template: `
    <copilot-activity [message]="message" [agentId]="agentId" />
  `,
})
class ActivityHostComponent {
  message!: ActivityMessage;
  agentId: string | undefined = undefined;
}

/**
 * Stands in for the built-in MCP Apps renderer: marked as owning the failure
 * lifecycle, so the dispatcher must hand it content the schema rejected.
 */
@Component({
  selector: "marked-mcp-apps-renderer",
  template: `
    <div
      data-testid="marked-mcp-activity"
      [attr.data-content]="contentJson()"
    ></div>
  `,
})
class MarkedMcpAppsRenderer implements ActivityRenderer {
  readonly activityType = input.required<string>();
  readonly content = input.required<unknown>();
  readonly message = input.required<ActivityMessage>();
  readonly agent = input<AbstractAgent | undefined>();
  protected readonly contentJson = computed(() =>
    JSON.stringify(this.content()),
  );
}
ɵmarkHandlesInvalidMCPAppsContent(MarkedMcpAppsRenderer);

// Fails the MCP Apps schema: `serverHash` is required.
const invalidMcpContent = { resourceUri: "ui://server/app" };

const activityMessage = (
  overrides: Partial<ActivityMessage> = {},
): ActivityMessage => ({
  id: "activity-1",
  role: "activity",
  activityType: "a2ui-surface",
  content: {},
  ...overrides,
});

describe("CopilotActivity", () => {
  const renderers = signal<RenderActivityMessageConfig[]>([]);
  const getAgent = vi.fn();

  const render = (message: ActivityMessage, agentId?: string) => {
    const fixture = TestBed.createComponent(ActivityHostComponent);
    fixture.componentInstance.message = message;
    fixture.componentInstance.agentId = agentId;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    renderers.set([]);
    getAgent.mockReset();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: CopilotKit,
          useValue: {
            activityMessageRenderConfigs: renderers.asReadonly(),
            getAgent,
          },
        },
      ],
    });
  });

  it("renders the resolved renderer with the four renderer inputs", () => {
    renderers.set([
      {
        activityType: "a2ui-surface",
        agentId: "demo-button",
        content: z.object({ operations: z.array(z.unknown()) }),
        component: PrimaryActivityRenderer,
      },
    ]);
    getAgent.mockReturnValue({ agentId: "demo-button" });

    const host = render(
      activityMessage({ content: { operations: [] } }),
      "demo-button",
    );

    const rendered = host.querySelector<HTMLElement>(
      '[data-testid="primary-activity"]',
    );
    expect(rendered).not.toBeNull();
    expect(rendered?.getAttribute("data-activity-type")).toBe("a2ui-surface");
    expect(rendered?.getAttribute("data-has-agent")).toBe("true");
    expect(rendered?.getAttribute("data-content")).toBe(
      JSON.stringify({ operations: [] }),
    );
    expect(getAgent).toHaveBeenCalledWith("demo-button");
  });

  it("leaves agent undefined when no agentId is set", () => {
    renderers.set([
      {
        activityType: "a2ui-surface",
        content: anyActivityContentSchema,
        component: PrimaryActivityRenderer,
      },
    ]);

    const host = render(activityMessage());

    expect(
      host
        .querySelector('[data-testid="primary-activity"]')
        ?.getAttribute("data-has-agent"),
    ).toBe("false");
    expect(getAgent).not.toHaveBeenCalled();
  });

  it("renders the wildcard renderer for unregistered activity types", () => {
    renderers.set([
      {
        activityType: "*",
        content: anyActivityContentSchema,
        component: WildcardActivityRenderer,
      },
    ]);

    const host = render(activityMessage({ activityType: "unregistered" }));

    expect(
      host.querySelector('[data-testid="wildcard-activity"]'),
    ).not.toBeNull();
  });

  it("renders nothing and warns when the content fails to parse", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderers.set([
      {
        activityType: "a2ui-surface",
        content: z.object({ operations: z.array(z.unknown()) }),
        component: PrimaryActivityRenderer,
      },
    ]);

    const host = render(activityMessage({ content: { wrong: true } }));

    expect(host.querySelector('[data-testid="primary-activity"]')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "Failed to parse content for activity message 'a2ui-surface':",
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("renders nothing when no renderer matches", () => {
    const host = render(activityMessage({ activityType: "unregistered" }));

    expect(host.querySelector('[data-testid="primary-activity"]')).toBeNull();
    expect((host.textContent ?? "").trim()).toBe("");
  });

  // The MCP Apps renderer owns the failure lifecycle, so it must receive
  // content the schema rejected instead of being skipped: dropping it here
  // would mean the widget never mounts, so nothing could decide whether the
  // content is mid-stream, retire the widget, or explain its absence. The
  // exception is granted by a mark on the renderer, never inferred from its
  // schema, which is public and may be reused by a custom renderer.
  it("hands a marked MCP Apps renderer content the schema rejected", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderers.set([
      {
        activityType: "mcp-apps",
        content: MCPAppsActivityContentSchema,
        component: MarkedMcpAppsRenderer,
      },
    ]);

    const host = render(
      activityMessage({ activityType: "mcp-apps", content: invalidMcpContent }),
    );

    const rendered = host.querySelector<HTMLElement>(
      '[data-testid="marked-mcp-activity"]',
    );
    expect(rendered).not.toBeNull();
    expect(rendered?.getAttribute("data-content")).toBe(
      JSON.stringify(invalidMcpContent),
    );
    warn.mockRestore();
  });

  it("skips an unmarked renderer that merely reuses the public MCP Apps schema", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderers.set([
      {
        activityType: "mcp-apps",
        content: MCPAppsActivityContentSchema,
        component: PrimaryActivityRenderer,
      },
    ]);

    const host = render(
      activityMessage({ activityType: "mcp-apps", content: invalidMcpContent }),
    );

    expect(host.querySelector('[data-testid="primary-activity"]')).toBeNull();
    warn.mockRestore();
  });
});
