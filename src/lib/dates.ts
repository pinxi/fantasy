const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// NFL days align with US/Eastern; all snapshot dates use the ET calendar day.
export function snapshotDate(at: Date = new Date()): string {
  return ET_DATE.format(at);
}

export function nowMs(): number {
  return Date.now();
}
