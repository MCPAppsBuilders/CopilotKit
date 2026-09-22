import type { AbstractAgent, RunAgentResult } from "@ag-ui/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SafeParseReturnType } from "zod";
import { randomUUID } from "@copilotkit/shared";
import {
  classifyActivityContent,
  classifyProxyResult,
} from "./classify-content";
import type { McpContentVerdict } from "./classify-content";
import { describeFailure } from "./failure-reason";
import type { McpFailureReason } from "./failure-reason";
import { mcpAppsRequestQueue } from "./request-queue";

/**
 * What the adapter should be showing.
 *
 * - `waiting`: no usable identity yet, so there is nothing to mount.
 * - `active`: mounted. Incomplete fragments keep it here, instance untouched.
 * - `retiring`: terminally decided, but a response may still owe the widget.
 * - `removed`: gone. Terminal for this generation.
 */
export type McpWidgetPhase = "waiting" | "active" | "retiring" | "removed";

/**
 * Where the report to the agent has got to. Independent of {@link McpWidgetPhase}:
 * a widget is removed whether or not anything is ever explained.
 */
export type McpSignalState = "reserved" | "message-added" | "explained";

/**
 * How final the observed content is, as established by the host. `unknown`
 * means coverage could not be established, which is NOT evidence of history:
 * it is treated exactly like `pending`.
 */
export type McpExchangeState = "untracked" | "unknown" | "pending" | "settled";

export interface McpControllerIdentity {
  /** Captured once; every deferred step acts on this instance, never a re-read one. */
  agent: AbstractAgent;
  threadId: string;
  /** A store message id, or a caller-supplied stable id for an external activity. */
  activityKey: string;
  /** No store message to remove: retention and removal differ for these. */
  isExternal?: boolean;
}

interface McpObservationBase {
  exchange: McpExchangeState;
  /** `resourceUri` + `serverHash` are known, so a session can be bound. */
  identityAvailable: boolean;
}

/**
 * The two paths carry different things, so they are typed differently rather
 * than squeezed through one `content: unknown`: an activity supplies raw
 * content to validate, a proxy supplies the result it already parsed against
 * the same contract.
 */
export type McpObservation =
  | (McpObservationBase & { origin: "activity"; content: unknown })
  | (McpObservationBase & {
      origin: "proxy";
      parsed: SafeParseReturnType<unknown, CallToolResult>;
    });

export interface McpControllerHost {
  runAgent(params: { agent: AbstractAgent }): Promise<RunAgentResult>;
}

export interface McpWidgetController {
  readonly phase: McpWidgetPhase;
  /**
   * Start a new exchange for this activity (new resource or server identity).
   * Releases a reservation the outgoing generation never committed, so it is
   * not left to rot, and returns the generation every later call must quote.
   */
  rebind(): number;
  /** Apply an observation. Stale generations and a `removed` phase are no-ops. */
  observe(generation: number, observation: McpObservation): McpWidgetPhase;
  /**
   * Advance `retiring` to `removed`. Idempotent. Never consults the thread:
   * tearing down local UI is not a conversation mutation.
   */
  finalizeRemoval(generation: number): void;
  /**
   * Remove the activity from the store if asked, add the explanation message,
   * and run the agent. Only reachable from a reservation this generation made.
   */
  commitSignal(
    generation: number,
    host: McpControllerHost,
    removeFromStore?: () => void,
  ): Promise<void>;
  /** Re-run the explanation for an already-added message, without re-adding it. */
  retryExplanation(generation: number, host: McpControllerHost): Promise<void>;
  /**
   * Drop a reservation that will never commit. Ownership-only: releasing
   * bookkeeping touches no conversation, so it must work even (especially)
   * when the thread has moved on, which is when it is usually needed.
   */
  abandonSignal(generation: number): void;
  /** Current signal state, for tests and for a host driving an explicit retry. */
  readonly signal: McpSignalState | undefined;
}

interface Entry {
  generation: number;
  phase: McpWidgetPhase;
  signal?: McpSignalState;
  /** Kept so a retry reuses the message instead of adding a second one. */
  messageId?: string;
  reason?: McpFailureReason;
  /**
   * The in-flight commit or retry that owns this entry's signal, claimed
   * synchronously so a second caller cannot start a duplicate, and re-checked
   * after every await so a superseded one cannot mutate the conversation or
   * write its outcome over a newer exchange.
   */
  claim?: object;
  isExternal: boolean;
  lastTouched: number;
}

/**
 * Entries that may be forgotten under pressure, capped per agent. Only entries
 * that never reserved anything qualify: forgetting one costs a fresh generation
 * on the next observation and nothing else.
 */
const MAX_FORGETTABLE_ENTRIES = 500;

