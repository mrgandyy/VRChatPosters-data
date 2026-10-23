// Turning "fri" + "9pm" + "America/Chicago" into an exact moment, for /event and /collab.

export const TIMEZONES: { name: string; value: string }[] = [
  { name: 'US Eastern (New York)', value: 'America/New_York' },
  { name: 'US Central (Chicago)', value: 'America/Chicago' },
  { name: 'US Mountain (Denver)', value: 'America/Denver' },
  { name: 'US Arizona (Phoenix)', value: 'America/Phoenix' },
  { name: 'US Pacific (Los Angeles)', value: 'America/Los_Angeles' },
  { name: 'Alaska', value: 'America/Anchorage' },
  { name: 'Hawaii', value: 'Pacific/Honolulu' },
  { name: 'Mexico City', value: 'America/Mexico_City' },
  { name: 'Brazil (São Paulo)', value: 'America/Sao_Paulo' },
  { name: 'UK (London)', value: 'Europe/London' },
  { name: 'Central Europe (Berlin, Paris)', value: 'Europe/Berlin' },
  { name: 'Eastern Europe (Athens)', value: 'Europe/Athens' },
  { name: 'Japan (Tokyo)', value: 'Asia/Tokyo' },
  { name: 'Philippines (Manila)', value: 'Asia/Manila' },
  { name: 'Australia East (Sydney)', value: 'Australia/Sydney' },
  { name: 'Australia West (Perth)', value: 'Australia/Perth' },
  { name: 'New Zealand', value: 'Pacific/Auckland' },
  { name: 'UTC', value: 'UTC' },
];

function offsetMs(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in a time zone → UTC epoch ms (handles daylight saving). */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(ts, tz);
  if (second !== ts) ts = second;
  return ts;
}

/** Today's date (y, m, d) as seen in a time zone. */
function todayIn(tz: string, now: number): { y: number; m: number; d: number; dow: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
    .formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const dows = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return { y: +parts.year!, m: +parts.month!, d: +parts.day!, dow: dows.indexOf(parts.weekday!.toLowerCase().slice(0, 3)) };
}

function addDays(y: number, m: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Parses friendly inputs. Date: "today", "tomorrow", "fri"/"friday" (the next one, or today),
 * "10/17", "10/17/2026", "2026-10-17". Time: "9pm", "9:30 pm", "21:00", "2100".
 * Returns epoch ms, or a message saying what to type instead.
 */
export function parseWhen(dateText: string, timeText: string, tz: string, now = Date.now()): number | string {
  const t = timeText.trim().toLowerCase().replace(/\s+/g, '');
  const tm = /^(\d{1,2})(?::?(\d{2}))?(am|pm)?$/.exec(t);
  if (!tm) return 'Type the time like 9pm, 9:30pm or 21:00.';
  let hh = +tm[1]!; const mm = tm[2] ? +tm[2] : 0;
  if (tm[3]) { if (hh < 1 || hh > 12) return 'Use 1–12 with am/pm, like 9pm.'; hh = hh % 12 + (tm[3] === 'pm' ? 12 : 0); }
  if (hh > 23 || mm > 59) return 'That time doesn\'t exist. Try 9pm or 21:00.';

  const today = todayIn(tz, now);
  const dt = dateText.trim().toLowerCase();
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  let ymd: { y: number; m: number; d: number } | null = null;
  if (dt === 'today' || dt === 'tonight') ymd = today;
  else if (dt === 'tomorrow') ymd = addDays(today.y, today.m, today.d, 1);
  else if (days.includes(dt.slice(0, 3)) && /^[a-z]+$/.test(dt)) {
    const want = days.indexOf(dt.slice(0, 3));
    ymd = addDays(today.y, today.m, today.d, (want - today.dow + 7) % 7);
  } else {
    let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dt);
    if (mt) ymd = { y: +mt[1]!, m: +mt[2]!, d: +mt[3]! };
    else if ((mt = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(dt))) {
      const y = mt[3] ? (mt[3].length === 2 ? 2000 + +mt[3] : +mt[3]) : today.y;
      ymd = { y, m: +mt[1]!, d: +mt[2]! };
      // "10/1" typed in December means next year's.
      if (!mt[3] && zonedToUtc(ymd.y, ymd.m, ymd.d, 23, 59, tz) < now - 86400_000) ymd = { ...ymd, y: ymd.y + 1 };
    }
  }
  if (!ymd) return 'Type the date like friday, tomorrow, 10/17 or 2026-10-17.';
  const check = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
  if (check.getUTCMonth() !== ymd.m - 1 || check.getUTCDate() !== ymd.d) return 'That date doesn\'t exist.';
  return zonedToUtc(ymd.y, ymd.m, ymd.d, hh, mm, tz);
}

/** Discord's own timestamp tag: shows in every reader's local time. */
export const discordTime = (ms: number, style: 'F' | 'f' | 'R' | 't' = 'F') => `<t:${Math.floor(ms / 1000)}:${style}>`;
