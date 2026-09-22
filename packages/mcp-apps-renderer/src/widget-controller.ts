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
   * Take this activity over for a session bound to `exchangeKey`, the widget's
   * resource/server identity. Returns the generation every later call quotes.
   *
   * The same key as the entry already holds is a REMOUNT of the same exchange:
   * its state is kept wholesale, so a removed widget stays removed and a report
   * still owed stays owed. A different key is a NEW exchange, whose report
   * cycle starts over. Either way the generation advances, so whatever the
   * previous session still had in flight is superseded at its next checkpoint.
   */
  acquire(exchangeKey: string): number;
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
  /** Why this widget was retired, once it has been. */
  readonly reason: McpFailureReason | undefined;
}

interface Entry {
  generation: number;
  /**
   * The resource/server identity of the exchange this entry records, so a
   * later `acquire` can tell a remount of the same widget from a new one.
   */
  exchangeKey?: string;
  phase: McpWidgetPhase;
  /**
   * The generation whose proxy response moved this entry to `retiring`. That
   * response is still on its way out, and its own path must be the one to
   * conclude the retirement - even if a same-exchange remount has advanced
   * the generation in the meantime.
   */
  retiringGeneration?: number;
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
 * Soft cap on entries kept per agent. Soft because only some entries may ever
 * be forgotten, see {@link evictForgettable}.
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

/**
 * Whether this failure owes the user an explanation.
 *
 * Every terminal failure does, on either path. An earlier version exempted a
 * tool error on the initial activity, on the grounds that the model had seen it
 * in its own run and would mention it. Driving the real demo in a browser
 * disproved that: the model saw the error and said nothing, so the user was
 * left with a widget vanishing and no explanation at all, which is precisely
 * what this feature exists to prevent. A possibly redundant sentence is a much
 * smaller cost than a silent failure.
 *
 * What still never reports: anything not established as a live, settled
 * exchange. History (`untracked`) must never start a run, and `pending` or
 * `unknown` are not terminal yet.
 */
function shouldReserve(
  observation: McpObservation,
  verdict: McpContentVerdict,
): boolean {
  return verdict.kind === "retire" && observation.exchange === "settled";
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

  /**
   * A generation allowed to conclude a retirement, or the report it reserved:
   * the current one, or the one whose proxy response is still pending. A
   * same-exchange remount advances the generation while that response is in
   * flight; the response's own path must still be able to finish what it
   * started, or the exchange would stay `retiring` for good.
   */
  const concluding = (generation: number): Entry | undefined => {
    const entry = current();
    return entry.generation === generation ||
      entry.retiringGeneration === generation
      ? entry
      : undefined;
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

    get reason() {
      return current().reason;
    },

    acquire(exchangeKey) {
      const entry = current();
      entry.lastTouched = Date.now();
      // The generation advances on every acquire, remount or not: the session
      // that quoted the old one is being torn down, and anything it still has
      // in flight must find itself superseded at its next checkpoint rather
      // than act on behalf of the session replacing it.
      entry.generation += 1;

      if (entry.exchangeKey === exchangeKey) {
        // Same widget mounting again. Its history is the whole point of keeping
        // the entry: a removed widget must not come back because the adapter
        // re-rendered it, and a reservation must not be lost because the
        // component that made it unmounted before committing.
        //
        // Work already in flight for this exchange is left alone too. Owning
        // the session (the generation) is not owning the report (the claim) or
        // a pending proxy retirement: an explanation run that has started
        // must still get to record its outcome, and a response still on its
        // way out must still get to conclude its retirement.
        return entry.generation;
      }

      // A genuinely different exchange for this activity (a new resource or
      // server identity). Its report cycle starts over: a failure of the new
      // exchange deserves its own explanation, and a reservation the outgoing
      // one never committed can no longer be committed by anyone. Dropping the
      // claim and the pending retirement is what supersedes the old work: it
      // re-checks them at every checkpoint and bails out.
      entry.exchangeKey = exchangeKey;
      entry.claim = undefined;
      entry.retiringGeneration = undefined;
      entry.signal = undefined;
      entry.messageId = undefined;
      entry.reason = undefined;
      entry.phase = "waiting";
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

      // Recorded on every retirement, reservation or not: the adapter is told
      // why the widget went even when nothing will be explained.
      entry.reason = verdict.reason;
      if (shouldReserve(observation, verdict)) {
        entry.signal = "reserved";
      }

      entry.phase = "retiring";
      // Nothing is owed to a widget on the activity path, so it goes now. The
      // proxy path still owes a response, so its caller finalizes after that,
      // and is recorded as the one allowed to.
      if (observation.origin === "activity") {
        entry.phase = "removed";
      } else {
        entry.retiringGeneration = generation;
      }
      return entry.phase;
    },

    finalizeRemoval(generation) {
      const entry = concluding(generation);
      if (!entry || entry.phase !== "retiring") return;
      entry.phase = "removed";
      entry.retiringGeneration = undefined;
      entry.lastTouched = Date.now();
    },

    async commitSignal(generation, host, removeFromStore) {
      const entry = concluding(generation);
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
      // Ownership of the report, once taken, is the claim alone - not the
      // generation. A same-exchange remount advances the generation while the
      // explanation run is in flight, and that run must still record its
      // outcome; a new exchange or an abandon drops the claim, which is what
      // supersedes it.
      const stillOurs = () =>
        entries.get(key) === entry && entry.claim === claim;

      const agent = identity.agent;
      const messageId = randomUUID();
      const reason = entry.reason;
      const noRun: RunAgentResult = { result: undefined, newMessages: [] };

      try {
        await mcpAppsRequestQueue.enqueue(
          agent,
          async () => {
            // Re-checked at execution: the queue waits for an idle agent, so an
            // acquire or abandon may have superseded this work while it waited,
            // and the thread may have moved on. The signal is re-read too: a
            // superseded commit that had already got past its own checkpoint
            // may have added the message while this one was queued behind it.
            if (!stillOurs() || entry.signal !== "reserved") return noRun;
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
      // Claim-owned once started, for the same reason as commitSignal.
      const stillOurs = () =>
        entries.get(key) === entry && entry.claim === claim;

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
      const entry = concluding(generation);
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
