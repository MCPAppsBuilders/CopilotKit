import type {
  AbstractAgent,
  AgentSubscriber,
  Message,
  State,
  RunAgentInput,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  TextMessageStartEvent,
  ToolCallResultEvent,
  ToolMessage,
} from "@ag-ui/client";
import { randomUUID, structuredClone_ } from "@ag-ui/client";
import type { CopilotKitCore, CopilotKitCoreFriendsAccess } from "./core";
import { isForwardedToClientPlaceholder } from "./tool-result-content";

/**
 * Whether an activity message is still being produced, already final, or cannot
 * be judged at all. Activity-type agnostic: it is derived from the AG-UI
 * activity events themselves, so it applies to any `activityType`, not to one
 * particular renderer.
 *
 * - `unknown`: the running agent instance is not the one this manager observes,
 *   so the absence of a live-activity record proves nothing.
 * - `untracked`: observed instance, and no dedicated activity event ever
 *   touched this message. It came from history (`setMessages`) or a generic
 *   `MESSAGES_SNAPSHOT`.
 * - `pending` / `settled`: the run that last touched it is still open / is over.
 */
export type ActivityExchangeState =
  | "unknown"
  | "untracked"
  | "pending"
  | "settled";

const isContinuation = (input: RunAgentInput): boolean =>
  input.resume !== undefined ||
  Object.prototype.hasOwnProperty.call(
    (input.forwardedProps as { command?: object } | undefined)?.command ?? {},
    "resume",
  );

export interface CopilotKitCoreContinuationHandoff {
  cancel(): void;
  bind(input: object): void;
}

interface PendingContinuation extends CopilotKitCoreContinuationHandoff {
  expectedInput?: object;
  active: boolean;
  /**
   * The logical run id this continuation belongs to. Events arriving on the
   * continuation are re-stamped with it, so the run reads as ONE run to
   * everything downstream (state/message association, external tracing) even
   * though the transport minted a fresh id for the follow-up invocation.
   */
  expectedRunId?: string;
}

/**
 * Manages state and message tracking by run for CopilotKitCore.
 * Tracks agent state snapshots and message-to-run associations.
 */
export class StateManager {
  // State tracking: agentId -> threadId -> runId -> state
  private stateByRun: Map<string, Map<string, Map<string, State>>> = new Map();

  // Message tracking: agentId -> threadId -> messageId -> runId
  private messageToRun: Map<string, Map<string, Map<string, string>>> =
    new Map();

  // Direct text-start metadata: agentId -> threadId -> messageId -> rawEvent
  private rawEventByMessage: Map<string, Map<string, Map<string, unknown>>> =
    new Map();

  // Active run tracking: `agentId:threadId` -> runId (used when messages arrive without input)
  private activeRun: Map<string, string> = new Map();

  /**
   * Runs still producing: agentId -> threadId -> set of open runIds.
   *
   * Nested rather than keyed by `${agentId}:${threadId}`: an agent may legally
   * be named `foo:bar`, and a flat key would make agent `foo`'s cleanup match
   * (and close) agent `foo:bar`'s runs, notifying with a mangled identity.
   *
   * Deliberately NOT `activeRun`, whose question is "who owns a message that
   * arrives with no input". A stream that ends without a terminal event keeps
   * that ownership on purpose, yet is plainly no longer producing. Entries are
   * removed on every exit path (finished, errored, finalized after an abort),
   * so "is this run still producing" has one honest answer.
   *
   * A set, not a single slot: runs can overlap (a direct `agent.runAgent()`
   * while another is in flight, or a long-lived connect pipeline alongside
   * one). With a single slot, starting B would silently declare A's ongoing
   * activities settled and swallow A's own close notification.
   */
  private openRuns: Map<string, Map<string, Set<string>>> = new Map();

  /**
   * Last dedicated activity event per message: agentId -> threadId -> messageId -> runId.
   *
   * Deliberately NOT `messageToRun`: that one associates a message with the run
   * that CREATED it and never reassigns, so an activity created in run A and
   * later patched by run B still reads as A. This map is overwritten on every
   * ACTIVITY_SNAPSHOT/ACTIVITY_DELTA, so it always names the run currently
   * touching the activity. Populated only by those two events, never by a
   * generic MESSAGES_SNAPSHOT, setMessages or addMessage, which is what makes
   * "no entry" mean "not produced live".
   */
  private lastActivityEventRun: Map<string, Map<string, Map<string, string>>> =
    new Map();

