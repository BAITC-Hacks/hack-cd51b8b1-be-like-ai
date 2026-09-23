// Convert the entered wall time in the selected IANA zone, not the browser zone.
export function meetingDateToISO(
  value: string,
  timezone: string,
): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Укажите корректные дату и время.");
  const [, y, mo, d, h, mi] = match.map(Number);
  const target = Date.UTC(y, mo - 1, d, h, mi);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const wallTime = (timestamp: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(timestamp).map((p) => [p.type, p.value]),
    );
    return Date.UTC(
      +parts.year,
      +parts.month - 1,
      +parts.day,
      +parts.hour,
      +parts.minute,
      +parts.second,
    );
  };
  const offsets = new Set(
    [-86400000, 0, 86400000].map(
      (delta) => wallTime(target + delta) - (target + delta),
    ),
  );
  const candidates = [...offsets]
    .map((offset) => target - offset)
    .filter((timestamp) => wallTime(timestamp) === target);
  if (candidates.length !== 1)
    throw new Error(
      "Это время неоднозначно или отсутствует из-за перевода часов. Укажите другое время.",
    );
  const actual = new Date(target);
  if (
    actual.getUTCMonth() !== mo - 1 ||
    actual.getUTCDate() !== d ||
    h > 23 ||
    mi > 59
  )
    throw new Error("Укажите корректные дату и время.");
  return new Date(candidates[0]).toISOString();
}
