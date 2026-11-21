// A cost breakdown: the lines a workspace's (or a user's) spend is counted in, one running total
// per kind, model, answering model and estimate flag (see CostLine). Pure functions over arrays of
// lines; where they are stored is the caller's business (Overseer.recordCost, `costLines`).

import type { CostKind, CostLine, CostSource } from "@gadgets/workshop-shared/api";
import type { AiGatewayLogRecord } from "./ai-gateway";
import type { MeteredRequest } from "./ai-invoke";
import { costLineKey } from "./storage-schema/overseer-storage";

export { costLineKey };

/** One request's cost, as it is counted into a line. */
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
export function addToLine(line: CostLine | undefined, entry: CostEntry): CostLine {
  return combine(line, { ...entry, requests: 1 });
}

/** `lines` with `entry` counted into its line, appended when it has none. */
export function addCost(lines: CostLine[], entry: CostEntry): CostLine[] {
  return addLine(lines, { ...entry, requests: 1 });
}

/** `a` and `b` as one breakdown, lines with the same key added together. */
export function mergeLines(a: CostLine[], b: CostLine[]): CostLine[] {
  return b.reduce(addLine, a);
}

/**
 * `lines` and, when they count less than `totalCost`, a text line with model "earlier" holding
 * the rest: what was counted before costs were broken down, all of which was chat.
 */
export function withEarlier(totalCost: number, lines: CostLine[]): CostLine[] {
  let rest = totalCost - lines.reduce((sum, line) => sum + line.usd, 0);
  return rest > ROUNDING_USD
    ? [...lines, { kind: "text", model: EARLIER_MODEL, estimated: false, usd: rest, requests: 0 }]
    : lines;
}

/**
 * What a text request costs: AI Gateway's logged cost where `log` gives a positive one, else the
 * catalog-priced estimate in its usage; undefined when there is neither. It was answered by the
 * model the log names, else the response, where that is not the one picked. Tokens are the log's
 * where it counts them.
 */
export function textCostEntry(request: MeteredRequest, log: AiGatewayLogRecord | undefined)
    : CostEntry | undefined {
  let { model, usage } = request;
  let answered = log?.model ?? request.answeredBy;
  let picked = { kind: "text" as const, model, answeredBy: answered !== model ? answered : undefined };
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
