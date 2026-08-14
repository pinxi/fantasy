import { weekReport } from '@/services/matchup';

async function main() {
  for (const [label, id] of [
    ['Squidward', '1315241523092156416'],
    ['Sunnydale', '1313588804342251520'],
  ] as const) {
    const r = await weekReport(id);
    if ('error' in r) {
      console.log(`${label}: ERROR ${r.error}`);
      continue;
    }
    console.log(`\n=== ${label} week ${r.week} vs ${r.opponentName}${r.synthetic ? ' (synthetic)' : ''} ===`);
    console.log(`win prob ${(r.winProb * 100).toFixed(1)}% | me ${r.myTotalMean.toFixed(1)} vs ${r.oppTotalMean.toFixed(1)} | ${r.stance}`);
    console.log('my lineup:');
    for (const row of r.myLineup) {
      const band = row.p10 !== null && row.p90 !== null ? ` [${row.p10.toFixed(0)}–${row.p90.toFixed(0)}]` : '';
      console.log(`  ${row.slot.padEnd(11)} ${row.name.padEnd(24)} ${row.pos.padEnd(3)} ${row.mean.toFixed(1)}${band}`);
    }
    console.log('suggestions:');
    for (const s of r.suggestions.slice(0, 6)) {
      console.log(
        `  ${s.slot}: ${s.out} → ${s.in}  Δwin ${s.deltaWin >= 0 ? '+' : ''}${s.deltaWin.toFixed(1)}pp  Δmean ${s.deltaMean >= 0 ? '+' : ''}${s.deltaMean.toFixed(1)}${s.disagree ? '  ⚡DISAGREE' : ''}`,
      );
    }
    if (r.suggestions.length === 0) console.log('  (none — lineup already optimal by both lenses)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
