import type { AbstractAgent, RunAgentResult } from "@ag-ui/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCPAppsActivityContentSchema } from "../content-schema";
import {
  getWidgetController,
  ɵresetWidgetControllers,
} from "../widget-controller";
import type {
  McpControllerHost,
  McpExchangeState,
  McpObservation,
  McpWidgetController,
} from "../widget-controller";

// The controller owns two independent cycles: what the adapter shows (waiting →
// active → retiring → removed) and whether the agent is told (reserved →
// message-added → explained). Removal must never wait on the report, and the
// report must never happen twice.

interface FakeAgent {
  agentId: string;
  threadId: string;
  messages: { id: string; role: string; content: string }[];
  addMessage(message: { id: string; role: string; content: string }): void;
  setMessages(messages: { id: string; role: string; content: string }[]): void;
  isRunning: boolean;
  subscribe(subscriber: { onRunFinalized?: () => void }): {
    unsubscribe(): void;
  };
  /** Hold the request queue, then release it, to test work waiting in line. */
  holdQueue(): void;
  releaseQueue(): void;
}

function fakeAgent(threadId = "thread-1"): FakeAgent & AbstractAgent {
  const subscribers = new Set<{ onRunFinalized?: () => void }>();
  const agent: FakeAgent = {
    agentId: "agent-1",
    threadId,
    messages: [],
    isRunning: false,
    addMessage(message) {
      agent.messages.push(message);
    },
    setMessages(messages) {
      agent.messages = messages;
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return {
        unsubscribe() {
          subscribers.delete(subscriber);
        },
      };
    },
    holdQueue() {
      agent.isRunning = true;
    },
    releaseQueue() {
      agent.isRunning = false;
      for (const subscriber of [...subscribers]) subscriber.onRunFinalized?.();
    },
  };
  return agent as unknown as FakeAgent & AbstractAgent;
}

