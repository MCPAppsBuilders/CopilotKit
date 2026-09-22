# @copilotkit/mcp-apps-renderer

Framework-agnostic MCP Apps host for CopilotKit: the app↔host protocol on top of
[`@modelcontextprotocol/ext-apps`](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
(AppBridge + PostMessage transport, sandbox proxy, per-thread request queue,
`ui/message` / `ui/open-link` / `tools/call` proxy, tool input/result forwarding,
`ui/request-display-mode`). The React / Vue / Angular renderers consume it as thin
adapters: they create the sandbox iframe and wire reactive state, while all
protocol logic lives in `bindMcpApp`.

## Entry points

| Import                                   | Contents                                                                 | Bundle                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `@copilotkit/mcp-apps-renderer`          | `bindMcpApp` + the full session API                                      | **ESM only** — it wraps the ESM-only ext-apps bridge, and is meant to be loaded lazily via a dynamic `import()`. |
| `@copilotkit/mcp-apps-renderer/activity` | `MCPAppsActivityType`, `MCPAppsActivityContentSchema`, `ɵrunMcpFollowUp` | ESM + CJS. Bridge-free: importing it to register the activity does **not** pull the ext-apps bundle.             |

The root is ESM-only on purpose: `@modelcontextprotocol/ext-apps` ships ESM only,
so a CommonJS root would emit a `require()` of an ES module and fail with
`ERR_REQUIRE_ESM`. Consume `bindMcpApp` via a dynamic `import()` (which resolves
ESM from any module system), and import the bridge-free `/activity` surface for
synchronous activity registration.

## Script-tag / UMD usage

This package also ships a UMD build of the bridge-free `/activity` entry:
`dist/activity.umd.js`, which defines the global
`CopilotKitMcpAppsRendererActivity`.

`@copilotkit/react-core`'s UMD build references that global (it externalizes
`@copilotkit/mcp-apps-renderer/activity` to register the built-in MCP Apps
activity). **Script-tag consumers of react-core's UMD must therefore load
`activity.umd.js` before `@copilotkit/react-core`'s UMD bundle**, alongside the
other UMD globals it depends on (React, `CopilotKitCore`,
`CopilotKitA2UIRenderer`, …):

```html
<!-- ...React, @copilotkit/core, @copilotkit/a2ui-renderer, etc. first... -->
<script src="https://unpkg.com/@copilotkit/mcp-apps-renderer/dist/activity.umd.js"></script>
<script src="https://unpkg.com/@copilotkit/react-core/dist/index.umd.js"></script>
```

Only the bridge-free `/activity` surface has a UMD build; the ext-apps bridge
itself (`bindMcpApp`) is loaded lazily via `import()` and is not part of the UMD
graph, so it only loads when an MCP App is actually rendered.

## Failure lifecycle

When an MCP Apps result cannot be used, three things happen and none depends on
the others: the widget comes off screen, the activity is removed from the
agent's message store when it lives there, and the agent is asked to explain
the failure to the user. This package owns the decision and its timing; the
React, Vue and Angular renderers only own the DOM and reflect the state.

### What counts as a failure

| Situation                                            | Widget                                   | Report to the agent              |
| ---------------------------------------------------- | ---------------------------------------- | -------------------------------- |
| Content still streaming, or the run is still open    | Kept as is (mounted once identity known) | None                             |
| Valid result, `isError: false`                       | Forwarded                                | None                             |
| Terminal content the schema rejects                  | Removed                                  | One message, one run             |
| Valid result with `isError: true`, on the activity   | Removed                                  | One message, one run             |
| `tools/call` result the schema rejects, or `isError` | Answered first, then removed             | One message, one run             |
| Content replayed from history (`untracked`)          | Removed if invalid                       | None: history never starts a run |
| Instance the core does not observe (`unknown`)       | Kept, like `pending`                     | None                             |

`isError: true` is a valid result that expresses a tool failure, not a schema
rejection. It retires the widget on both paths and is reported on both.
Driving the real demo in a browser showed the model seeing the error in its own
run and saying nothing, so the user was left with a vanished widget and no
reason; a possibly redundant sentence is a smaller cost than that silence. A
proxied `tools/call` never reaches the model at all (`MCPAppsMiddleware`
answers it without a model turn), so its failure is news in every case.

