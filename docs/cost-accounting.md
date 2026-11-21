# Cost accounting

What the Workshop counts as spent on AI, where, and how a Gatekeeper's spending reaches it. This is the *counting*; limits and billing to a user's own credits are in [AI Gateway billing](./ai-gateway-billing.md).

A cost is counted from the AI Gateway log of the request that made it: the cost the gateway recorded, with its token counts and the model that answered. Where no log can be read, the catalog-priced estimate is counted instead and the line says so (`estimated`).

## What is counted where

| What | Counted to | Source | Cost from |
| --- | --- | --- | --- |
| Chat turns, including tool-call rounds | the workspace | `chat` | the request's gateway log, else the catalog estimate |
| Chat, thread and gadget titles, and the names given to bindings | the workspace | `title` | the same |
| Compaction | the workspace | `compaction` | the same |
| Cache-warm pings (the resend that keeps a prompt cache alive while a chat is viewed) | the workspace | `chat` | the same |
| A model binding's requests (`creationSpec.type === "aiModel"`) | the workspace | `model-binding` | the binding reports each one (`ApprovalQueue.reportCost`): its log id, else its estimate |
| An approved Gatekeeper action that spends | the workspace | `action` | the Gatekeeper's answer to `getActionCost` and the log it names (below) |
| Voice: transcription, speech | the person's own ledger | `voice` | the call's gateway log, a $0 one as $0 (voice has no estimate); nothing is counted without one |

The Overseer sets the source from the path a cost arrived by; a report never names it. Every line of a breakdown carries its source, so chat, model bindings and actions show apart.

## Ledger and summary

Each workspace keeps a **ledger**: one line per source, kind (`text`, `image`, `video`, `music`, `speech`, `transcription`), model picked, model that answered (when the picked model is the Auto Router, `cloudflare/auto`; no other model's line names one, since the gateway may spell a model asked for by name otherwise than the catalog) and estimate flag, each with a running dollar total, request count and token totals (`CostLine`, `cost-ledger.ts`). Its `totalCost` is the sum of the lines. Totals counted before the ledger existed have no breakdown and appear as one `chat` `text` line with the model `"earlier"` (shown as "earlier (not broken down)"), until the lines account for them.

`AuthenticatedApi.getMyCostSummary()` answers the caller's own total, by kind and by model, with the lines behind it. A user is counted as having spent:

- the workspaces they **own**, collaborators' spend in them included;
- the workspaces they **deleted**: a workspace's final cost is folded into one bucket on its owner when it is removed;
- their **own ledger**: voice, which belongs to no workspace.

A workspace shared with someone counts to its owner, never to them. A cost reaches the owner's summary from the workspace's own ledger, through the same retried delivery as the other updates a workspace sends its owner; a workspace delivering a cost also resets the owner-update retry once a drain has gone clean, so a collaborator's update can arrive slightly sooner or later than it did.

## Gatekeeper action costs

An action that spends (a generated image, say) cannot report its cost when it is proposed, and may finish minutes after it is approved. A Gatekeeper opts in; the Overseer asks.

1. The action's description sets `reportsCost: true`.
2. The Gatekeeper's session answers `getCostTag()` with an opaque string. The Gatekeeper puts it in the AI Gateway metadata of every request it makes for the action, as `tag`. The tag is how the Overseer tells which logs are the Gatekeeper's.
3. Once the action is approved the Overseer polls `getActionCost(action)`: first after 30 s, then at doubling intervals up to an hour, for at most seven days. One call has 30 s to answer, else it is asked again at the next poll.
4. The answer is one of:

| State | Meaning |
| --- | --- |
| `pending` | Not finished: ask again later. |
| `none` | Nothing was spent (cancelled, failed before the model answered, no longer known). Nothing is counted. |
| `spent` | `kind`, `model`, `estimateUsd`, and `gatewayLogId` when it knows the log. |

For `spent` the Overseer reads the log (up to six attempts for a failure worth retrying) and counts:

| Case | Counted |
| --- | --- |
| Log carries this Gatekeeper's `tag` and is at most 31 days old | the log's cost, exactly; where the log gives no cost ($0), the Gatekeeper's `estimateUsd`, capped at US$5, as a chat request falls back to its estimate |
| Log carries a different `tag` | nothing, with a warning: it is another Gatekeeper's, so its estimate is not trusted either |
| No `gatewayLogId`, log unreadable, log without a tag, or log older than 31 days or of unknown age | the Gatekeeper's `estimateUsd`, capped at US$5, once for the approved action |

A log id is counted once, also where the estimate was counted for it because it stayed unreadable or gave no cost. The Overseer remembers the ids it counted and prunes them after 31 days, the age past which it refuses a log, so a repeated answer never counts twice. A Gatekeeper that does not set `reportsCost`, or does not implement `getActionCost`, is never polled. `reportCost` is for model bindings only and is refused for any other Gatekeeper.

The Media Studio Gatekeeper of the custom Gatekeeper package is the example: it tags each job, records the log id when the model answers, and answers `getActionCost` from the job it kept.

### Voice

Voice calls run in the Workshop's own code, so no Gatekeeper is asked. The log id is read from the AI binding after the call, a binding overlapping calls share, so it can belong to another call. A log therefore counts only when its metadata `user` is the person recording it and its `source` is `voice` (a chat request's log carries the user too, and is the workspace's), and each log id counts once (pruned after 31 days). Under heavy concurrency a call can go uncounted; it is never charged to someone else.

## Not counted

The Agent Swarm, harness panes and the Security Assessor run outside the Workshop's Overseer and are not in a workspace's ledger or a user's summary.

## Backfill and rollout

When the Overseer first starts on a workspace with this change, it queues the actions approved in the last 31 days for the Media Studio (`generateMedia` actions) to be asked as above, once, so recent spend is counted (`backfillActionCosts`, flagged by `actionCostsBackfilled` rather than a storage version so versions stay in step with upstream). This is specific to the deployment that had the Media Studio before action costs existed; a deployment without it queues nothing. Deploy the Workshop change together with the Gatekeeper update that adds `getActionCost` and `getCostTag`: until then the answers are missing and the backfilled rows are dropped.
