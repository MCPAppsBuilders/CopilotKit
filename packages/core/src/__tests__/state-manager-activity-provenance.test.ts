import { AbstractAgent, EventType } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { Observable, Subject } from "rxjs";
import { describe, expect, it } from "vitest";
import { CopilotKitCore } from "../core";

// Activity provenance and run closure, exercised through the real
// state-manager subscription (no mocked callbacks). Any activity renderer must
// be able to tell "still streaming" from "final" from "loaded history", and a
// run must close exactly once however it ended. Nothing here is specific to a
// given activityType: the fixtures below use one only because a concrete
// value is required.

class ScriptedAgent extends AbstractAgent {
  constructor(
    private readonly events: (input: RunAgentInput) => BaseEvent[],
    agentId: string,
    threadId = "thread-1",
  ) {
    super({ agentId, threadId });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of this.events(input)) subscriber.next(event);
      subscriber.complete();
    });
  }
}

/** An agent whose run stays open until the caller pushes events into it. */
class ControlledAgent extends AbstractAgent {
  readonly streams: Subject<BaseEvent>[] = [];

  constructor(agentId: string, threadId = "thread-1") {
    super({ agentId, threadId });
  }

  run(): Observable<BaseEvent> {
    const stream = new Subject<BaseEvent>();
    this.streams.push(stream);
    return stream;
  }

  /** runAgent() awaits several times before subscribing to run(). */
  async stream(index: number): Promise<Subject<BaseEvent>> {
    for (let attempt = 0; attempt < 50 && !this.streams[index]; attempt++) {
      await Promise.resolve();
    }
    const stream = this.streams[index];
    if (!stream) throw new Error(`stream ${index} was never opened`);
    return stream;
  }
}