  private agentSubscriptions: Map<
    string,
    {
      agent: AbstractAgent;
      unsubscribe: () => void;
      /**
       * The exact object handed to `agent.subscribe(...)`. Coverage is measured
       * by looking for it in an instance's own `subscribers` array: a per-thread
       * clone made after this subscription inherits it (AbstractAgent.clone
       * copies the array by reference) and is therefore observed, even though it
       * is not the instance recorded here.
       */
      subscriber: AgentSubscriber;
    }
  > = new Map();

  // Internal follow-ups are marked in memory so the marker never reaches a
  // runtime or becomes user-controlled forwardedProps data.
  private pendingContinuations = new WeakMap<
    AbstractAgent,
    Set<PendingContinuation>
  >();

  constructor(private core: CopilotKitCore) {}

  /**
   * Initialize state tracking for an agent
   */
  initialize(): void {
    // Will be called when CopilotKitCore is initialized
  }

  markNextRunAsContinuation(
    agent: AbstractAgent,
    expectedRunId?: string,
  ): CopilotKitCoreContinuationHandoff {
    let pendingForAgent = this.pendingContinuations.get(agent);
    if (!pendingForAgent) {
      pendingForAgent = new Set();
      this.pendingContinuations.set(agent, pendingForAgent);
    }

    const pending: PendingContinuation = {
      active: true,
      expectedRunId,
      bind: (input) => {
        if (pending.active) pending.expectedInput = input;
      },
      cancel: () => {
        if (!pending.active) return;
        pending.active = false;
        pendingForAgent!.delete(pending);
        if (pendingForAgent!.size === 0) {
          this.pendingContinuations.delete(agent);
        }
      },
    };
    pendingForAgent.add(pending);
    return pending;
  }

