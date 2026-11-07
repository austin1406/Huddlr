// Calendar helpers on "YYYY-MM-DD" strings. All pure: no clock, no timezone except where passed in.

export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const DAY_MS = 86_400_000;

function toMs(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

export function addDays(date: string, n: number): string {
  return new Date(toMs(date) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

export function lastDayOfMonth(date: string): number {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
}

/** A bill due on day N of the month falls on the last day of shorter months. */
export function billDueOn(dayOfMonth: number, date: string): boolean {
  return Number(date.slice(8, 10)) === Math.min(dayOfMonth, lastDayOfMonth(date));
}

/** Paydays repeat every `everyDays` after the last one. The last payday itself does not count again. */
export function isPayday(lastPaid: string, everyDays: number, date: string): boolean {
  const n = daysBetween(lastPaid, date);
  return n > 0 && n % everyDays === 0;
}

/** Paydays from `from` through `to`, inclusive. */
export function paydaysBetween(lastPaid: string, everyDays: number, from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isPayday(lastPaid, everyDays, d)) out.push(d);
  return out;
}

/** First payday strictly after `date`. */
export function nextPaydayAfter(lastPaid: string, everyDays: number, date: string): string {
  const since = Math.max(daysBetween(lastPaid, date), 0);
  return addDays(lastPaid, (Math.floor(since / everyDays) + 1) * everyDays);
}

/** Offset of `timeZone` from UTC at an instant, in milliseconds (local minus UTC). */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000;
}

/** The instant a local calendar day ends (local midnight that starts the next day), in `timeZone`. */
export function endOfLocalDay(date: string, timeZone: string): Date {
  const wallClock = toMs(addDays(date, 1));
  let ms = wallClock - zoneOffsetMs(wallClock, timeZone);
  ms = wallClock - zoneOffsetMs(ms, timeZone); // second pass settles daylight-saving edges
  return new Date(ms);
}

/** A stable instant for events that belong to a calendar day: 09:00 Central, expressed as 15:00 UTC. */
export function morningOf(date: string): string {
  return `${date}T15:00:00.000Z`;
}
