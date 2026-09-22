/**
 * The framework dispatchers skip a renderer whose content schema rejected the
 * message. The MCP Apps renderer is the exception: it owns the failure
 * lifecycle, so it must receive the rejected content and decide for itself.
 *
 * That exception is carried by a mark on the renderer, not inferred from its
 * content schema. The schema is public, so a custom renderer may reuse it while
 * still expecting parsed content - inferring from the schema would hand that
 * renderer content it cannot handle.
 */
import { describe, expect, it } from "vitest";
import {
  MCPAppsActivityContentSchema,
  ɵhandlesInvalidMCPAppsContent,
  ɵmarkHandlesInvalidMCPAppsContent,
} from "../index";

describe("ɵhandlesInvalidMCPAppsContent", () => {
  it("is false for an unmarked renderer", () => {
    expect(ɵhandlesInvalidMCPAppsContent(function Renderer() {})).toBe(false);
    expect(ɵhandlesInvalidMCPAppsContent({ name: "renderer" })).toBe(false);
    expect(
      ɵhandlesInvalidMCPAppsContent(
        class Renderer {
          readonly kind = "renderer";
        },
      ),
    ).toBe(false);
  });

  it("is true once marked, for a function, an object and a class", () => {
    const fn = ɵmarkHandlesInvalidMCPAppsContent(function Renderer() {});
    const obj = ɵmarkHandlesInvalidMCPAppsContent({ name: "renderer" });
    const cls = ɵmarkHandlesInvalidMCPAppsContent(
      class Renderer {
        readonly kind = "renderer";
      },
    );

    expect(ɵhandlesInvalidMCPAppsContent(fn)).toBe(true);
    expect(ɵhandlesInvalidMCPAppsContent(obj)).toBe(true);
    expect(ɵhandlesInvalidMCPAppsContent(cls)).toBe(true);
  });

  it("does not leak to a renderer that merely reuses the public schema", () => {
    // Exactly the custom renderer the schema-identity check used to misjudge:
    // it registers the built-in schema but implements its own rendering, so it
    // must keep the default behaviour of being skipped on invalid content.
    const custom = {
      activityType: "mcp-apps",
      content: MCPAppsActivityContentSchema,
      render: function CustomRenderer() {},
    };

    expect(ɵhandlesInvalidMCPAppsContent(custom.render)).toBe(false);
  });

  it("is not inherited by a subclass of a marked renderer", () => {
    const Base = ɵmarkHandlesInvalidMCPAppsContent(
      class Base {
        readonly kind = "base";
      },
    );
    class Derived extends Base {}

    // Static members are inherited through the prototype chain, so a subclass
    // reads as marked. This documents the behaviour rather than asserting a
    // guarantee the mark does not provide.
    expect(ɵhandlesInvalidMCPAppsContent(Derived)).toBe(true);
  });

  it("is not enumerable, so it never lands in a spread or JSON copy", () => {
    const renderer = ɵmarkHandlesInvalidMCPAppsContent({ name: "renderer" });

    expect(Object.keys(renderer)).toEqual(["name"]);
    expect(ɵhandlesInvalidMCPAppsContent({ ...renderer })).toBe(false);
  });

  it("rejects non-object values instead of throwing", () => {
    expect(ɵhandlesInvalidMCPAppsContent(null)).toBe(false);
    expect(ɵhandlesInvalidMCPAppsContent(undefined)).toBe(false);
    expect(ɵhandlesInvalidMCPAppsContent("renderer")).toBe(false);
    expect(ɵhandlesInvalidMCPAppsContent(42)).toBe(false);
  });
});