The report is a `developer`-role message: a bounded description of the failure
(codes and paths, never the payload or server text) plus the instruction to
tell the user this part of the answer could not be shown, followed by one agent
run so the explanation is written into the conversation. That run goes through
the shared MCP request queue, so it never overlaps a proxied request or another
explanation for the same agent; a widget mounting while an explanation runs
fetches its resource once that run is over. See
[Agent requirements](#agent-requirements): a `BuiltInAgent` drops `developer`
messages unless told to forward them.

### Two independent cycles

```text
widget:  waiting -> active -> retiring -> removed
report:  reserved -> message-added -> explained
```

- `waiting`: no usable identity (`resourceUri` + `serverHash`) yet, nothing to
  mount. `active`: mounted; incomplete fragments keep the instance. `retiring`:
  terminally decided, but a `tools/call` response is still owed to the widget.
  `removed`: gone, terminal for this exchange.
- `reserved`: a report is owed. `message-added`: the message is in the
  conversation, with its id, so a failed run can be retried without adding a
  second one. `explained`: the run completed.

A widget is removed whether or not anything is ever explained, and a failed
explanation run never brings it back. The reservation is claimed synchronously
so two concurrent commits cannot both queue work; once claimed, the report is
owned by that claim until it completes, not by the session that started it.

### When a verdict becomes final: the exchange state

A schema rejection on a fragment that is still streaming is provisional. The
session decides only against the **exchange state** the host supplies through
`getExchangeState`, sourced from `CopilotKitCore.getActivityExchangeState`:

| State       | Meaning                                                 | Effect                       |
| ----------- | ------------------------------------------------------- | ---------------------------- |
| `pending`   | The run that last touched this activity is still open   | Keep, never report           |
| `settled`   | That run is over                                        | Decide and report if invalid |
| `untracked` | No dedicated activity event ever touched it: history    | Remove if invalid, no report |
| `unknown`   | The running agent instance is not observed by this core | Exactly like `pending`       |

Two moments trigger a look at the current content: every content change, and
the end of the run (`subscribeRunSettled`, sourced from the core's
`onActivityRunSettled`). The second exists because a run can end without
changing content, which is precisely when a provisional fragment becomes a
final, invalid one. The session also observes once at bind time, before it
loads anything, so an activity that is already terminal when its component
mounts (a history reload, a run that ended before the mount) is decided even
if the resource fetch then fails and the widget never initializes. The load is
started only when the controller allows the mount.

Without a `getExchangeState` callback the state reads `unknown`: the widget is
kept and nothing is reported. The three shipped renderers wire it.

### Proxy failures: the response goes out first

For a failing `tools/call`, the widget is still owed an answer to its own
request. Removal, store mutation and the explanation run all wait until the
transport has actually sent the response: `session.ts` wraps the
`PostMessageTransport.send` it constructs and resolves a waiter for the
response's own JSON-RPC id, or rejects it if the send throws. An abort of the
request (`extra.signal`) releases the reservation instead of reporting: nothing
was delivered, so nothing is explained. A teardown while the answer is pending
is a cancellation too; it concludes the retirement synchronously, so a
replacement session binding in the same turn finds `removed` rather than an
orphaned `retiring`.

Limit: `postMessage` does not fail when the target window is gone, so "sent"
means the transport emitted the response, not that the widget processed it.

### Identity, remounts and retention

Failure state is kept per **exchange**: agent, thread, activity (its store
message id, or the stable key an external host supplies) and the widget's
resource identity (`resourceUri`, `serverHash`, `serverId`). A remount of the
same exchange finds its previous verdict: a removed widget stays removed, an
owed report stays owed, an explanation run already in flight still records its
outcome. A different resource for the same activity is a new exchange with its
own cycle. Each shipped renderer records removal against that identity, so the
same activity mounts again when the agent answers with a different widget.

Terminal markers (`explained`, `message-added`) are never evicted for size:
they are what stops a removed widget from coming back when the same activity is
re-introduced by a persisted-history reload. Only removed entries carrying no
report may be forgotten under pressure. Their lifetime is currently the page
session; tying it to conversation deletion is the next retention step.

### Agent requirements

The report is a `developer`-role message. `BuiltInAgent` drops `developer`
messages before they reach the model unless `forwardDeveloperMessages: true` is
set, in which case they are forwarded as system messages:

```ts
const agent = new BuiltInAgent({
  model: "openai:gpt-5.4-mini",
  forwardDeveloperMessages: true,
});
```

Without it the widget is still removed and the message is still added to the
conversation, but the model never sees it and the user gets no explanation.
The role is deliberately not `user`: that would make the model believe the
user is talking about errors. A custom agent must forward `developer` messages
to its model for the explanation to happen; the rest of the lifecycle does not
depend on it.

### Dispatch: only the marked renderer receives rejected content

A framework dispatcher normally skips a renderer whose content schema rejected
the message. The built-in MCP Apps renderer is the exception, because dropping
it there would mean the widget never mounts and nothing could ever decide
whether the content was mid-stream, retire it, or explain its absence. The
exception is carried by a mark on the renderer
(`ɵmarkHandlesInvalidMCPAppsContent`, checked with
`ɵhandlesInvalidMCPAppsContent`), never inferred from the content schema:
`MCPAppsActivityContentSchema` is public, and a custom renderer that reuses it
still expects parsed content.