  /**
   * Subscribe to an agent's events to track state and messages.
   */
  subscribeToAgent(agent: AbstractAgent): void {
    if (!agent.agentId) {
      return; // Skip agents without IDs
    }

    const agentId = agent.agentId;

    const existing = this.agentSubscriptions.get(agentId);
    if (existing) {
      if (existing.agent === agent) {
        return;
      }
      existing.unsubscribe();
      this.agentSubscriptions.delete(agentId);
    }
    const replacedInstance = existing !== undefined;

    // Subscribe to agent events.
    //
    // Two invariants this subscription must uphold:
    //
    // 1. Revocation: the ag-ui pipeline captures `o = [...agent.subscribers]` at
    //    runAgent() start. If this subscription is replaced by a newer one before
    //    the pipeline finishes, the old pipeline may still call these callbacks
    //    with the old input.runId. `revoked = true` turns them into no-ops once
    //    the replacement subscription is in place. Only a replacement revokes —
    //    see the same-instance guard above.
    //
    // 2. Run isolation within one subscription: in tests (and edge cases), a new
    //    run's events can arrive through the same subscription before the new
    //    pipeline is set up. An explicit standard or legacy resume input is a
    //    continuation, so only an ordinary new run gets a fresh ID after
    //    RUN_FINISHED.
    let revoked = false;
    let subRunId: string | undefined; // runId assigned to the current logical run
    let runFinished = false; // true after RUN_FINISHED, reset on next RUN_STARTED
    const pendingResults = new WeakMap<
      RunAgentInput,
      Map<string, ToolCallResultEvent>
    >();

    const reconcilePendingResults = (
      historyMessages: readonly Message[],
      input: RunAgentInput,
    ): { messages: Message[] } | undefined => {
      const events = pendingResults.get(input);
      if (!events) return undefined;

      const messages = [...historyMessages];
      let changed = false;

      for (const event of events.values()) {
        const ownerIndex = messages.findIndex(
          (message) =>
            message.role === "assistant" &&
            message.toolCalls?.some(
              (toolCall) => toolCall.id === event.toolCallId,
            ),
        );
        if (ownerIndex < 0) continue;

        const matchingIndexes = messages.reduce<number[]>(
          (indexes, message, index) => {
            if (
              message.role === "tool" &&
              message.toolCallId === event.toolCallId
            ) {
              indexes.push(index);
            }
            return indexes;
          },
          [],
        );
        const realIndex = matchingIndexes.find(
          (index) => !isForwardedToClientPlaceholder(messages[index]?.content),
        );
        if (realIndex !== undefined) {
          for (const duplicateIndex of matchingIndexes
            .filter((candidateIndex) => candidateIndex !== realIndex)
            .sort((a, b) => b - a)) {
            messages.splice(duplicateIndex, 1);
            changed = true;
          }
          continue;
        }

        const placeholderIndex = matchingIndexes.find((index) =>
          isForwardedToClientPlaceholder(messages[index]?.content),
        );
        if (placeholderIndex !== undefined) {
          if (isForwardedToClientPlaceholder(event.content)) {
            for (const duplicateIndex of matchingIndexes
              .slice(1)
              .sort((a, b) => b - a)) {
              messages.splice(duplicateIndex, 1);
              changed = true;
            }
            continue;
          }
          messages[placeholderIndex] = {
            ...messages[placeholderIndex],
            id: event.messageId,
            content: event.content,
          } as ToolMessage;
          changed = true;
          for (const duplicateIndex of matchingIndexes
            .filter(
              (candidateIndex) =>
                candidateIndex !== placeholderIndex &&
                isForwardedToClientPlaceholder(
                  messages[candidateIndex]?.content,
                ),
            )
            .sort((a, b) => b - a)) {
            messages.splice(duplicateIndex, 1);
          }
          continue;
        }

        const result: ToolMessage = {
          id: event.messageId,
          role: "tool",
          toolCallId: event.toolCallId,
          content: event.content,
        };
        let insertIndex = ownerIndex + 1;
        while (messages[insertIndex]?.role === "tool") insertIndex++;
        messages.splice(insertIndex, 0, result);
        changed = true;
      }

      return changed ? { messages } : undefined;
    };

    const clearPendingResults = (input: RunAgentInput): void => {
      pendingResults.delete(input);
    };

    // The resolved run id is bound to the execution context that produced it,
    // not read back from `subRunId` at call time. An old pipeline can still be
    // finalizing (see invariant 1 above) after a newer run has started; reading
    // the mutable `subRunId` then would resolve the old run's callbacks to the
    // NEW run id and let them close a run they never belonged to.
    const runIdForInput = new WeakMap<RunAgentInput, string>();

    const effectiveInput = (input: RunAgentInput): RunAgentInput => ({
      ...input,
      runId: runIdForInput.get(input) ?? subRunId ?? input.runId,
    });

    const subscriber: AgentSubscriber = {
      onRunStartedEvent: ({ event, input, state }) => {
        if (revoked) return;
        const pendingForAgent = this.pendingContinuations.get(agent);
        const internalContinuation = [...(pendingForAgent ?? [])].find(
          (pending) => pending.expectedInput === input,
        );
        internalContinuation?.cancel();

        if (internalContinuation) {
          // An internal continuation re-stamps onto the run id it continues, so
          // the follow-up does not have to reuse that id on the wire.
          subRunId =
            internalContinuation.expectedRunId ?? event.runId ?? input.runId;
        } else if (
          runFinished &&
          input.runId === subRunId &&
          !isContinuation(input) &&
          (event.runId == null || event.runId === subRunId)
        ) {
          // A new logical run's events are arriving through this same (old)
          // subscription. This happens when the test emits events before
          // copilotkit.runAgent() has had a chance to set up the new pipeline:
          // the old pipeline reuses input1.runId for all events, so
          // input.runId equals the previous run's runId. Generate a fresh
          // runId so the new run's state doesn't collide with the old one.
          subRunId = randomUUID();
        } else {
          // A connect replay may contain multiple server runs under one input.runId.
          subRunId = event.runId || input.runId;
        }
        runFinished = false;
        runIdForInput.set(input, subRunId);
        this.handleRunStarted(agent, effectiveInput(input), state);
      },
      onRunFinishedEvent: ({ input, state, messages }) => {
        if (revoked) return;
        runFinished = true;
        const effective = effectiveInput(input);
        const mutation = reconcilePendingResults(messages, input);
        clearPendingResults(input);
        this.handleRunFinished(agent, effective, state);
        return mutation;
      },
      // A run error terminates the run — treat identically to finished for cleanup
      onRunErrorEvent: ({ input, state, messages }) => {
        if (revoked) return;
        runFinished = true;
        const effective = effectiveInput(input);
        const mutation = reconcilePendingResults(messages, input);
        this.handleRunFinished(agent, effective, state);
        return mutation;
      },
      onRunFailed: ({ input, messages }) => {
        if (revoked) return;
        return reconcilePendingResults(messages, input);
      },
      // Runs on success, error AND unsubscription/abort, so it is the only hook
      // that closes a run the transport dropped without a terminal event.
      onRunFinalized: ({ input }) => {
        if (revoked) return;
        clearPendingResults(input);
        // Only a context that actually started a run has one to close. A run
        // that failed before RUN_STARTED never owned the thread's slot, and
        // resolving it through the fallback would name (and close) whichever
        // run is currently active instead.
        const ownRunId = runIdForInput.get(input);
        if (ownRunId === undefined) return;
        this.closeEffectiveRun(agent.agentId!, input.threadId, ownRunId);
      },
      onActivitySnapshotEvent: ({ event, input }) => {
        if (revoked) return;
        const effective = effectiveInput(input);
        this.recordActivityEventRun(
          agent.agentId!,
          effective.threadId,
          event.messageId,
          effective.runId,
        );
      },
      onActivityDeltaEvent: ({ event, input }) => {
        if (revoked) return;
        const effective = effectiveInput(input);
        this.recordActivityEventRun(
          agent.agentId!,
          effective.threadId,
          event.messageId,
          effective.runId,
        );
      },
      onToolCallResultEvent: ({ event, input }) => {
        if (revoked) return;
        let events = pendingResults.get(input);
        if (!events) {
          events = new Map();
          pendingResults.set(input, events);
        }
        events.set(event.toolCallId, event);
      },
      onStateSnapshotEvent: ({ event, input, state }) => {
        if (revoked) return;
        this.handleStateSnapshot(agent, event, effectiveInput(input), state);
      },
      onStateDeltaEvent: ({ event, input, state }) => {
        if (revoked) return;
        this.handleStateDelta(agent, event, effectiveInput(input), state);
      },
      onTextMessageStartEvent: ({ event, input }) => {
        if (revoked) return;
        this.handleTextMessageStart(agent, event, effectiveInput(input));
      },
      onMessagesSnapshotEvent: ({ event, input, messages }) => {
        if (revoked) return;
        this.handleMessagesSnapshot(
          agent,
          event,
          effectiveInput(input),
          messages,
        );
        this.pruneRawEvents(
          agent.agentId!,
          input.threadId,
          event.messages,
          effectiveInput(input),
        );
      },
      onNewMessage: ({ message, input }) => {
        if (revoked) return;
        this.handleNewMessage(
          agent,
          message,
          input ? effectiveInput(input) : undefined,
        );
      },
      onMessagesChanged: ({ messages, input }) => {
        if (revoked) return;
        if (!input) {
          this.pruneRawEvents(agent.agentId!, agent.threadId, messages);
        }
      },
    };

    const { unsubscribe } = agent.subscribe(subscriber);

    this.agentSubscriptions.set(agentId, {
      agent,
      subscriber,
      unsubscribe: () => {
        revoked = true;
        this.pendingContinuations.delete(agent);
        unsubscribe();
      },
    });

    if (replacedInstance) {
      // The replaced instance's callbacks are revoked, so any run it left open
      // can never close itself; close them here or a consumer waiting on one
      // waits forever. Done only now that the new subscription is registered:
      // a consumer re-reading state from the close notification must already
      // see the new instance as observed, otherwise it reads "unknown" and
      // nothing ever corrects that. Provenance (`lastActivityEventRun`) is
      // deliberately kept: those activities really were produced live, and
      // with their runs now closed they read as settled, which is truthful.
      this.closeOpenRunsForAgent(agentId);
    }
  }

