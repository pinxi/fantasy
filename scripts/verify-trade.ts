import { evaluateTrade, findTrades, leagueRostersDetailed, marketMap } from '@/services/trade';

// Trade-lab acceptance script (Squidward): known-trade evaluation with an
// independent market-delta check, plus finder timing/validity.

const LEAGUE = '1315241523092156416'; // Squidward Dynasty

async function main(): Promise<void> {
  const rosters = leagueRostersDetailed(LEAGUE);
  const findPlayer = (name: string) => {
    for (const r of rosters) for (const p of r.players) if (p.label.includes(name)) return { p, r };
    throw new Error(`not rostered: ${name}`);
  };
  const laporta = findPlayer('LaPorta');
  // Target: the top player by market value on a RIVAL roster.
  const rival = rosters
    .filter((r) => !r.isMe && r.players.length > 0)
    .sort((a, b) => (b.players[0]?.marketValue ?? 0) - (a.players[0]?.marketValue ?? 0))[0]!;
  const target = rival.players[0]!;
  console.log('give:', laporta.p.label, `(${laporta.r.ownerName}${laporta.r.isMe ? ', me' : ''})`, '| receive:', target.label, `(${rival.ownerName})`);

  const result = await evaluateTrade({
    leagueId: LEAGUE,
    counterpartyRosterId: rival.rosterId,
    give: [{ kind: 'player', playerId: laporta.p.playerId! }],
    receive: [{ kind: 'player', playerId: target.playerId! }],
  });
  if ('error' in result) {
    console.log('ERROR:', result.error);
    process.exit(1);
  }
  console.log(`--- ${laporta.p.label} -> ${target.label} ---`);
  console.log('me:  dROS', result.me.deltaRos.toFixed(1), '| dWeighted', result.me.deltaWeighted.toFixed(1), '| dMarket', result.me.deltaMarket.toFixed(0));
  console.log('them: dROS', result.them.deltaRos.toFixed(1), '| dMarket', result.them.deltaMarket.toFixed(0));
  console.log('verdicts:', JSON.stringify(result.verdict), '| src:', result.marketSource, '| from wk', result.fromWeek);
  console.log('warnings:', result.warnings.join(' / ') || 'none');

  const fc = marketMap(result.league.format, result.marketSource);
  const expected = (fc.get(target.playerId!) ?? 0) - (fc.get(laporta.p.playerId!) ?? 0);
  const match = Math.abs(expected - result.me.deltaMarket) < 0.5;
  console.log('market check: expected', expected.toFixed(0), '| got', result.me.deltaMarket.toFixed(0), match ? 'MATCH' : 'MISMATCH');
  if (!match) process.exit(1);

  const t0 = Date.now();
  const proposals = await findTrades(LEAGUE, { limit: 6 });
  if ('error' in proposals) {
    console.log('finder ERROR:', proposals.error);
    process.exit(1);
  }
  console.log(`--- finder: ${Date.now() - t0}ms, ${proposals.length} proposals ---`);
  for (const p of proposals.slice(0, 4)) {
    console.log(
      ' ',
      `${p.ownerName}:`,
      p.give.map((a) => a.label).join(' + '),
      '->',
      p.receive.map((a) => a.label).join(' + '),
      `| +${p.myDeltaRos.toFixed(0)} ROS | ${Math.round(p.plausibility * 100)}% | their mkt ${p.theirDeltaMarket >= 0 ? '+' : ''}${Math.round(p.theirDeltaMarket)}`,
    );
  }
  process.exit(0);
}

void main();
