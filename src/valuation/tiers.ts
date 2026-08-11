// Gap-cluster tiers within a position: a new tier starts where the drop
// between consecutive players is large relative to the local gap scale.

export function assignTiers(pointsDesc: number[]): number[] {
  if (pointsDesc.length === 0) return [];
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(pointsDesc.length, 60); i++) {
    const gap = pointsDesc[i - 1]! - pointsDesc[i]!;
    if (gap > 0) gaps.push(gap);
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const median = sortedGaps.length > 0 ? sortedGaps[Math.floor(sortedGaps.length / 2)]! : 0;
  const breakAt = Math.max(6, median * 2.5);

  const tiers: number[] = [1];
  let tier = 1;
  for (let i = 1; i < pointsDesc.length; i++) {
    const gap = pointsDesc[i - 1]! - pointsDesc[i]!;
    if (gap >= breakAt && tier < 12) tier++;
    tiers.push(tier);
  }
  return tiers;
}
