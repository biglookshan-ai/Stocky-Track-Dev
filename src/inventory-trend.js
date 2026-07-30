export const TREND_STATES = new Set(['available', 'on_hand', 'committed', 'incoming']);
export const TREND_RANGES = new Set(['30', '90', '180', 'all']);

const dayStart = (value) => {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

export function trendStart(range, earliestAt, now = new Date()) {
  if (range === 'all') return earliestAt ? dayStart(earliestAt) : null;
  const days = Number(range);
  const start = dayStart(now);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return start;
}

export function buildInventoryTrend({
  current,
  deltas = [],
  from,
  to = new Date(),
  hasHistory = false,
}) {
  if (current === null || current === undefined || !from) {
    return { hasHistory, current: current ?? null, points: [] };
  }

  const changes = deltas
    .map((row) => ({
      at: new Date(row.at).toISOString(),
      delta: Number(row.delta || 0),
      activity: row.activity || 'inventory_updated',
      location: row.location || '',
    }))
    .sort((a, b) => +new Date(a.at) - +new Date(b.at));
  const totalDelta = changes.reduce((sum, row) => sum + row.delta, 0);
  let value = Number(current) - totalDelta;
  const points = [{
    at: dayStart(from).toISOString(),
    value,
    delta: null,
    kind: 'baseline',
  }];

  for (const change of changes) {
    value += change.delta;
    points.push({
      at: change.at,
      value,
      delta: change.delta,
      kind: 'change',
      activity: change.activity,
      location: change.location,
    });
  }

  const end = new Date(to);
  const latest = points[points.length - 1];
  if (+new Date(latest.at) < +end || latest.value !== Number(current)) {
    points.push({
      at: end.toISOString(),
      value: Number(current),
      delta: null,
      kind: 'current',
    });
  } else {
    latest.kind = 'current';
  }

  return { hasHistory, current: Number(current), points };
}
