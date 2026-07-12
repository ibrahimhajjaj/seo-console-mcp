export interface InsightRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface StrikingOptions {
  minPosition?: number;
  maxPosition?: number;
  minImpressions?: number;
  limit?: number;
}

export interface StrikingItem {
  keys: string[];
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  opportunity: number;
}

export function strikingDistance(rows: InsightRow[], options: StrikingOptions = {}): StrikingItem[] {
  const { minPosition = 5, maxPosition = 20, minImpressions = 10, limit = 50 } = options;
  return rows
    .filter(({ position, impressions }) => position >= minPosition && position <= maxPosition && impressions >= minImpressions)
    .map((row) => ({ ...row, opportunity: row.impressions * row.position }))
    .sort((left, right) => right.opportunity - left.opportunity)
    .slice(0, limit);
}

export interface CompareOptions {
  limit?: number;
}

export interface CompareItem {
  keys: string[];
  clicksCurrent: number;
  clicksPrevious: number;
  clicksDelta: number;
  impressionsDelta: number;
  positionDelta: number;
}

export interface CompareResult {
  gainers: CompareItem[];
  losers: CompareItem[];
}

export function comparePeriods(current: InsightRow[], previous: InsightRow[], options: CompareOptions = {}): CompareResult {
  const { limit = 50 } = options;
  const currentByKey = new Map(current.map((row) => [row.keys.join("\0"), row]));
  const previousByKey = new Map(previous.map((row) => [row.keys.join("\0"), row]));
  const joinedKeys = new Set([...currentByKey.keys(), ...previousByKey.keys()]);
  const items = [...joinedKeys].map((key): CompareItem => {
    const currentRow = currentByKey.get(key);
    const previousRow = previousByKey.get(key);
    const currentPosition = currentRow?.position ?? 0;
    const previousPosition = previousRow?.position ?? 0;
    const clicksCurrent = currentRow?.clicks ?? 0;
    const clicksPrevious = previousRow?.clicks ?? 0;
    return {
      keys: currentRow?.keys ?? previousRow?.keys ?? [],
      clicksCurrent,
      clicksPrevious,
      clicksDelta: clicksCurrent - clicksPrevious,
      impressionsDelta: (currentRow?.impressions ?? 0) - (previousRow?.impressions ?? 0),
      positionDelta: currentPosition === 0 || previousPosition === 0 ? 0 : currentPosition - previousPosition,
    };
  });

  return {
    gainers: items.filter(({ clicksDelta }) => clicksDelta > 0).sort((left, right) => right.clicksDelta - left.clicksDelta).slice(0, limit),
    losers: items.filter(({ clicksDelta }) => clicksDelta < 0).sort((left, right) => left.clicksDelta - right.clicksDelta).slice(0, limit),
  };
}

export interface CtrGapOptions {
  minImpressions?: number;
  limit?: number;
}

export interface CtrGapItem {
  keys: string[];
  impressions: number;
  ctr: number;
  expectedCtr: number;
  position: number;
  missedClicks: number;
}

export function ctrGaps(rows: InsightRow[], options: CtrGapOptions = {}): CtrGapItem[] {
  const { minImpressions = 100, limit = 50 } = options;
  const bucketTotals = new Map<number, { totalCtr: number; count: number }>();
  for (const row of rows) {
    const bucket = Math.round(row.position);
    const total = bucketTotals.get(bucket) ?? { totalCtr: 0, count: 0 };
    total.totalCtr += row.ctr;
    total.count += 1;
    bucketTotals.set(bucket, total);
  }

  return rows
    .map((row): CtrGapItem => {
      const bucket = bucketTotals.get(Math.round(row.position));
      const expectedCtr = bucket ? bucket.totalCtr / bucket.count : row.ctr;
      return {
        keys: row.keys,
        impressions: row.impressions,
        ctr: row.ctr,
        expectedCtr,
        position: row.position,
        missedClicks: Math.round(row.impressions * (expectedCtr - row.ctr)),
      };
    })
    .filter(({ impressions, ctr, expectedCtr }) => impressions >= minImpressions && ctr < expectedCtr)
    .sort((left, right) => right.missedClicks - left.missedClicks)
    .slice(0, limit);
}

export interface CannibalOptions {
  minImpressions?: number;
}

export interface CannibalGroup {
  query: string;
  pages: Array<{ page: string; impressions: number; clicks: number; position: number }>;
}

export function cannibalization(rows: InsightRow[], options: CannibalOptions = {}): CannibalGroup[] {
  const { minImpressions = 10 } = options;
  const groups = new Map<string, CannibalGroup["pages"]>();
  for (const row of rows) {
    const query = row.keys[0];
    const page = row.keys[1];
    if (query === undefined || page === undefined || row.impressions < minImpressions) continue;
    const pages = groups.get(query) ?? [];
    pages.push({ page, impressions: row.impressions, clicks: row.clicks, position: row.position });
    groups.set(query, pages);
  }

  return [...groups]
    .filter(([, pages]) => pages.length >= 2)
    .map(([query, pages]) => ({ query, pages: pages.sort((left, right) => right.impressions - left.impressions) }))
    .sort((left, right) => sumImpressions(right.pages) - sumImpressions(left.pages));
}

function sumImpressions(pages: CannibalGroup["pages"]): number {
  return pages.reduce((total, page) => total + page.impressions, 0);
}
