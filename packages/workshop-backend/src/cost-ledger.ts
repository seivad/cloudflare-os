// A cost breakdown: the lines a workspace's (or a user's) spend is counted in, one running total
// per source, kind, model, answering model and estimate flag (see CostLine). Pure functions over arrays of
// lines; where they are stored is the caller's business (Overseer.recordCost, `costLines`).

import {
  AUTO_ROUTER_MODEL_ID, type CostKind, type CostLine, type CostSource,
} from "@gadgets/workshop-shared/api";
import type { ActionCost } from "@gadgets/workshop-shared/gatekeeper";
import type { AiGatewayLogRecord } from "./ai-gateway";
import type { MeteredRequest } from "./ai-invoke";
import { costLineKey } from "./storage-schema/overseer-storage";

export { costLineKey };

/**
 * One request's cost, as it is counted into a line once its source is known (see
 * CostAttribution).
 */
export type CostEntry = {
  kind: CostKind;
  model: string;
  answeredBy?: string;
  estimated: boolean;
  usd: number;
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * Where a cost is counted and what made the request: the workspace, and the chat `chatId` names,
 * if any. The Overseer sets it from the path the cost arrived by, never from a report.
 * `isActivity` says whether the cost moves the chat's lastActive (see Overseer.recordCost).
 */
export type CostAttribution = { source: CostSource; chatId?: number; isActivity: boolean };

/** The model a line holds totals from before costs were broken down. */
export const EARLIER_MODEL = "earlier";

// Below this, a total and the sum of its lines differ only by floating-point rounding.
const ROUNDING_USD = 0.000001;

/** `line` (absent for a new one) with `entry`'s cost counted into it as one more request. */
export function addToLine(line: CostLine | undefined, entry: CostEntry & { source: CostSource })
    : CostLine {
  return combine(line, { ...entry, requests: 1 });
}

/** `lines` with `entry` counted into its line, appended when it has none. */
export function addCost(lines: CostLine[], entry: CostEntry & { source: CostSource }): CostLine[] {
  return addLine(lines, { ...entry, requests: 1 });
}

/** `a` and `b` as one breakdown, lines with the same key added together. */
export function mergeLines(a: CostLine[], b: CostLine[]): CostLine[] {
  return b.reduce(addLine, a);
}

/**
 * `lines` and, when they count less than `totalCost`, a chat text line with model "earlier"
 * holding the rest: what was counted before costs were broken down, all of which was chat.
 */
export function withEarlier(totalCost: number, lines: CostLine[]): CostLine[] {
  let rest = totalCost - lines.reduce((sum, line) => sum + line.usd, 0);
  return rest > ROUNDING_USD
    ? [...lines, { source: "chat", kind: "text", model: EARLIER_MODEL, estimated: false, usd: rest,
      requests: 0 }]
    : lines;
}

/**
 * The model that answered a request for `model`, as a line names it: `answered` (the log's, else
 * the response's) where `model` is the Auto Router, which picks another; otherwise none, since
 * the gateway may spell a model asked for by name otherwise than the catalog does.
 */
function answeredBy(model: string, answered: string | undefined): string | undefined {
  return model === AUTO_ROUTER_MODEL_ID && answered !== model ? answered : undefined;
}

/**
 * What a text request costs: AI Gateway's logged cost where `log` gives a positive one, else the
 * catalog-priced estimate in its usage; undefined when there is neither. For the Auto Router it
 * was answered by the model the log names, else the response. Tokens are the log's where it
 * counts them.
 */
export function textCostEntry(request: MeteredRequest, log: AiGatewayLogRecord | undefined)
    : CostEntry | undefined {
  let { model, usage } = request;
  let answered = answeredBy(model, log?.model ?? request.answeredBy);
  let picked = {
    kind: "text" as const, model, ...(answered !== undefined ? { answeredBy: answered } : {}),
  };
  let inputTokens = usage && usage.input + usage.cacheRead + usage.cacheWrite;
  if (log?.cost) {
    return { ...picked, estimated: false, usd: log.cost,
      inputTokens: log.tokensIn ?? inputTokens, outputTokens: log.tokensOut ?? usage?.output };
  }
  if (usage?.cost.total) {
    return { ...picked, estimated: true, usd: usage.cost.total,
      inputTokens, outputTokens: usage.output };
  }
  return undefined;
}

/** The most a Gatekeeper's estimate counts for, for one approved action whose log can't be read. */
export const MAX_UNLOGGED_ACTION_COST_USD = 5;

/** How old a Gatekeeper-reported AI Gateway log may be and still count. */
export const MAX_REPORTED_LOG_AGE_DAYS = 31;

const MAX_REPORTED_LOG_AGE_MS = MAX_REPORTED_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;

const COST_KINDS: ReadonlySet<string> =
    new Set<CostKind>(["text", "image", "video", "music", "speech", "transcription"]);

/**
 * Whether a Gatekeeper's getActionCost() answer is an ActionCost. Nothing checks what a Gatekeeper
 * returns on the way back, and its estimate is counted.
 */
export function isActionCost(value: unknown): value is ActionCost {
  if (typeof value !== "object" || value === null) return false;
  let cost = value as Record<string, unknown>;
  if (cost.state === "pending" || cost.state === "none") return true;
  return cost.state === "spent" && typeof cost.kind === "string" && COST_KINDS.has(cost.kind) &&
      typeof cost.model === "string" && typeof cost.estimateUsd === "number" &&
      Number.isFinite(cost.estimateUsd) && cost.estimateUsd >= 0 &&
      (cost.gatewayLogId === undefined || typeof cost.gatewayLogId === "string");
}

/**
 * Whether `log` is one an approved action's cost is counted from: it carries the tag the action's
 * Gatekeeper was given (`tag`), and was made no more than MAX_REPORTED_LOG_AGE_DAYS before `now`.
 */
export function isActionLog(log: AiGatewayLogRecord | undefined, tag: string | undefined,
                            now: number): log is AiGatewayLogRecord {
  let logTag = log?.metadata?.tag;
  return logTag !== undefined && logTag === tag && log?.createdAt !== undefined &&
      now - log.createdAt.valueOf() <= MAX_REPORTED_LOG_AGE_MS;
}

/**
 * What an approved action that spent counts as, or null for nothing. The cost AI Gateway logged
 * for it, where `log` is an action log (isActionLog) with a positive cost. Null where the log
 * carries another tag: a Gatekeeper reporting another's log has no estimate worth taking either.
 * Otherwise (no log, an untagged log, one too old or of unknown age, or an action log that gives
 * no cost, as a chat request's falls back to its estimate) the Gatekeeper's estimate, up to
 * MAX_UNLOGGED_ACTION_COST_USD.
 */
export function actionCostEntry(
    cost: Extract<ActionCost, { state: "spent" }>, log: AiGatewayLogRecord | undefined,
    tag: string | undefined, now: number): CostEntry | null {
  let { kind, model } = cost;
  let logTag = log?.metadata?.tag;
  if (logTag !== undefined && logTag !== tag) return null;
  if (!isActionLog(log, tag, now) || log.cost <= 0) {
    return { kind, model, estimated: true,
      usd: Math.min(cost.estimateUsd, MAX_UNLOGGED_ACTION_COST_USD) };
  }
  let answered = answeredBy(model, log.model);
  return {
    kind, model, estimated: false, usd: log.cost,
    ...(answered !== undefined ? { answeredBy: answered } : {}),
    ...(log.tokensIn !== undefined ? { inputTokens: log.tokensIn } : {}),
    ...(log.tokensOut !== undefined ? { outputTokens: log.tokensOut } : {}),
  };
}

/** Dollars by kind. */
export function byKind(lines: CostLine[]): Partial<Record<CostKind, number>> {
  let totals: Partial<Record<CostKind, number>> = {};
  for (let line of lines) totals[line.kind] = (totals[line.kind] ?? 0) + line.usd;
  return totals;
}

/** Dollars by the model that was picked: a router's lines count under the router. */
export function byModel(lines: CostLine[]): Record<string, number> {
  let totals: Record<string, number> = {};
  for (let line of lines) totals[line.model] = (totals[line.model] ?? 0) + line.usd;
  return totals;
}

function addLine(lines: CostLine[], add: CostLine): CostLine[] {
  let key = costLineKey(add);
  let index = lines.findIndex(line => costLineKey(line) === key);
  return index < 0
    ? [...lines, combine(undefined, add)]
    : lines.map((line, i) => i === index ? combine(line, add) : line);
}

// A new line object, so that neither input is changed. Built field by field, so that whatever
// else `add` carries (a recordCost entry's attribution) stays out of it.
function combine(line: CostLine | undefined, add: CostLine): CostLine {
  let inputTokens = sumKnown(line?.inputTokens, add.inputTokens);
  let outputTokens = sumKnown(line?.outputTokens, add.outputTokens);
  return {
    source: add.source,
    kind: add.kind,
    model: add.model,
    ...(add.answeredBy !== undefined ? { answeredBy: add.answeredBy } : {}),
    estimated: add.estimated,
    usd: (line?.usd ?? 0) + add.usd,
    requests: (line?.requests ?? 0) + add.requests,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function sumKnown(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : a + b;
}