/** Let queued work reach its next checkpoint. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function hostThat(
  run: () => Promise<RunAgentResult> = async () => ({
    result: undefined,
    newMessages: [],
  }),
): McpControllerHost & { calls: number } {
  const host = {
    calls: 0,
    async runAgent() {
      host.calls++;
      return run();
    },
  };
  return host;
}

const validContent = {
  resourceUri: "ui://widget",
  serverHash: "hash",
  result: { content: [] },
};
const toolErrorContent = {
  ...validContent,
  result: { content: [], isError: true },
};
const invalidContent = { resourceUri: "ui://widget" }; // no serverHash, no result

const activity = (
  content: unknown,
  exchange: McpExchangeState,
  identityAvailable = true,
): McpObservation => ({
  origin: "activity",
  content,
  exchange,
  identityAvailable,
});

const proxy = (
  result: unknown,
  exchange: McpExchangeState = "settled",
): McpObservation => ({
  origin: "proxy",
  parsed: MCPAppsActivityContentSchema.shape.result.safeParse(result),
  exchange,
  identityAvailable: true,
});

describe("widget controller phases", () => {
  let agent: AbstractAgent;
  let controller: McpWidgetController;
  let generation: number;

  beforeEach(() => {
    agent = fakeAgent();
    ɵresetWidgetControllers(agent);
    controller = getWidgetController({
      agent,
      threadId: "thread-1",
      activityKey: "act-1",
    });
    generation = controller.acquire("widget-a");
  });

  it("stays waiting while the identity needed to mount is missing", () => {
    expect(
      controller.observe(generation, activity(validContent, "pending", false)),
    ).toBe("waiting");
    expect(
      controller.observe(
        generation,
        activity(invalidContent, "pending", false),
      ),
    ).toBe("waiting");
  });

  it("mounts once the identity is available and keeps the instance through fragments", () => {
    expect(
      controller.observe(generation, activity(validContent, "pending")),
    ).toBe("active");
    // A fragment that does not yet parse is provisional, not a reason to unmount.
    expect(
      controller.observe(generation, activity(invalidContent, "pending")),
    ).toBe("active");
    expect(controller.signal).toBeUndefined();
  });

  it("treats unknown coverage exactly like pending, never as grounds to remove", () => {
    expect(
      controller.observe(generation, activity(invalidContent, "unknown")),
    ).toBe("active");
    expect(controller.signal).toBeUndefined();
  });

  it("removes a settled invalid activity and reserves a report", () => {
    expect(
      controller.observe(generation, activity(invalidContent, "settled")),
    ).toBe("removed");
    expect(controller.signal).toBe("reserved");
  });

  it("removes a settled activity whose tool errored AND reserves a report", () => {
    // Driving the real demo showed the model seeing a tool error and saying
    // nothing, leaving the user with a widget that vanished and no reason. The
    // user has to be told, even at the cost of a possibly redundant sentence.
    expect(
      controller.observe(generation, activity(toolErrorContent, "settled")),
    ).toBe("removed");
    expect(controller.signal).toBe("reserved");
  });

  it("removes an untracked invalid activity visually but never reports it", () => {
    expect(
      controller.observe(generation, activity(invalidContent, "untracked")),
    ).toBe("removed");
    expect(controller.signal).toBeUndefined();
  });

  it("keeps a settled valid activity mounted", () => {
    expect(
      controller.observe(generation, activity(validContent, "settled")),
    ).toBe("active");
  });

  it("holds a failed proxy result at retiring until the caller finalizes", () => {
    expect(
      controller.observe(generation, proxy({ content: [], isError: true })),
    ).toBe("retiring");
    expect(controller.signal).toBe("reserved");

    controller.finalizeRemoval(generation);
    expect(controller.phase).toBe("removed");
  });

  it("reports a proxy failure even when the same failure on the activity path would not", () => {
    // A proxied call never reaches the model, so its error is news.
    controller.observe(generation, proxy({ content: [], isError: true }));
    expect(controller.signal).toBe("reserved");
  });

  it("ignores every later observation once removed, including a valid one", () => {
    controller.observe(generation, activity(invalidContent, "settled"));
    expect(controller.phase).toBe("removed");

    expect(
      controller.observe(generation, activity(validContent, "settled")),
    ).toBe("removed");
  });

  it("ignores observations quoting a stale generation", () => {
    controller.observe(generation, activity(validContent, "pending"));
    const next = controller.acquire("widget-b");
    expect(next).not.toBe(generation);

    expect(
      controller.observe(generation, activity(invalidContent, "settled")),
    ).toBe("waiting");
    expect(controller.signal).toBeUndefined();
  });

  it("starts a fresh exchange for a new identity, leaving the removed widget behind", () => {
    controller.observe(generation, activity(invalidContent, "settled"));
    expect(controller.phase).toBe("removed");

    const next = controller.acquire("widget-b");
    expect(controller.phase).toBe("waiting");
    expect(controller.observe(next, activity(validContent, "pending"))).toBe(
      "active",
    );
  });

  it("releases a reservation the outgoing exchange never committed when a new identity takes over", () => {
    controller.observe(generation, activity(invalidContent, "settled"));
    expect(controller.signal).toBe("reserved");

    controller.acquire("widget-b");
    expect(controller.signal).toBeUndefined();
  });

  it("keeps a removed widget removed when the same exchange is acquired again (remount)", () => {
    controller.observe(generation, activity(invalidContent, "settled"));
    expect(controller.phase).toBe("removed");
    expect(controller.signal).toBe("reserved");

    // The adapter re-rendered the same activity with the same resource. That
    // is a remount, not a new exchange: nothing about the verdict changes.
    const remounted = controller.acquire("widget-a");
    expect(remounted).not.toBe(generation);
    expect(controller.phase).toBe("removed");
    expect(controller.signal).toBe("reserved");
    expect(controller.reason).toBeDefined();

    // A late valid observation from the remounted session changes nothing.
    expect(
      controller.observe(remounted, activity(validContent, "settled")),
    ).toBe("removed");
  });

  it("keeps an untracked removal across a remount, so reloaded history stays clean", () => {
    controller.observe(generation, activity(invalidContent, "untracked"));
    expect(controller.phase).toBe("removed");

    const remounted = controller.acquire("widget-a");
    expect(controller.phase).toBe("removed");
    expect(
      controller.observe(remounted, activity(validContent, "pending")),
    ).toBe("removed");
  });

  it("keeps a proxy retirement across a remount, so an external widget cannot reappear", () => {
    controller.observe(generation, proxy({ content: [], isError: true }));
    controller.finalizeRemoval(generation);
    expect(controller.phase).toBe("removed");

    // An unchanged external prop re-renders the same widget.
    const remounted = controller.acquire("widget-a");
    expect(controller.phase).toBe("removed");
    expect(
      controller.observe(remounted, activity(validContent, "settled")),
    ).toBe("removed");
  });

  it("lets the generation that started a proxy retirement conclude it after a same-exchange remount", () => {
    controller.observe(generation, proxy({ content: [], isError: true }));
    expect(controller.phase).toBe("retiring");
    expect(controller.signal).toBe("reserved");

    // The response is still on its way out when the same widget remounts.
    controller.acquire("widget-a");
    expect(controller.phase).toBe("retiring");

    // The response's own path, quoting the generation it started under, is
    // still the one that concludes: it may release the reservation it made...
    controller.abandonSignal(generation);
    expect(controller.signal).toBeUndefined();
    // ...and finish the retirement.
    controller.finalizeRemoval(generation);
    expect(controller.phase).toBe("removed");
  });

  it("does not let a superseded proxy retirement conclude a new exchange's own", () => {
    controller.observe(generation, proxy({ content: [], isError: true }));
    expect(controller.phase).toBe("retiring");

    // A different resource takes over, and its own proxy call also retires.
    const next = controller.acquire("widget-b");
    expect(controller.phase).toBe("waiting");
    controller.observe(next, proxy({ content: [], isError: true }));
    expect(controller.phase).toBe("retiring");

    // The old exchange's response finally settling must not touch it.
    controller.finalizeRemoval(generation);
    expect(controller.phase).toBe("retiring");
    controller.abandonSignal(generation);
    expect(controller.signal).toBe("reserved");

    controller.finalizeRemoval(next);
    expect(controller.phase).toBe("removed");
  });

  it("finalizeRemoval is idempotent and ignores a stale generation", () => {
    controller.observe(generation, proxy({ content: [], isError: true }));
    controller.finalizeRemoval(generation);
    controller.finalizeRemoval(generation);
    expect(controller.phase).toBe("removed");

    const next = controller.acquire("widget-b");
    controller.observe(next, proxy({ content: [], isError: true }));
    controller.finalizeRemoval(generation); // stale
    expect(controller.phase).toBe("retiring");
  });
});

describe("widget controller signalling", () => {
  let agent: FakeAgent & AbstractAgent;
  let controller: McpWidgetController;
  let generation: number;

  beforeEach(() => {
    agent = fakeAgent();
    ɵresetWidgetControllers(agent);
    controller = getWidgetController({
      agent,
      threadId: "thread-1",
      activityKey: "act-1",
    });
    generation = controller.acquire("widget-a");
    controller.observe(generation, activity(invalidContent, "settled"));
  });

  it("removes from the store, adds one message and runs the agent", async () => {
    const host = hostThat();
    const removeFromStore = vi.fn();

    await controller.commitSignal(generation, host, removeFromStore);

    expect(removeFromStore).toHaveBeenCalledTimes(1);
    expect(agent.messages).toHaveLength(1);
    expect(agent.messages[0]!.role).toBe("developer");
    expect(host.calls).toBe(1);
    expect(controller.signal).toBe("explained");
  });

  it("does nothing without a reservation", async () => {
    const host = hostThat();
    await controller.commitSignal(generation, host);
    await controller.commitSignal(generation, host); // already explained

    expect(host.calls).toBe(1);
    expect(agent.messages).toHaveLength(1);
  });

  it("refuses to mutate a thread the agent has left, and releases the reservation", async () => {
    const host = hostThat();
    agent.threadId = "thread-2";

    await controller.commitSignal(generation, host);

    expect(agent.messages).toHaveLength(0);
    expect(host.calls).toBe(0);
    expect(controller.signal).toBeUndefined();
  });

  it("keeps the message on a failed run so a retry resends without duplicating it", async () => {
    const failing = hostThat(async () => {
      throw new Error("run failed");
    });

    await expect(controller.commitSignal(generation, failing)).rejects.toThrow(
      "run failed",
    );
    expect(agent.messages).toHaveLength(1);
    expect(controller.signal).toBe("message-added");

    const succeeding = hostThat();
    await controller.retryExplanation(generation, succeeding);

    expect(agent.messages).toHaveLength(1); // not re-added
    expect(succeeding.calls).toBe(1);
    expect(controller.signal).toBe("explained");
  });

  it("collapses concurrent retries into one", async () => {
    const failing = hostThat(async () => {
      throw new Error("run failed");
    });
    await expect(controller.commitSignal(generation, failing)).rejects.toThrow(
      "run failed",
    );

    let release: (() => void) | undefined;
    const slow = hostThat(
      () =>
        new Promise<RunAgentResult>((resolve) => {
          release = () => resolve({ result: undefined, newMessages: [] });
        }),
    );

    const first = controller.retryExplanation(generation, slow);
    const second = controller.retryExplanation(generation, slow);
    // The run only starts once the queue reaches it, so wait for the host to
    // actually be in flight before releasing it.
    for (let attempt = 0; attempt < 50 && !release; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release?.();
    await Promise.all([first, second]);

    expect(slow.calls).toBe(1);
  });

  it("produces one message and one run when two commits race", async () => {
    const host = hostThat();
    const removeFromStore = vi.fn();

    await Promise.all([
      controller.commitSignal(generation, host, removeFromStore),
      controller.commitSignal(generation, host, removeFromStore),
    ]);

    expect(agent.messages).toHaveLength(1);
    expect(host.calls).toBe(1);
    expect(removeFromStore).toHaveBeenCalledTimes(1);
    expect(controller.signal).toBe("explained");
  });

  it("does not mutate the conversation when a new exchange supersedes work waiting in the queue", async () => {
    const host = hostThat();
    const removeFromStore = vi.fn();

    agent.holdQueue();
    const commit = controller.commitSignal(generation, host, removeFromStore);
    await settle();

    // A new exchange starts while the commit is still queued.
    controller.acquire("widget-b");

    agent.releaseQueue();
    await commit;
    await settle();

    expect(removeFromStore).not.toHaveBeenCalled();
    expect(agent.messages).toHaveLength(0);
    expect(host.calls).toBe(0);
  });

  it("does not write the outcome of a run a new exchange superseded while it was in flight", async () => {
    let release: (() => void) | undefined;
    const slow = hostThat(
      () =>
        new Promise<RunAgentResult>((resolve) => {
          release = () => resolve({ result: undefined, newMessages: [] });
        }),
    );

    const commit = controller.commitSignal(generation, slow);
    for (let attempt = 0; attempt < 50 && !release; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(agent.messages).toHaveLength(1);

    // The exchange is replaced while the explanation run is still going.
    const next = controller.acquire("widget-b");
    release?.();
    await commit;
    await settle();

    // The superseded run must not stamp "explained" onto the new exchange.
    expect(controller.signal).toBeUndefined();
    expect(controller.phase).toBe("waiting");
    // And the new generation is free to reserve and commit on its own.
    controller.observe(next, activity(invalidContent, "settled"));
    expect(controller.signal).toBe("reserved");
  });

  it("lets a remounted session commit a report the unmounted one reserved but never committed", async () => {
    // beforeEach reserved on `generation`; that component unmounts before it
    // ever commits. The same widget mounts again.
    const remounted = controller.acquire("widget-a");
    expect(controller.signal).toBe("reserved");

    const host = hostThat();
    const removeFromStore = vi.fn();
    await controller.commitSignal(remounted, host, removeFromStore);

    expect(removeFromStore).toHaveBeenCalledTimes(1);
    expect(agent.messages).toHaveLength(1);
    expect(host.calls).toBe(1);
    expect(controller.signal).toBe("explained");
  });

  it("keeps a commit already waiting in the queue across a same-exchange remount, and starts no second one", async () => {
    const host = hostThat();
    const removeFromStore = vi.fn();

    agent.holdQueue();
    const queued = controller.commitSignal(generation, host, removeFromStore);
    await settle();

    // Same widget remounts while the first commit is still queued, and the
    // remounted session tries to commit in turn. The report is already
    // claimed, so the remounted attempt is a no-op and the queued one runs.
    const remounted = controller.acquire("widget-a");
    const again = controller.commitSignal(remounted, host, removeFromStore);
    await settle();

    agent.releaseQueue();
    await Promise.all([queued, again]);
    await settle();

    expect(agent.messages).toHaveLength(1);
    expect(host.calls).toBe(1);
    expect(removeFromStore).toHaveBeenCalledTimes(1);
    expect(controller.signal).toBe("explained");
  });

  it("records explained when the same exchange remounts during the explanation run", async () => {
    let release: (() => void) | undefined;
    const slow = hostThat(
      () =>
        new Promise<RunAgentResult>((resolve) => {
          release = () => resolve({ result: undefined, newMessages: [] });
        }),
    );

    const commit = controller.commitSignal(generation, slow);
    for (let attempt = 0; attempt < 50 && !release; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(agent.messages).toHaveLength(1);
    expect(controller.signal).toBe("message-added");

    // The component unmounts and the same widget mounts again mid-run. The
    // run belongs to the report, not to the session that started it.
    const remounted = controller.acquire("widget-a");
    release?.();
    await commit;
    await settle();

    expect(controller.signal).toBe("explained");
    expect(slow.calls).toBe(1);

    // Nothing left for a host-driven retry from the remounted session to redo.
    const again = hostThat();
    await controller.retryExplanation(remounted, again);
    expect(again.calls).toBe(0);
    expect(agent.messages).toHaveLength(1);
  });

  it("abandons a reservation even when the thread has moved on", () => {
    // The thread-switch case is exactly when a release is needed, so it must
    // not be gated on the check that guards conversation mutations.
    agent.threadId = "thread-2";

    controller.abandonSignal(generation);

    expect(controller.signal).toBeUndefined();
  });

  it("ignores an abandon quoting a stale generation", () => {
    const stale = generation;
    controller.acquire("widget-b");
    const next = controller.acquire("widget-c");
    controller.observe(next, activity(invalidContent, "settled"));
    expect(controller.signal).toBe("reserved");

    controller.abandonSignal(stale);

    expect(controller.signal).toBe("reserved");
  });

  it("keeps removal independent of the report: a failed commit leaves the widget removed", async () => {
    const failing = hostThat(async () => {
      throw new Error("run failed");
    });
    expect(controller.phase).toBe("removed");

    await expect(controller.commitSignal(generation, failing)).rejects.toThrow(
      "run failed",
    );

    expect(controller.phase).toBe("removed");
  });
});

describe("widget controller retention", () => {
  /** Fill the registry past its cap with entries eviction must not touch. */
  function fillWith(
    agent: AbstractAgent,
    count: number,
    make: (controller: McpWidgetController, generation: number) => void,
  ): void {
    for (let index = 0; index < count; index++) {
      const controller = getWidgetController({
        agent,
        threadId: "thread-1",
        activityKey: `filler-${index}`,
      });
      make(controller, controller.acquire("widget-a"));
    }
  }

  it("keeps a newly created entry usable even when the cap is already full", () => {
    const agent = fakeAgent();
    ɵresetWidgetControllers(agent);
    // 500 entries carrying a signal, none of them evictable.
    fillWith(agent, 500, (controller, generation) => {
      controller.observe(generation, activity(invalidContent, "settled"));
    });

    const fresh = getWidgetController({
      agent,
      threadId: "thread-1",
      activityKey: "act-new",
    });
    const generation = fresh.acquire("widget-a");

    // Previously the new entry was its own eviction candidate, so it vanished
    // on creation and its widget could never leave waiting.
    expect(fresh.observe(generation, activity(validContent, "pending"))).toBe(
      "active",
    );
    expect(fresh.phase).toBe("active");
  });

  it("never evicts an entry backing a mounted widget", () => {
    const agent = fakeAgent();
    ɵresetWidgetControllers(agent);

    const mounted = getWidgetController({
      agent,
      threadId: "thread-1",
      activityKey: "act-mounted",
    });
    const mountedGeneration = mounted.acquire("widget-a");
    mounted.observe(mountedGeneration, activity(validContent, "pending"));
    expect(mounted.phase).toBe("active");

    // Pressure from entries that are themselves evictable.
    fillWith(agent, 600, (controller, generation) => {
      controller.observe(generation, activity(invalidContent, "untracked"));
    });

    // Still the same entry: its generation is honoured, so its adapter can
    // keep driving it.
    expect(mounted.phase).toBe("active");
    expect(
      mounted.observe(mountedGeneration, activity(validContent, "settled")),
    ).toBe("active");
  });

  it("does evict a removed entry that carries no signal", () => {
    const agent = fakeAgent();
    ɵresetWidgetControllers(agent);

    const removed = getWidgetController({
      agent,
      threadId: "thread-1",
      activityKey: "act-removed",
    });
    const removedGeneration = removed.acquire("widget-a");
    removed.observe(removedGeneration, activity(invalidContent, "untracked"));
    expect(removed.phase).toBe("removed");

    fillWith(agent, 600, (controller, generation) => {
      controller.observe(generation, activity(invalidContent, "untracked"));
    });

    // Forgotten: a fresh controller for the same key starts over, which costs
    // only a recomputation of the same verdict.
    const reread = getWidgetController({
      agent,
      threadId: "thread-1",
      activityKey: "act-removed",
    });
    expect(reread.phase).toBe("waiting");
  });
});