  /**
   * Unsubscribe an agent's subscription.
   */
  unsubscribeFromAgent(agentId: string): void {
    const existing = this.agentSubscriptions.get(agentId);
    if (existing) {
      existing.unsubscribe();
      this.agentSubscriptions.delete(agentId);
    }
    // Nothing can report these runs' end any more, so close them rather than
    // leave a consumer waiting on a run that is already gone.
    this.closeOpenRunsForAgent(agentId);
    this.rawEventByMessage.delete(agentId);
    this.lastActivityEventRun.delete(agentId);
  }

  /**
   * Get state for a specific run
   * Returns a deep copy to prevent external mutations
   */
  getStateByRun(
    agentId: string,
    threadId: string,
    runId: string,
  ): State | undefined {
    const state = this.stateByRun.get(agentId)?.get(threadId)?.get(runId);
    if (!state) return undefined;
    // Return a deep copy to prevent mutations
    return JSON.parse(JSON.stringify(state));
  }

  /**
   * Get runId associated with a message
   */
  getRunIdForMessage(
    agentId: string,
    threadId: string,
    messageId: string,
  ): string | undefined {
    return this.messageToRun.get(agentId)?.get(threadId)?.get(messageId);
  }

  /** True while `runId` is still producing on that agent's thread. */
  isRunActive(agentId: string, threadId: string, runId: string): boolean {
    return this.openRuns.get(agentId)?.get(threadId)?.has(runId) ?? false;
  }

