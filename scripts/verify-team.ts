import { teamsOverview, teamDetail } from '@/services/team';

async function main() {
  const squid = '1315241523092156416';
  const ov = await teamsOverview(squid);
  if ('error' in ov) throw new Error(ov.error);
  console.log(`=== ${ov.league} — teams by predicted ROS (from wk ${ov.fromWeek}) ===`);
  for (const [i, t] of ov.teams.entries()) {
    const rec = t.record ? `${t.record.wins}-${t.record.losses}` : '·';
    console.log(`${String(i + 1).padStart(2)}. ${t.isMe ? '◆' : ' '} ${t.name.padEnd(22)} ros ${t.rosTotal.toFixed(0).padStart(5)}  po ${t.playoffTotal.toFixed(0).padStart(4)}  mkt ${String(Math.round(t.marketTotal)).padStart(6)}  ${rec}`);
  }
  const me = ov.teams.find((t) => t.isMe)!;
  const d = await teamDetail(squid, me.rosterId);
  if ('error' in d) throw new Error(d.error);
  console.log(`\n=== my team: ${d.summary.name} | ros rank ${d.rosRank} | mkt rank ${d.marketRank} ===`);
  console.log(`season ${d.seasonBand.mean.toFixed(0)} [${d.seasonBand.p10.toFixed(0)}–${d.seasonBand.p90.toFixed(0)}]`);
  console.log(`weekly sample: ${d.weeklySeries.slice(0, 3).map((w) => `w${w.week} ${w.mean.toFixed(0)} [${w.p10.toFixed(0)}–${w.p90.toFixed(0)}]`).join(' | ')}`);
  console.log(`pos strength: ${d.posStrength.map((p) => `${p.pos} #${p.rank}/${p.teams}`).join('  ')}`);
  console.log(`age: vw ${d.ageProfile.valueWeightedAge?.toFixed(1)} | ${d.ageProfile.buckets.map((b) => `${b.label} ${(b.share * 100).toFixed(0)}%`).join(' ')}`);
  console.log(`market trend points: ${d.marketTrend.length} (${d.marketTrend[0]?.date} → ${d.marketTrend[d.marketTrend.length - 1]?.date})`);
  console.log(`top roster: ${d.roster.slice(0, 5).map((r) => `${r.name} ${r.rosPts.toFixed(0)}`).join(', ')}`);
  console.log('\nhistory:');
  for (const s of d.history.seasons) {
    const rec = s.record ? `${s.record.wins}-${s.record.losses}${s.record.ties ? '-' + s.record.ties : ''}` : 'chopped/no-H2H';
    console.log(`  ${s.season} ${s.leagueName.slice(0, 28).padEnd(28)} ${rec.padEnd(8)} pf ${s.pf.toFixed(0).padStart(5)}  eff ${s.efficiency !== null ? (s.efficiency * 100).toFixed(0) + '%' : '·'}  allplay ${s.allPlayPct !== null ? (s.allPlayPct * 100).toFixed(0) + '%' : '·'}  luck ${s.luckDelta !== null ? (s.luckDelta >= 0 ? '+' : '') + (s.luckDelta * 100).toFixed(0) + 'pp' : '·'}  wks ${s.weeklyPoints.length}`);
  }
  console.log(`5yr: ${d.fiveYear ? `${d.fiveYear.wins}-${d.fiveYear.losses} | ${d.fiveYear.avgPfPerWeek?.toFixed(1)} pf/wk | eff ${(d.fiveYear.avgEfficiency! * 100).toFixed(0)}%` : 'none'}`);
  console.log(`h2h top: ${d.history.h2h.slice(0, 4).map((h) => `${h.name} ${h.wins}-${h.losses}`).join(' | ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