describe("widget controller identity scoping", () => {
  it("keeps two activities on one agent independent", () => {
    const agent = fakeAgent();
    ɵresetWidgetControllers(agent);
    const first = getWidgetController({
      agent,
      threadId: "thread-1",
      activityKey: "act-1",
    });
    const second = getWidgetController({
      agent,
      threadId: "thread-1",
      activityKey: "act-2",
    });
    const firstGen = first.acquire("widget-a");
    const secondGen = second.acquire("widget-a");

    first.observe(firstGen, activity(invalidContent, "settled"));

    expect(first.phase).toBe("removed");
    expect(second.observe(secondGen, activity(validContent, "pending"))).toBe(
      "active",
    );
  });

  it("keeps the same activity id independent across threads", () => {
    const agent = fakeAgent();
    ɵresetWidgetControllers(agent);
    const inThreadOne = getWidgetController({
      agent,
      threadId: "thread-1",
      activityKey: "act-1",
    });
    const inThreadTwo = getWidgetController({
      agent,
      threadId: "thread-2",
      activityKey: "act-1",
    });
    const genOne = inThreadOne.acquire("widget-a");
    const genTwo = inThreadTwo.acquire("widget-a");

    inThreadOne.observe(genOne, activity(invalidContent, "settled"));

    expect(inThreadOne.phase).toBe("removed");
    expect(inThreadTwo.phase).toBe("waiting");
    expect(inThreadTwo.observe(genTwo, activity(validContent, "pending"))).toBe(
      "active",
    );
  });
});