  /**
   * Whether this manager observes the events of `agent`: true for the instance
   * it subscribed and for any clone that inherited that subscription, false for
   * an instance created before it (which can never receive the callbacks).
   */
  isAgentInstanceObserved(agentId: string, agent: AbstractAgent): boolean {
    const existing = this.agentSubscriptions.get(agentId);
    return !!existing && agent.subscribers.includes(existing.subscriber);
  }

  /** See {@link ActivityExchangeState}. */
  getActivityExchangeState(
    agentId: string,
    threadId: string,
    messageId: string,
    agent: AbstractAgent,
  ): ActivityExchangeState {
    if (!this.isAgentInstanceObserved(agentId, agent)) return "unknown";
    const runId = this.lastActivityEventRun
      .get(agentId)
      ?.get(threadId)
      ?.get(messageId);
    if (runId === undefined) return "untracked";
    return this.isRunActive(agentId, threadId, runId) ? "pending" : "settled";
  }

  /**
   * Close every run still open for an agent, notifying for each.
   *
   * Used when the instance that owned those runs can no longer report their
   * end (its subscription was replaced or removed), so that nothing is left
   * waiting on a run that will never close itself.
   */
  private closeOpenRunsForAgent(agentId: string): void {
    const agentRuns = this.openRuns.get(agentId);
    if (!agentRuns) return;
    for (const [threadId, runIds] of [...agentRuns]) {
      for (const runId of [...runIds]) {
        this.closeEffectiveRun(agentId, threadId, runId);
      }
    }
  }

  private recordActivityEventRun(
    agentId: string,
    threadId: string,
    messageId: string,
    runId: string,
  ): void {
    let agentRuns = this.lastActivityEventRun.get(agentId);
    if (!agentRuns) {
      agentRuns = new Map();
      this.lastActivityEventRun.set(agentId, agentRuns);
    }
    let threadRuns = agentRuns.get(threadId);
    if (!threadRuns) {
      threadRuns = new Map();
      agentRuns.set(threadId, threadRuns);
    }
    threadRuns.set(messageId, runId);
  }

  /**
   * Close `runId` if it is still open, then notify once.
   *
   * Idempotent, and scoped to the run it names: a late finalization of an older
   * run closes only itself and leaves any concurrent run untouched. Called from
   * every exit path (finished, error, finalized/abort), so whichever arrives
   * first performs the close and the rest are no-ops.
   */
  private closeEffectiveRun(
    agentId: string,
    threadId: string,
    runId: string,
  ): void {
    const agentRuns = this.openRuns.get(agentId);
    const threadRuns = agentRuns?.get(threadId);
    if (!threadRuns?.delete(runId)) return;
    if (threadRuns.size === 0) agentRuns!.delete(threadId);
    if (agentRuns!.size === 0) this.openRuns.delete(agentId);
    void this._internal.notifySubscribers(
      (subscriber) =>
        subscriber.onActivityRunSettled?.({
          copilotkit: this.core,
          agentId,
          threadId,
          runId,
        }),
      "Subscriber onActivityRunSettled error:",
    );
  }

  /** Typed access to CopilotKitCore's internal ("friend") methods. */
  private get _internal(): CopilotKitCoreFriendsAccess {
    return this.core as unknown as CopilotKitCoreFriendsAccess;
  }

  /**
   * Get direct text-start metadata associated with a message.
   */
  getRawEventForMessage(
    agentId: string,
    threadId: string,
    messageId: string,
  ): unknown {
    const rawEvent = this.rawEventByMessage
      .get(agentId)
      ?.get(threadId)
      ?.get(messageId);
    return rawEvent === undefined ? undefined : structuredClone_(rawEvent);
  }