/** Let the async event-apply pipeline and its notifications drain. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const runStarted = (threadId: string, runId: string): BaseEvent =>
  ({ type: EventType.RUN_STARTED, threadId, runId }) as BaseEvent;
const runFinished = (threadId: string, runId: string): BaseEvent =>
  ({ type: EventType.RUN_FINISHED, threadId, runId }) as BaseEvent;
const activitySnapshot = (messageId: string): BaseEvent =>
  ({
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId,
    activityType: "test-activity",
    content: { resourceUri: "ui://x", serverHash: "h", result: {} },
  }) as unknown as BaseEvent;
const activityDelta = (messageId: string): BaseEvent =>
  ({
    type: EventType.ACTIVITY_DELTA,
    messageId,
    activityType: "test-activity",
    patch: [{ op: "replace", path: "/serverHash", value: "h2" }],
  }) as unknown as BaseEvent;

function register(core: CopilotKitCore, agent: AbstractAgent): void {
  core.addAgent__unsafe_dev_only({ id: agent.agentId!, agent: agent as never });
}

describe("StateManager activity provenance", () => {
  it("reports an activity produced by a dedicated event as settled once its run is over", async () => {
    const core = new CopilotKitCore({});
    const agent = new ScriptedAgent(
      (input) => [
        runStarted(input.threadId, input.runId),
        activitySnapshot("act-1"),
        runFinished(input.threadId, input.runId),
      ],
      "settled-agent",
    );
    register(core, agent);

    await agent.runAgent({ runId: "run-1" });

    expect(
      core.getActivityExchangeState(
        agent.agentId!,
        agent.threadId,
        "act-1",
        agent,
      ),
    ).toBe("settled");
  });

  it("reports an activity as pending while the run that produced it is still open", async () => {
    const core = new CopilotKitCore({});
    const agent = new ControlledAgent("pending-agent");
    register(core, agent);

    const done = agent.runAgent({ runId: "run-1" });
    const stream = await agent.stream(0);
    stream.next(runStarted(agent.threadId, "run-1"));
    stream.next(activitySnapshot("act-1"));
    await settle();

    expect(
      core.getActivityExchangeState(
        agent.agentId!,
        agent.threadId,
        "act-1",
        agent,
      ),
    ).toBe("pending");

    stream.next(runFinished(agent.threadId, "run-1"));
    stream.complete();
    await done;

    expect(
      core.getActivityExchangeState(
        agent.agentId!,
        agent.threadId,
        "act-1",
        agent,
      ),
    ).toBe("settled");
  });

  it("does not treat an activity carried by a generic MESSAGES_SNAPSHOT as live", async () => {
    const core = new CopilotKitCore({});
    const agent = new ScriptedAgent(
      (input) => [
        runStarted(input.threadId, input.runId),
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [
            {
              id: "history-act",
              role: "activity",
              activityType: "test-activity",
              content: { resourceUri: "ui://old", serverHash: "h", result: {} },
            },
          ],
        } as unknown as BaseEvent,
        runFinished(input.threadId, input.runId),
      ],
      "history-agent",
    );
    register(core, agent);

    await agent.runAgent({ runId: "run-1" });

    // The generic snapshot still associates the message with the run, which is
    // exactly why that association alone cannot answer this question.
    expect(
      core.getRunIdForMessage(agent.agentId!, agent.threadId, "history-act"),
    ).toBe("run-1");
    expect(
      core.getActivityExchangeState(
        agent.agentId!,
        agent.threadId,
        "history-act",
        agent,
      ),
    ).toBe("untracked");
  });

  it("follows the run that last touched an activity, not the one that created it", async () => {
    const core = new CopilotKitCore({});
    const agent = new ControlledAgent("last-toucher-agent");
    register(core, agent);

    // Run A creates the activity, then finishes.
    const runA = agent.runAgent({ runId: "run-A" });
    const streamA = await agent.stream(0);
    streamA.next(runStarted(agent.threadId, "run-A"));
    streamA.next(activitySnapshot("act-1"));
    streamA.next(runFinished(agent.threadId, "run-A"));
    streamA.complete();
    await runA;

    expect(
      core.getActivityExchangeState(
        agent.agentId!,
        agent.threadId,
        "act-1",
        agent,
      ),
    ).toBe("settled");

    // Run B patches the SAME activity and stays open. messageToRun still says
    // A (create-once), so anything keyed off it would wrongly read "settled".
    const runB = agent.runAgent({ runId: "run-B" });
    const streamB = await agent.stream(1);
    streamB.next(runStarted(agent.threadId, "run-B"));
    streamB.next(activityDelta("act-1"));
    await settle();

    expect(
      core.getRunIdForMessage(agent.agentId!, agent.threadId, "act-1"),
    ).toBe("run-A");
    expect(
      core.getActivityExchangeState(
        agent.agentId!,
        agent.threadId,
        "act-1",
        agent,
      ),
    ).toBe("pending");

    streamB.next(runFinished(agent.threadId, "run-B"));
    streamB.complete();
    await runB;
  });
});

describe("StateManager instance coverage", () => {
  it("counts a clone that inherited the subscription as observed", async () => {
    const core = new CopilotKitCore({});
    const source = new ScriptedAgent(() => [], "clone-after-agent");
    register(core, source);

    // Cloned after the subscription exists: AbstractAgent.clone() copies the
    // subscribers array, so the clone receives the same callbacks.
    const clone = source.clone();
    Object.defineProperty(clone, "run", {
      value: (input: RunAgentInput) =>
        new Observable<BaseEvent>((subscriber) => {
          subscriber.next(runStarted(input.threadId, input.runId));
          subscriber.next(activitySnapshot("act-1"));
          subscriber.next(runFinished(input.threadId, input.runId));
          subscriber.complete();
        }),
    });

    expect(core.isAgentInstanceObserved(clone.agentId!, clone)).toBe(true);

    await clone.runAgent({ runId: "run-1" });

    expect(
      core.getActivityExchangeState(
        clone.agentId!,
        clone.threadId,
        "act-1",
        clone,
      ),
    ).toBe("settled");
  });

  it("reports unknown, never untracked, for an instance it does not observe", async () => {
    const core = new CopilotKitCore({});
    const source = new ScriptedAgent(() => [], "clone-before-agent");

    // Cloned BEFORE the subscription: its subscribers array is a separate,
    // empty copy and can never pick the subscription up afterwards.
    const clone = source.clone();
    register(core, source);

    Object.defineProperty(clone, "run", {
      value: (input: RunAgentInput) =>
        new Observable<BaseEvent>((subscriber) => {
          subscriber.next(runStarted(input.threadId, input.runId));
          subscriber.next(activitySnapshot("act-1"));
          subscriber.next(runFinished(input.threadId, input.runId));
          subscriber.complete();
        }),
    });

    await clone.runAgent({ runId: "run-1" });

    expect(core.isAgentInstanceObserved(clone.agentId!, clone)).toBe(false);
    // Crucially NOT "untracked": nothing was observed, so nothing is proven,
    // a caller must keep waiting rather than remove a possibly-live widget.
    expect(
      core.getActivityExchangeState(
        clone.agentId!,
        clone.threadId,
        "act-1",
        clone,
      ),
    ).toBe("unknown");
  });
});

describe("StateManager run closure", () => {
  it("closes a normal run once and reports it settled", async () => {
    const core = new CopilotKitCore({});
    const agent = new ScriptedAgent(
      (input) => [
        runStarted(input.threadId, input.runId),
        runFinished(input.threadId, input.runId),
      ],
      "close-normal-agent",
    );
    register(core, agent);

    const settled: string[] = [];
    core.subscribe({
      onActivityRunSettled: ({ runId }) => {
        settled.push(runId);
      },
    });

    await agent.runAgent({ runId: "run-1" });
    await settle();

    expect(settled).toEqual(["run-1"]);
    expect(core.isRunActive(agent.agentId!, agent.threadId, "run-1")).toBe(
      false,
    );
  });

  it("closes a run that ended with RUN_ERROR", async () => {
    const core = new CopilotKitCore({});
    const agent = new ScriptedAgent(
      (input) => [
        runStarted(input.threadId, input.runId),
        {
          type: EventType.RUN_ERROR,
          message: "boom",
          code: "abort",
        } as BaseEvent,
      ],
      "close-error-agent",
    );
    register(core, agent);

    const settled: string[] = [];
    core.subscribe({
      onActivityRunSettled: ({ runId }) => {
        settled.push(runId);
      },
    });

    await agent.runAgent({ runId: "run-1" });
    await settle();

    expect(settled).toEqual(["run-1"]);
    expect(core.isRunActive(agent.agentId!, agent.threadId, "run-1")).toBe(
      false,
    );
  });

  it("closes a run that was detached without a terminal event", async () => {
    const core = new CopilotKitCore({});
    const agent = new ControlledAgent("close-detach-agent");
    register(core, agent);

    const settled: string[] = [];
    core.subscribe({
      onActivityRunSettled: ({ runId }) => {
        settled.push(runId);
      },
    });

    const running = agent.runAgent({ runId: "run-1" });
    (await agent.stream(0)).next(runStarted(agent.threadId, "run-1"));
    await settle();
    expect(core.isRunActive(agent.agentId!, agent.threadId, "run-1")).toBe(
      true,
    );

    await agent.detachActiveRun();
    await running;
    await settle();

    expect(settled).toEqual(["run-1"]);
    expect(core.isRunActive(agent.agentId!, agent.threadId, "run-1")).toBe(
      false,
    );
  });

  it("keeps overlapping runs independent: starting B neither settles A's activity nor swallows A's close", async () => {
    const core = new CopilotKitCore({});
    const agent = new ControlledAgent("overlap-agent");
    register(core, agent);

    const settled: string[] = [];
    core.subscribe({
      onActivityRunSettled: ({ runId }) => {
        settled.push(runId);
      },
    });

    const runA = agent.runAgent({ runId: "run-A" });
    const streamA = await agent.stream(0);
    streamA.next(runStarted(agent.threadId, "run-A"));
    await settle();

    // B starts while A is still producing.
    const runB = agent.runAgent({ runId: "run-B" });
    const streamB = await agent.stream(1);
    streamB.next(runStarted(agent.threadId, "run-B"));
    await settle();

    // A goes on producing: its activity must read as still pending, not as
    // settled just because a newer run also exists.
    streamA.next(activitySnapshot("act-from-A"));
    await settle();
    expect(core.isRunActive(agent.agentId!, agent.threadId, "run-A")).toBe(
      true,
    );
    expect(
      core.getActivityExchangeState(
        agent.agentId!,
        agent.threadId,
        "act-from-A",
        agent,
      ),
    ).toBe("pending");

    // A finishes: it must close itself and be reported, without touching B.
    streamA.next(runFinished(agent.threadId, "run-A"));
    streamA.complete();
    await runA;
    await settle();

    expect(settled).toContain("run-A");
    expect(settled).not.toContain("run-B");
    expect(core.isRunActive(agent.agentId!, agent.threadId, "run-B")).toBe(
      true,
    );
    expect(
      core.getActivityExchangeState(
        agent.agentId!,
        agent.threadId,
        "act-from-A",
        agent,
      ),
    ).toBe("settled");

    streamB.next(runFinished(agent.threadId, "run-B"));
    streamB.complete();
    await runB;
  });

  it("closes the runs of a replaced instance so a resumed activity cannot stay pending", async () => {
    const core = new CopilotKitCore({});
    const first = new ControlledAgent("replaced-agent");
    const replacement = new ControlledAgent("replaced-agent");
    register(core, first);

    const settled: string[] = [];
    // What a consumer reading state from inside the notification would see.
    const stateSeenInCallback: string[] = [];
    core.subscribe({
      onActivityRunSettled: ({ runId }) => {
        settled.push(runId);
        stateSeenInCallback.push(
          core.getActivityExchangeState(
            "replaced-agent",
            first.threadId,
            "act-1",
            replacement,
          ),
        );
      },
    });

    const running = first.runAgent({ runId: "run-1" });
    const stream = await first.stream(0);
    stream.next(runStarted(first.threadId, "run-1"));
    stream.next(activitySnapshot("act-1"));
    await settle();
    expect(
      core.getActivityExchangeState(
        first.agentId!,
        first.threadId,
        "act-1",
        first,
      ),
    ).toBe("pending");

    // A new instance takes over the same agentId mid-run. The old instance's
    // callbacks are revoked, so its run can never close itself.
    register(core, replacement);
    await settle();

    expect(settled).toContain("run-1");
    // Read from inside the notification, not merely afterwards: the new
    // subscription must already be registered, or this reads "unknown" and
    // nothing ever corrects it.
    expect(stateSeenInCallback).toEqual(["settled"]);
    expect(core.isRunActive(first.agentId!, first.threadId, "run-1")).toBe(
      false,
    );
    // Same conversation and message ids resumed on the observed instance: the
    // activity must read as settled, not inherit a run that never ends.
    expect(
      core.getActivityExchangeState(
        replacement.agentId!,
        replacement.threadId,
        "act-1",
        replacement,
      ),
    ).toBe("settled");

    stream.complete();
    await running;
  });

  it("scopes cleanup to one agent even when another agent's id starts with it", async () => {
    const core = new CopilotKitCore({});
    // `foo` is a prefix of `foo:bar`: a flat `${agentId}:${threadId}` key would
    // make cleaning up the first also match (and close) the second's runs.
    const foo = new ControlledAgent("foo");
    const fooBar = new ControlledAgent("foo:bar");
    register(core, foo);
    register(core, fooBar);

    const settled: { agentId: string; threadId: string; runId: string }[] = [];
    core.subscribe({
      onActivityRunSettled: (event) => {
        settled.push({
          agentId: event.agentId,
          threadId: event.threadId,
          runId: event.runId,
        });
      },
    });

    const runFoo = foo.runAgent({ runId: "run-foo" });
    (await foo.stream(0)).next(runStarted(foo.threadId, "run-foo"));
    const runFooBar = fooBar.runAgent({ runId: "run-foo-bar" });
    (await fooBar.stream(0)).next(runStarted(fooBar.threadId, "run-foo-bar"));
    await settle();

    core.removeAgent__unsafe_dev_only("foo");
    await settle();

    expect(settled).toEqual([
      { agentId: "foo", threadId: foo.threadId, runId: "run-foo" },
    ]);
    expect(core.isRunActive("foo", foo.threadId, "run-foo")).toBe(false);
    expect(core.isRunActive("foo:bar", fooBar.threadId, "run-foo-bar")).toBe(
      true,
    );

    (await foo.stream(0)).complete();
    (await fooBar.stream(0)).complete();
    await Promise.all([runFoo, runFooBar]);
  });

  it("does not let a late finalization of an older run close a newer one", async () => {
    const core = new CopilotKitCore({});
    const agent = new ControlledAgent("late-finalize-agent");
    register(core, agent);

    const settled: string[] = [];
    core.subscribe({
      onActivityRunSettled: ({ runId }) => {
        settled.push(runId);
      },
    });

    // A starts and stays open.
    const runA = agent.runAgent({ runId: "run-A" });
    const streamA = await agent.stream(0);
    streamA.next(runStarted(agent.threadId, "run-A"));
    await settle();

    // B starts while A is still in flight and takes over the thread's slot.
    const runB = agent.runAgent({ runId: "run-B" });
    const streamB = await agent.stream(1);
    streamB.next(runStarted(agent.threadId, "run-B"));
    await settle();
    expect(core.isRunActive(agent.agentId!, agent.threadId, "run-B")).toBe(
      true,
    );

    // A now finalizes, late. Resolving its callbacks off the subscription's
    // mutable subRunId would name B here and close the wrong run.
    streamA.complete();
    await runA;
    await settle();

    expect(core.isRunActive(agent.agentId!, agent.threadId, "run-B")).toBe(
      true,
    );
    expect(settled).not.toContain("run-B");

    streamB.next(runFinished(agent.threadId, "run-B"));
    streamB.complete();
    await runB;
  });
});