const registry = new WeakMap<AbstractAgent, Map<string, Entry>>();

const keyOf = (identity: McpControllerIdentity): string =>
  `${identity.threadId}::${identity.activityKey}`;

function entriesFor(agent: AbstractAgent): Map<string, Entry> {
  let entries = registry.get(agent);
  if (!entries) {
    entries = new Map();
    registry.set(agent, entries);
  }
  return entries;
}

/**
 * Forget the oldest entries that nothing can still be waiting on.
 *
 * Only a `removed` entry with no signal qualifies. Everything else is either
 * in use or load-bearing:
 *
 * - A `waiting`, `active` or `retiring` entry backs a widget that is on screen
 *   right now. Dropping it discards the generation its adapter quotes, so
 *   every later `observe` would be treated as stale and the widget would hang
 *   in whatever state it was in.
 * - `reserved` and `message-added` are in flight or awaiting a retry, and an
 *   `explained` marker is what stops a removed widget from coming back when the
 *   same activity is re-introduced (an unchanged external prop, or the same
 *   conversation reloaded from persistence).
 *
 * `protectedKey` is the entry being handed out right now, which must never be
 * its own eviction candidate. If nothing qualifies, the map is allowed to
 * exceed the cap: breaking a live widget to respect a soft bound would be the
 * worse trade. The real bound is the conversation's lifetime, which is the next
 * retention step (tying cleanup to thread deletion).
 */
function evictForgettable(
  entries: Map<string, Entry>,
  protectedKey: string,
): void {
  if (entries.size <= MAX_FORGETTABLE_ENTRIES) return;
  const forgettable = [...entries]
    .filter(
      ([key, entry]) =>
        key !== protectedKey &&
        entry.signal === undefined &&
        entry.phase === "removed",
    )
    .sort((a, b) => a[1].lastTouched - b[1].lastTouched);
  let excess = entries.size - MAX_FORGETTABLE_ENTRIES;
  for (const [key] of forgettable) {
    if (excess <= 0) break;
    entries.delete(key);
    excess--;
  }
}

/** Only a live failure the model has not already seen is worth explaining. */
function shouldReserve(
  observation: McpObservation,
  verdict: McpContentVerdict,
): boolean {
  if (verdict.kind !== "retire") return false;
  if (observation.exchange !== "settled") return false;
  // An initial tool error is already in the agent's own run: the model saw the
  // failure, so saying it again would buy a redundant turn. A proxy call never
  // reaches the model, so its failure always needs reporting.
  return !(
    observation.origin === "activity" && verdict.reason.kind === "tool-error"
  );
}

