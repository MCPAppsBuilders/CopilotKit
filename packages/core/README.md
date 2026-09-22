# @copilotkit/core

`@copilotkit/core` is the framework-neutral client for CopilotKit runtimes. It
manages runtime agents, frontend tools, shared context, suggestions, thread
stores, and subscriptions.

## Activity provenance and run closure

An activity renderer has to answer one question before it can react to a bad
result: is this content still streaming, already final, or replayed from
history? Removing a widget on a half-streamed fragment is wrong; leaving a
terminally broken one on screen with no explanation is also wrong. The
information exists in the event stream but is gone by the time a renderer sees
a message, and a renderer cannot reconstruct it: a widget only mounts once its
activity already exists, so it has necessarily missed the event that created
it. Core answers it once, for every `activityType`. Nothing here is specific to
MCP Apps.

```ts
const state = copilotkit.getActivityExchangeState(
  agentId,
  threadId,
  message.id,
  agent,
);
// "pending" | "settled" | "untracked" | "unknown"

const subscription = copilotkit.subscribe({
  onActivityRunSettled: ({ agentId, threadId, runId }) => {
    // re-read the activity: the run can no longer change it
  },
});
```

| State       | Meaning                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`   | The run that last touched the activity through an `ACTIVITY_SNAPSHOT` or `ACTIVITY_DELTA` event is still open.                                                                  |
| `settled`   | That run is over, whichever way it ended.                                                                                                                                       |
| `untracked` | The instance is observed, and no dedicated activity event ever touched this message: it came from `setMessages` or a generic `MESSAGES_SNAPSHOT`, which is how history arrives. |
| `unknown`   | The running agent instance is not the one this core observes, so the absence of a record proves nothing. Consumers treat it like `pending`.                                     |

Why the existing tables could not answer this:

- `messageToRun` associates a message with the run that **created** it and
  never reassigns. An activity created in run A and later patched by run B
  still reads as A, so once A finishes it would report final while B is
  streaming into it. It is also populated from a generic `MESSAGES_SNAPSHOT`,
  which is how replayed history arrives, so it cannot separate history from
  live content. The new `lastActivityEventRun` table is overwritten on every
  dedicated activity event and fed by nothing else, which is what makes "no
  entry" mean "not produced live".
- `activeRun` answers "who owns a message that arrives with no input", and a
  stream that ends without a terminal event deliberately keeps that ownership.
  "Is this run still producing" is a different question, so it has its own
  `openRuns` table, a set per thread because runs can overlap, cleared on every
  exit path including an abort that emits no terminal event.

`onActivityRunSettled` fires exactly once per run closure, on
`RUN_FINISHED`, `RUN_ERROR` and finalization after an abort, with the run id
resolved the way message and state associations resolve it. It exists because a
pull accessor alone never tells a consumer to look again when a run ends
**without changing content**, which is precisely when a provisional result
becomes final.

Coverage is measured on the instance actually running: `isAgentInstanceObserved`
looks for this core's subscription in the instance's own `subscribers` array,
so a clone that inherited the subscription counts as observed and a clone made
before it does not. `isRunActive(agentId, threadId, runId)` exposes the
underlying run tracking.

## Trusted Inspector metadata

When the connected runtime reports `inspectorMetadata: true` in its runtime-info
response, Core loads the optional `InspectorMetadataV1` value in the background.
The runtime connection and agent notifications finish first, so a slow or
unavailable metadata route cannot delay the app.

Core exposes the object returned by Shared normalization unchanged through the
getter and subscriber event. Older runtimes may omit
`usage.expiringSoonCount`; that absence remains valid V1 usage. A value of `0`
means known zero and stays different from absence. Shared omits a malformed
expiry leaf without removing valid `used`, `limit`, or sibling modules. Core
does not calculate or rebuild expiry and does not require a V2 schema.

Read the latest value with `inspectorMetadata`, refresh it without reconnecting,
or subscribe to changes:

```ts
import { CopilotKitCore } from "@copilotkit/core";

const copilotkit = new CopilotKitCore({
  runtimeUrl: "/api/copilotkit",
  headers: { Authorization: "Bearer app-session" },
  credentials: "include",
});

const subscription = copilotkit.subscribe({
  onInspectorMetadataChanged: ({ inspectorMetadata }) => {
    console.log(inspectorMetadata);
  },
});

await copilotkit.refreshInspectorMetadata();
console.log(copilotkit.inspectorMetadata);

subscription.unsubscribe();
```

Core sends the current headers and fetch credentials to the Copilot Runtime. A
call to `setHeaders()` or `setCredentials()` clears the prior value before it
starts a new metadata refresh, so trusted context cannot cross an auth-context
change. Changing the runtime URL or transport, losing the capability, or
disconnecting also clears the value.

Each refresh cancels the prior request and has a five-second deadline. Core also
checks the runtime URL, requested and resolved transport, headers, credentials,
connection, and capability before publishing a response. A stale success or
failure cannot replace metadata from a newer connection. Route, timeout, parse,
and subscriber failures stay isolated from the runtime connection.

See the
[`CopilotKitCore` reference](https://docs.copilotkit.ai/reference/core/classes/CopilotKitCore)
and
[`CopilotKitCoreSubscriber` reference](https://docs.copilotkit.ai/reference/core/types/CopilotKitCoreSubscriber)
for the full API.
