import { z } from "zod";
import { AccountId, isoDateTime } from "./common";

export const EventType = z.enum([
  "big_purchase",
  "paycheck_landed",
  "bill_due_soon",
  "forecast_problem",
  "user_transfer_seen",
  "p2p_imbalance",
]);
export type EventType = z.infer<typeof EventType>;

export const Severity = z.enum(["low", "medium", "high"]);
export type Severity = z.infer<typeof Severity>;

/**
 * One thing that happened to the customer's money. `id` is the duplicate-protection key:
 * derive it from the source record (see makeEventId), never from the time, so the same
 * Nessie transaction can never produce two events.
 */
export const FinanceEvent = z.object({
  id: z.string().min(1),
  type: EventType,
  occurredAt: isoDateTime,
  severity: Severity,
  accountId: AccountId.nullable(),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type FinanceEvent = z.infer<typeof FinanceEvent>;

export const EventsResponse = z.object({ events: z.array(FinanceEvent) });
export type EventsResponse = z.infer<typeof EventsResponse>;

/** "evt_big_purchase_nessie-purchase-0412": type plus a key unique to the source record. */
export function makeEventId(type: EventType, sourceKey: string): string {
  return `evt_${type}_${sourceKey}`;
}