  /**
   * Get all states for an agent's thread
   */
  getStatesForThread(agentId: string, threadId: string): Map<string, State> {
    return this.stateByRun.get(agentId)?.get(threadId) ?? new Map();
  }

  /**
   * Get all run IDs for an agent's thread
   */
  getRunIdsForThread(agentId: string, threadId: string): string[] {
    const threadStates = this.stateByRun.get(agentId)?.get(threadId);
    return threadStates ? Array.from(threadStates.keys()) : [];
  }

  /**
   * Handle run started event
   */
  private handleRunStarted(
    agent: AbstractAgent,
    input: RunAgentInput,
    state: State,
  ): void {
    if (!agent.agentId) return;

    const { threadId, runId } = input;
    this.activeRun.set(`${agent.agentId}:${threadId}`, runId);
    let agentRuns = this.openRuns.get(agent.agentId);
    if (!agentRuns) {
      agentRuns = new Map();
      this.openRuns.set(agent.agentId, agentRuns);
    }
    let threadRuns = agentRuns.get(threadId);
    if (!threadRuns) {
      threadRuns = new Set();
      agentRuns.set(threadId, threadRuns);
    }
    threadRuns.add(runId);
    // Only persist state when it carries real data. An empty {} from an
    // initial-state-less run would cause getStateByRun to return {} instead
    // of undefined, breaking renderers that rely on undefined to mean "no
    // state snapshot received yet".
    if (state && Object.keys(state).length > 0) {
      this.saveState(agent.agentId, threadId, runId, state);
    }
  }

  /**
   * Handle run finished event
   */
  private handleRunFinished(
    agent: AbstractAgent,
    input: RunAgentInput,
    state: State,
  ): void {
    if (!agent.agentId) return;

    const { threadId, runId } = input;
    this.activeRun.delete(`${agent.agentId}:${threadId}`);
    // Liveness is closed through closeEffectiveRun so a late terminal event for
    // an older run cannot clear a newer run's slot, and so the settled
    // notification fires exactly once across all exit paths.
    this.closeEffectiveRun(agent.agentId, threadId, runId);
    if (state && Object.keys(state).length > 0) {
      this.saveState(agent.agentId, threadId, runId, state);
    }
  }

  /**
   * Handle state snapshot event
   */
  private handleStateSnapshot(
    agent: AbstractAgent,
    event: StateSnapshotEvent,
    input: RunAgentInput,
    state: State,
  ): void {
    if (!agent.agentId) return;

    const { threadId, runId } = input;
    // Merge snapshot into current state
    const mergedState = { ...state, ...event.snapshot };
    this.saveState(agent.agentId, threadId, runId, mergedState);
  }

  /**
   * Handle state delta event
   */
  private handleStateDelta(
    agent: AbstractAgent,
    event: StateDeltaEvent,
    input: RunAgentInput,
    state: State,
  ): void {
    if (!agent.agentId) return;

    const { threadId, runId } = input;
    // State is already updated by the agent, just save it
    this.saveState(agent.agentId, threadId, runId, state);
  }

  /**
   * Capture only defined metadata from a normalized direct text-start event.
   */
  private handleTextMessageStart(
    agent: AbstractAgent,
    event: TextMessageStartEvent,
    input: RunAgentInput,
  ): void {
    if (!agent.agentId) return;

    const { threadId } = input;
    if (event.rawEvent === undefined) {
      const threadEvents = this.rawEventByMessage
        .get(agent.agentId)
        ?.get(threadId);
      threadEvents?.delete(event.messageId);
      if (threadEvents?.size === 0) {
        this.rawEventByMessage.get(agent.agentId)?.delete(threadId);
      }
      if (this.rawEventByMessage.get(agent.agentId)?.size === 0) {
        this.rawEventByMessage.delete(agent.agentId);
      }
      return;
    }

    if (!this.rawEventByMessage.has(agent.agentId)) {
      this.rawEventByMessage.set(agent.agentId, new Map());
    }
    const agentEvents = this.rawEventByMessage.get(agent.agentId)!;
    if (!agentEvents.has(threadId)) {
      agentEvents.set(threadId, new Map());
    }
    agentEvents.get(threadId)!.set(event.messageId, event.rawEvent);
  }