export function getWidgetController(
  identity: McpControllerIdentity,
): McpWidgetController {
  const entries = entriesFor(identity.agent);
  const key = keyOf(identity);

  const current = (): Entry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        generation: 0,
        phase: "waiting",
        isExternal: identity.isExternal === true,
        lastTouched: Date.now(),
      };
      entries.set(key, entry);
      evictForgettable(entries, key);
    }
    return entry;
  };

  /** A generation that is not the entry's own may not act on it. */
  const owned = (generation: number): Entry | undefined => {
    const entry = current();
    return entry.generation === generation ? entry : undefined;
  };

  const releaseReservation = (entry: Entry): void => {
    if (entry.signal !== "reserved") return;
    entry.signal = undefined;
    entry.reason = undefined;
  };

  const threadMatches = (): boolean =>
    (identity.agent.threadId || "default") === (identity.threadId || "default");

  return {
    get phase() {
      return current().phase;
    },

    get signal() {
      return current().signal;
    },

    rebind() {
      const entry = current();
      // A rebind means a genuinely different exchange for this activity (a new
      // resource or server identity), so its report cycle starts over: a
      // failure of the new exchange deserves its own explanation, and a
      // reservation the outgoing one never committed can no longer be
      // committed by anyone. Anything still in flight for the outgoing
      // generation finds itself superseded at its next checkpoint, via the
      // generation bump below.
      //
      // Note this is NOT what happens on a remount: the same identity keeps
      // its generation, and with it the terminal marker that stops a removed
      // widget from coming back.
      entry.claim = undefined;
      entry.signal = undefined;
      entry.messageId = undefined;
      entry.reason = undefined;
      entry.generation += 1;
      entry.phase = "waiting";
      entry.lastTouched = Date.now();
      return entry.generation;
    },

    observe(generation, observation) {
      const entry = owned(generation);
      if (!entry) return current().phase;
      entry.lastTouched = Date.now();

      // Terminal for this exchange: a late callback that finally produces valid
      // content must not bring a removed widget back.
      if (entry.phase === "removed" || entry.phase === "retiring") {
        return entry.phase;
      }

      const verdict =
        observation.origin === "proxy"
          ? classifyProxyResult(observation.parsed)
          : classifyActivityContent(observation.content);

      // Provisional, whichever way it reads: still streaming, or coverage could
      // not be established. Keep whatever is on screen.
      if (
        observation.exchange === "pending" ||
        observation.exchange === "unknown"
      ) {
        if (entry.phase === "waiting" && observation.identityAvailable) {
          entry.phase = "active";
        }
        return entry.phase;
      }

      if (verdict.kind === "keep") {
        if (entry.phase === "waiting" && observation.identityAvailable) {
          entry.phase = "active";
        }
        return entry.phase;
      }

      if (shouldReserve(observation, verdict)) {
        entry.signal = "reserved";
        entry.reason = verdict.reason;
      }

      entry.phase = "retiring";
      // Nothing is owed to a widget on the activity path, so it goes now. The
      // proxy path still owes a response, so its caller finalizes after that.
      if (observation.origin === "activity") {
        entry.phase = "removed";
      }
      return entry.phase;
    },

    finalizeRemoval(generation) {
      const entry = owned(generation);
      if (!entry || entry.phase !== "retiring") return;
      entry.phase = "removed";
      entry.lastTouched = Date.now();
    },

    async commitSignal(generation, host, removeFromStore) {
      const entry = owned(generation);
      // `claim` is what makes two concurrent callers safe: both can read
      // "reserved", but only one can take the claim, and it is taken
      // synchronously here, before any await.
      if (
        !entry ||
        entry.signal !== "reserved" ||
        entry.claim ||
        !entry.reason
      ) {
        return;
      }
      // Mutating a thread the user has left is the leak this guard exists for.
      if (!threadMatches()) {
        releaseReservation(entry);
        return;
      }

      const claim = {};
      entry.claim = claim;
      const stillOurs = () =>
        entries.get(key) === entry &&
        entry.generation === generation &&
        entry.claim === claim;

      const agent = identity.agent;
      const messageId = randomUUID();
      const reason = entry.reason;
      const noRun: RunAgentResult = { result: undefined, newMessages: [] };

      try {
        await mcpAppsRequestQueue.enqueue(
          agent,
          async () => {
            // Re-checked at execution: the queue waits for an idle agent, so a
            // rebind or abandon may have superseded this work while it waited,
            // and the thread may have moved on.
            if (!stillOurs()) return noRun;
            if (!threadMatches()) {
              releaseReservation(entry);
              return noRun;
            }

            removeFromStore?.();

            agent.addMessage({
              id: messageId,
              role: "developer",
              content:
                `${describeFailure(reason)} The interface for it was removed. ` +
                "Tell the user this part of the answer could not be shown.",
            } as Parameters<typeof agent.addMessage>[0]);
            entry.signal = "message-added";
            entry.messageId = messageId;

            const result = await host.runAgent({ agent });
            // The run can outlive this exchange: only record its outcome if
            // the entry is still the one that started it.
            if (stillOurs()) entry.signal = "explained";
            return result;
          },
          { dropAfterThreadSwitch: true },
        );
      } catch (error) {
        // A message already in the conversation stays recorded as
        // `message-added`, which is what lets a retry resend it without
        // adding a second one.
        if (stillOurs() && entry.signal === "reserved") {
          releaseReservation(entry);
        }
        throw error;
      } finally {
        if (stillOurs()) entry.claim = undefined;
      }
    },

    async retryExplanation(generation, host) {
      const entry = owned(generation);
      if (!entry || entry.signal !== "message-added" || entry.claim) return;
      if (!threadMatches()) return;

      const claim = {};
      entry.claim = claim;
      const stillOurs = () =>
        entries.get(key) === entry &&
        entry.generation === generation &&
        entry.claim === claim;

      const noRun: RunAgentResult = { result: undefined, newMessages: [] };

      try {
        await mcpAppsRequestQueue.enqueue(
          identity.agent,
          async () => {
            if (!stillOurs() || !threadMatches()) return noRun;
            const result = await host.runAgent({ agent: identity.agent });
            if (stillOurs()) entry.signal = "explained";
            return result;
          },
          { dropAfterThreadSwitch: true },
        );
      } finally {
        if (stillOurs()) entry.claim = undefined;
      }
    },

    abandonSignal(generation) {
      const entry = owned(generation);
      if (!entry) return;
      // Dropping the claim too, so an operation already in flight finds itself
      // superseded at its next checkpoint instead of completing regardless.
      entry.claim = undefined;
      releaseReservation(entry);
    },
  };
}

/** @internal test seam: forget everything recorded for an agent. */
export function ɵresetWidgetControllers(agent: AbstractAgent): void {
  registry.delete(agent);
}