  /**
   * Handle messages snapshot event
   */
  private handleMessagesSnapshot(
    agent: AbstractAgent,
    event: MessagesSnapshotEvent,
    input: RunAgentInput,
    _messages: readonly Message[],
  ): void {
    if (!agent.agentId) return;

    const { threadId, runId } = input;

    // Cumulative snapshots repeat messages from earlier runs, so only assign
    // messages that do not already have a run association.
    for (const message of event.messages) {
      if (
        this.getRunIdForMessage(agent.agentId, threadId, message.id) ===
        undefined
      ) {
        this.associateMessageWithRun(
          agent.agentId,
          threadId,
          message.id,
          runId,
        );
      }
    }
  }

  /**
   * Handle new message event
   */
  private handleNewMessage(
    agent: AbstractAgent,
    message: Message,
    input?: RunAgentInput,
  ): void {
    if (!agent.agentId) return;

    if (!input) {
      // ag-ui calls addMessage() without input, so input is undefined here.
      // Fall back to the currently-active run for this agent's thread.
      const threadId = agent.threadId ?? "";
      const runId = this.activeRun.get(`${agent.agentId}:${threadId}`);
      if (runId) {
        this.associateMessageWithRun(
          agent.agentId,
          threadId,
          message.id,
          runId,
        );
      }
      return;
    }

    const { threadId, runId } = input;
    this.associateMessageWithRun(agent.agentId, threadId, message.id, runId);
  }

  /**
   * Save state for a specific run
   */
  private saveState(
    agentId: string,
    threadId: string,
    runId: string,
    state: State,
  ): void {
    // Ensure nested maps exist
    if (!this.stateByRun.has(agentId)) {
      this.stateByRun.set(agentId, new Map());
    }
    const agentStates = this.stateByRun.get(agentId)!;

    if (!agentStates.has(threadId)) {
      agentStates.set(threadId, new Map());
    }
    const threadStates = agentStates.get(threadId)!;

    // Deep copy the state to prevent mutations
    threadStates.set(runId, JSON.parse(JSON.stringify(state)));
  }

  /**
   * Associate a message with a run
   */
  private associateMessageWithRun(
    agentId: string,
    threadId: string,
    messageId: string,
    runId: string,
  ): void {
    // Ensure nested maps exist
    if (!this.messageToRun.has(agentId)) {
      this.messageToRun.set(agentId, new Map());
    }
    const agentMessages = this.messageToRun.get(agentId)!;

    if (!agentMessages.has(threadId)) {
      agentMessages.set(threadId, new Map());
    }
    const threadMessages = agentMessages.get(threadId)!;

    threadMessages.set(messageId, runId);
  }

  private pruneRawEvents(
    agentId: string,
    fallbackThreadId: string | undefined,
    messages: ReadonlyArray<Readonly<Message>>,
    input?: RunAgentInput,
  ): void {
    const threadId = input?.threadId ?? fallbackThreadId;
    if (!threadId) return;

    const threadEvents = this.rawEventByMessage.get(agentId)?.get(threadId);
    if (!threadEvents) return;

    const messageIds = new Set(messages.map((message) => message.id));
    for (const messageId of threadEvents.keys()) {
      if (!messageIds.has(messageId)) threadEvents.delete(messageId);
    }
    if (threadEvents.size === 0) {
      this.rawEventByMessage.get(agentId)?.delete(threadId);
    }
    if (this.rawEventByMessage.get(agentId)?.size === 0) {
      this.rawEventByMessage.delete(agentId);
    }
  }

  /**
   * Clear all state for an agent
   */
  clearAgentState(agentId: string): void {
    this.stateByRun.delete(agentId);
    this.messageToRun.delete(agentId);
    this.rawEventByMessage.delete(agentId);
    this.lastActivityEventRun.delete(agentId);
    this.closeOpenRunsForAgent(agentId);
  }

  /**
   * Clear all state for a thread
   */
  clearThreadState(agentId: string, threadId: string): void {
    this.stateByRun.get(agentId)?.delete(threadId);
    this.messageToRun.get(agentId)?.delete(threadId);
    this.rawEventByMessage.get(agentId)?.delete(threadId);
    this.lastActivityEventRun.get(agentId)?.delete(threadId);
    for (const runId of [
      ...(this.openRuns.get(agentId)?.get(threadId) ?? []),
    ]) {
      this.closeEffectiveRun(agentId, threadId, runId);
    }
  }
}
