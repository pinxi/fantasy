import Link from 'next/link';
import { seasonOdds, type TeamOdds } from '@/services/odds';
import { teamDetail, teamsOverview, type TeamDetail } from '@/services/team';

export const dynamic = 'force-dynamic';

const POS_COLORS: Record<string, string> = {
  QB: 'text-rose-400',
  RB: 'text-emerald-400',
  WR: 'text-sky-400',
  TE: 'text-amber-400',
  K: 'text-violet-400',
  DEF: 'text-stone-400',
  DL: 'text-orange-400',
  LB: 'text-lime-400',
  DB: 'text-cyan-400',
};

const SEASON_COLORS = ['#34d399', '#38bdf8', '#a78bfa', '#f59e0b', '#71717a'];

function WeeklyBandChart({ d }: { d: TeamDetail }) {
  // Past weeks show the FROZEN prediction of record with the actual as a dot;
  // future weeks show the latest prediction. One continuous band.
  const frozenWeeks = new Set(d.accuracy.map((a) => a.week));
  const s = [
    ...d.accuracy.map((a) => ({ week: a.week, mean: a.predicted, p10: a.p10 ?? a.predicted, p90: a.p90 ?? a.predicted, actual: a.actual })),
    ...d.weeklySeries.filter((w) => !frozenWeeks.has(w.week)).map((w) => ({ ...w, actual: null as number | null })),
  ].sort((a, b) => a.week - b.week);
  if (s.length === 0) return null;
  const values = s.flatMap((w) => [w.p90, w.p10, w.actual ?? w.mean]);
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const pad = Math.max((max - min) * 0.1, 5);
  const yOf = (v: number) => 130 - ((v - min + pad) / (max - min + 2 * pad)) * 115;
  const xOf = (i: number) => 30 + (s.length > 1 ? (i / (s.length - 1)) * 600 : 300);
  const bandPts = [...s.map((w, i) => `${xOf(i)},${yOf(w.p90)}`), ...s.map((w, i) => `${xOf(i)},${yOf(w.p10)}`).reverse()].join(' ');
  return (
    <svg viewBox="0 0 660 150" className="w-full">
      <polygon points={bandPts} fill="#3f3f46" opacity="0.35" />
      <polyline points={s.map((w, i) => `${xOf(i)},${yOf(w.mean)}`).join(' ')} fill="none" stroke="#34d399" strokeWidth="2" />
      {s.map((w, i) =>
        w.actual !== null ? (
          <circle key={`a${w.week}`} cx={xOf(i)} cy={yOf(w.actual)} r="3" fill={w.actual >= w.mean ? '#34d399' : '#f87171'} stroke="#18181b" strokeWidth="1" />
        ) : null,
      )}
      {s.map((w, i) => (
        <text key={w.week} x={xOf(i)} y="146" fill="#52525b" fontSize="9" textAnchor="middle">
          {w.week}
        </text>
      ))}
      <text x="30" y={yOf(s[0]!.mean) - 6} fill="#71717a" fontSize="10">
        {s[0]!.mean.toFixed(0)}
      </text>
    </svg>
  );
}

function HistoryChart({ d }: { d: TeamDetail }) {
  const seasons = d.history.seasons.filter((s) => s.weeklyPoints.length > 0).slice(0, 5);
  if (seasons.length === 0) return null;
  const all = seasons.flatMap((s) => s.weeklyPoints.map((w) => w.points));
  const max = Math.max(...all, 1);
  const min = Math.min(...all);
  const pad = Math.max((max - min) * 0.1, 5);
  const yOf = (v: number) => 130 - ((v - min + pad) / (max - min + 2 * pad)) * 115;
  const xOf = (week: number) => 30 + ((week - 1) / 17) * 600;
  return (
    <svg viewBox="0 0 660 150" className="w-full">
      {seasons.map((s, si) => (
        <polyline
          key={s.season}
          points={s.weeklyPoints.map((w) => `${xOf(w.week)},${yOf(w.points)}`).join(' ')}
          fill="none"
          stroke={SEASON_COLORS[si] ?? '#52525b'}
          strokeWidth={si === 0 ? 2 : 1.25}
          opacity={si === 0 ? 1 : 0.7}
        />
      ))}
      {[1, 5, 9, 13, 17].map((w) => (
        <text key={w} x={xOf(w)} y="146" fill="#52525b" fontSize="9" textAnchor="middle">
          w{w}
        </text>
      ))}
    </svg>
  );
}

function MarketTrendChart({ d }: { d: TeamDetail }) {
  const t = d.marketTrend;
  if (t.length < 2) return <p className="text-[11px] text-zinc-600">market trend needs a few days of archive ({t.length} so far)</p>;
  const values = t.map((p) => p.total);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pad = Math.max((max - min) * 0.15, 100);
  const yOf = (v: number) => 90 - ((v - min + pad) / (max - min + 2 * pad)) * 75;
  const xOf = (i: number) => 30 + (t.length > 1 ? (i / (t.length - 1)) * 580 : 290);
  const delta = values[values.length - 1]! - values[0]!;
  return (
    <svg viewBox="0 0 660 105" className="w-full">
      <polyline points={t.map((p, i) => `${xOf(i)},${yOf(p.total)}`).join(' ')} fill="none" stroke="#38bdf8" strokeWidth="2" />
      <text x={xOf(t.length - 1) + 4} y={yOf(values[values.length - 1]!) + 3} fill="#38bdf8" fontSize="10">
        {Math.round(values[values.length - 1]!).toLocaleString()}
      </text>
      <text x="30" y="102" fill="#52525b" fontSize="9">
        {t[0]!.date}
      </text>
      <text x="610" y="102" fill="#52525b" fontSize="9" textAnchor="end">
        {t[t.length - 1]!.date} ({delta >= 0 ? '+' : ''}
        {Math.round(delta)})
      </text>
    </svg>
  );
}

function SummaryBlock({ d, leagueId, odds }: { d: TeamDetail; leagueId: string; odds: TeamOdds | null }) {
  return (
    <div className="rounded border border-zinc-800 p-3">
      <div className="mb-1 flex items-baseline gap-2">
        {d.summary.isMe && <span className="text-emerald-400">◆</span>}
        <span className="font-bold text-zinc-100">{d.summary.name}</span>
        <span className="text-[11px] text-zinc-500">
          {d.summary.record ? `${d.summary.record.wins}-${d.summary.record.losses}` : ''}
        </span>
        {odds && (
          <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300" title={`monte carlo over the real schedule · exp wins ${odds.expWins.toFixed(1)}`}>
            playoff {odds.playoffPct.toFixed(0)}% · title {odds.titlePct.toFixed(1)}%
          </span>
        )}
        <span className="ml-auto text-[11px] text-zinc-500">
          ros <span className="font-bold text-zinc-200">#{d.rosRank}</span> · mkt <span className="font-bold text-zinc-200">#{d.marketRank}</span>
        </span>
      </div>
      <div className="mb-2 flex flex-wrap gap-4 font-mono text-[12px]">
        <span>
          <span className="text-zinc-500">season</span> <span className="font-bold text-zinc-100">{d.seasonBand.mean.toFixed(0)}</span>{' '}
          <span className="text-zinc-600">
            [{d.seasonBand.p10.toFixed(0)}–{d.seasonBand.p90.toFixed(0)}]
          </span>
        </span>
        <span>
          <span className="text-zinc-500">playoff wks</span> <span className="font-bold text-zinc-100">{d.summary.playoffTotal.toFixed(0)}</span>
        </span>
        <span>
          <span className="text-zinc-500">market</span> <span className="font-bold text-zinc-100">{Math.round(d.summary.marketTotal).toLocaleString()}</span>
        </span>
        {d.fiveYear && (
          <span>
            <span className="text-zinc-500">5yr</span>{' '}
            <span className="text-zinc-300">
              {d.fiveYear.wins}-{d.fiveYear.losses}
            </span>
          </span>
        )}
      </div>
      <WeeklyBandChart d={d} />
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1">
        {d.posStrength.map((p) => (
          <div key={p.pos} className="flex items-center gap-2 text-[11px]">
            <span className={`w-8 ${POS_COLORS[p.pos] ?? 'text-zinc-500'}`}>{p.pos}</span>
            <div className="relative h-1.5 flex-1 rounded-sm bg-zinc-800">
              <div
                className={`h-1.5 rounded-sm ${p.rank === 1 ? 'bg-emerald-400' : p.rank <= Math.ceil(p.teams / 3) ? 'bg-zinc-400' : p.rank > p.teams - 2 ? 'bg-red-500/70' : 'bg-zinc-600'}`}
                style={{ width: `${Math.min((p.mine / Math.max(p.leagueMedian * 1.6, 1)) * 100, 100)}%` }}
              />
            </div>
            <span className="w-14 text-right font-mono text-zinc-400">{p.mine.toFixed(0)}</span>
            <span className={`w-10 text-right ${p.rank === 1 ? 'text-emerald-400' : p.rank > p.teams - 2 ? 'text-red-400' : 'text-zinc-600'}`}>
              #{p.rank}/{p.teams}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-[11px]">
        <span className="text-zinc-500">value age</span>
        <span className="font-mono font-bold text-zinc-200">{d.ageProfile.valueWeightedAge?.toFixed(1) ?? '·'}</span>
        <div className="flex h-2 flex-1 overflow-hidden rounded-sm">
          {d.ageProfile.buckets.map((b, i) => (
            <div
              key={b.label}
              className={['bg-emerald-500/80', 'bg-sky-500/70', 'bg-amber-500/70', 'bg-red-500/70'][i]}
              style={{ width: `${b.share * 100}%` }}
              title={`${b.label}: ${(b.share * 100).toFixed(0)}% of market value`}
            />
          ))}
        </div>
        <span className="text-zinc-600">{d.ageProfile.buckets.map((b) => `${b.label} ${(b.share * 100).toFixed(0)}%`).join(' · ')}</span>
      </div>
      <div className="mt-3">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
              <th className="py-1 pr-2 font-normal">player</th>
              <th className="px-2 py-1 text-right font-normal">age</th>
              <th className="px-2 py-1 text-right font-normal">ros pts</th>
              <th className="px-2 py-1 text-right font-normal">p10–p90</th>
              <th className="px-2 py-1 text-right font-normal">mkt</th>
            </tr>
          </thead>
          <tbody>
            {d.roster.map((r) => (
              <tr key={r.playerId} className="border-t border-zinc-800/60">
                <td className="max-w-[190px] truncate py-0.5 pr-2">
                  <span className={`mr-1.5 text-[10px] ${POS_COLORS[r.pos] ?? ''}`}>{r.pos}</span>
                  <Link href={`/player/${r.playerId}?league=${leagueId}`} className="hover:underline">
                    {r.name}
                  </Link>
                  {r.taxi && <span className="ml-1 rounded border border-zinc-700 px-1 text-[9px] text-zinc-500">TAXI</span>}
                  {r.reserve && <span className="ml-1 rounded border border-red-900 px-1 text-[9px] text-red-400">IR</span>}
                </td>
                <td className="px-2 py-0.5 text-right text-zinc-500">{r.age ?? '·'}</td>
                <td className="px-2 py-0.5 text-right font-mono text-zinc-200">{r.rosPts.toFixed(0)}</td>
                <td className="px-2 py-0.5 text-right font-mono text-[11px] text-zinc-600">
                  {r.seasonP10 !== null && r.seasonP90 !== null ? `${r.seasonP10.toFixed(0)}–${r.seasonP90.toFixed(0)}` : '·'}
                </td>
                <td className="px-2 py-0.5 text-right font-mono text-zinc-400">{r.market > 0 ? Math.round(r.market).toLocaleString() : '·'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string; rosterId: string }>;
  searchParams: Promise<{ vs?: string }>;
}) {
  const { leagueId, rosterId } = await params;
  const { vs } = await searchParams;
  const [d, odds] = await Promise.all([teamDetail(leagueId, Number.parseInt(rosterId, 10)), seasonOdds(leagueId)]);
  if ('error' in d) return <p className="text-sm text-zinc-500">{d.error}</p>;
  const vsDetail = vs ? await teamDetail(leagueId, Number.parseInt(vs, 10)) : null;
  const compare = vsDetail && !('error' in vsDetail) ? vsDetail : null;
  const ov = await teamsOverview(leagueId);
  const others = 'error' in ov ? [] : ov.teams.filter((t) => t.rosterId !== d.summary.rosterId);
  const oddsFor = (rid: number): TeamOdds | null => ('error' in odds ? null : (odds.teams.find((t) => t.rosterId === rid) ?? null));

  const vsOwnerH2h = compare
    ? d.history.h2h.find((h) => {
        const oppRoster = others.find((t) => t.rosterId === compare.summary.rosterId);
        return oppRoster && h.name === oppRoster.name;
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h1 className="font-bold text-zinc-100">{d.league}</h1>
        <span className="text-xs text-zinc-500">team terminal</span>
        <Link href={`/league/${leagueId}/teams`} className="text-xs text-emerald-400 hover:underline">
          all teams →
        </Link>
        <Link href={`/league/${leagueId}/trade`} className="text-xs text-violet-400 hover:underline">
          trade →
        </Link>
        <span className="ml-auto flex flex-wrap items-baseline gap-1 text-[10px]">
          <span className="text-zinc-600">compare:</span>
          {others.map((t) => (
            <Link
              key={t.rosterId}
              href={`?vs=${t.rosterId}`}
              className={
                compare?.summary.rosterId === t.rosterId ? 'rounded bg-zinc-700 px-1 text-zinc-100' : 'px-1 text-zinc-500 hover:text-zinc-200'
              }
            >
              {t.name.slice(0, 14)}
            </Link>
          ))}
          {compare && (
            <Link href={`/league/${leagueId}/team/${d.summary.rosterId}`} className="px-1 text-red-400">
              ✕
            </Link>
          )}
        </span>
      </div>

      {compare && (
        <div className="mb-3 rounded border border-zinc-800 p-2 text-center text-[12px]">
          <span className="font-bold text-zinc-200">{d.summary.name}</span>
          <span className="mx-2 font-mono text-zinc-400">
            {d.seasonBand.mean.toFixed(0)} <span className="text-zinc-600">vs</span> {compare.seasonBand.mean.toFixed(0)}
          </span>
          <span className="font-bold text-zinc-200">{compare.summary.name}</span>
          {vsOwnerH2h && (
            <span className="ml-3 text-zinc-500">
              all-time h2h{' '}
              <span className="font-mono text-zinc-300">
                {vsOwnerH2h.wins}-{vsOwnerH2h.losses}
                {vsOwnerH2h.ties ? `-${vsOwnerH2h.ties}` : ''}
              </span>
            </span>
          )}
        </div>
      )}

      <div className={`grid grid-cols-1 gap-4 ${compare ? 'lg:grid-cols-2' : ''}`}>
        <SummaryBlock d={d} leagueId={leagueId} odds={oddsFor(d.summary.rosterId)} />
        {compare && <SummaryBlock d={compare} leagueId={leagueId} odds={oddsFor(compare.summary.rosterId)} />}
      </div>

      {!compare && (
        <>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded border border-zinc-800 p-3">
              <div className="mb-2 text-[11px] font-bold text-zinc-300">
                weekly scoring history <span className="font-normal text-zinc-600">· last {Math.min(d.history.seasons.length, 5)} seasons</span>
              </div>
              <HistoryChart d={d} />
              <div className="mt-1 flex flex-wrap gap-2 text-[10px]">
                {d.history.seasons.slice(0, 5).map((s, i) => (
                  <span key={s.season} style={{ color: SEASON_COLORS[i] ?? '#52525b' }}>
                    ■ {s.season}
                  </span>
                ))}
              </div>
              <table className="mt-2 w-full text-[12px]">
                <thead>
                  <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
                    <th className="py-1 pr-2 font-normal">season</th>
                    <th className="px-2 py-1 text-right font-normal">record</th>
                    <th className="px-2 py-1 text-right font-normal">pf</th>
                    <th className="px-2 py-1 text-right font-normal">pf/wk</th>
                    <th className="px-2 py-1 text-right font-normal">eff</th>
                    <th className="px-2 py-1 text-right font-normal">all-play</th>
                    <th className="px-2 py-1 text-right font-normal">luck</th>
                  </tr>
                </thead>
                <tbody>
                  {d.history.seasons.map((s) => (
                    <tr key={`${s.season}-${s.leagueName}`} className="border-t border-zinc-800/60">
                      <td className="py-0.5 pr-2 text-zinc-300" title={s.leagueName}>
                        {s.season}
                      </td>
                      <td className="px-2 py-0.5 text-right font-mono text-zinc-300">{s.record ? `${s.record.wins}-${s.record.losses}` : '·'}</td>
                      <td className="px-2 py-0.5 text-right font-mono text-zinc-400">{s.pf.toFixed(0)}</td>
                      <td className="px-2 py-0.5 text-right font-mono text-zinc-400">
                        {s.weeklyPoints.length > 0 ? (s.pf / s.weeklyPoints.length).toFixed(1) : '·'}
                      </td>
                      <td className="px-2 py-0.5 text-right font-mono text-zinc-400">{s.efficiency !== null ? `${(s.efficiency * 100).toFixed(0)}%` : '·'}</td>
                      <td className="px-2 py-0.5 text-right font-mono text-zinc-400">{s.allPlayPct !== null ? `${(s.allPlayPct * 100).toFixed(0)}%` : '·'}</td>
                      <td
                        className={`px-2 py-0.5 text-right font-mono ${
                          s.luckDelta !== null && s.luckDelta > 0.03 ? 'text-emerald-400' : s.luckDelta !== null && s.luckDelta < -0.03 ? 'text-red-400' : 'text-zinc-500'
                        }`}
                      >
                        {s.luckDelta !== null ? `${s.luckDelta >= 0 ? '+' : ''}${(s.luckDelta * 100).toFixed(0)}pp` : '·'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-zinc-600">
                eff = points scored ÷ optimal lineup (lineup-setting quality) · all-play = win% vs every team every week · luck = record vs
                all-play gap
              </p>
            </div>

            <div className="flex flex-col gap-4">
              <div className="rounded border border-zinc-800 p-3">
                <div className="mb-2 text-[11px] font-bold text-zinc-300">
                  head-to-head, all seasons <span className="font-normal text-zinc-600">· vs current league members</span>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                  {d.history.h2h.map((h) => {
                    const total = h.wins + h.losses + h.ties;
                    const pct = total > 0 ? h.wins / total : 0;
                    return (
                      <div key={h.ownerId} className="flex items-center gap-2 text-[11px]">
                        <span className="w-28 truncate text-zinc-400">{h.name}</span>
                        <span className={`w-12 text-right font-mono ${pct >= 0.55 ? 'text-emerald-400' : pct <= 0.45 ? 'text-red-400' : 'text-zinc-300'}`}>
                          {h.wins}-{h.losses}
                          {h.ties ? `-${h.ties}` : ''}
                        </span>
                        <div className="h-1.5 flex-1 rounded-sm bg-zinc-800">
                          <div className={`h-1.5 rounded-sm ${pct >= 0.5 ? 'bg-emerald-500/70' : 'bg-red-500/60'}`} style={{ width: `${pct * 100}%` }} />
                        </div>
                      </div>
                    );
                  })}
                  {d.history.h2h.length === 0 && <span className="text-[11px] text-zinc-600">no head-to-head history yet</span>}
                </div>
              </div>
              <div className="rounded border border-zinc-800 p-3">
                <div className="mb-2 text-[11px] font-bold text-zinc-300">
                  roster market value <span className="font-normal text-zinc-600">· current roster priced across the daily archive</span>
                </div>
                <MarketTrendChart d={d} />
              </div>
              <div className="rounded border border-zinc-800 p-3">
                <div className="mb-2 text-[11px] font-bold text-zinc-300">
                  prediction vs actual <span className="font-normal text-zinc-600">· scored against the frozen pre-game numbers</span>
                </div>
                {d.accuracy.length === 0 ? (
                  <p className="text-[11px] text-zinc-600">
                    accrues from week 1 — every Thursday the freeze job locks that week's prediction of record; actuals score against it,
                    never against retro-fitted recomputes
                  </p>
                ) : (
                  <>
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
                          <th className="py-1 pr-2 font-normal">wk</th>
                          <th className="px-2 py-1 text-right font-normal">predicted</th>
                          <th className="px-2 py-1 text-right font-normal">band</th>
                          <th className="px-2 py-1 text-right font-normal">actual</th>
                          <th className="px-2 py-1 text-right font-normal">miss</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.accuracy.map((a) => (
                          <tr key={a.week} className="border-t border-zinc-800/60">
                            <td className="py-0.5 pr-2 text-zinc-500">w{a.week}</td>
                            <td className="px-2 py-0.5 text-right font-mono text-zinc-300">{a.predicted.toFixed(1)}</td>
                            <td className="px-2 py-0.5 text-right font-mono text-[11px] text-zinc-600">
                              {a.p10 !== null && a.p90 !== null ? `${a.p10.toFixed(0)}–${a.p90.toFixed(0)}` : '·'}
                            </td>
                            <td className={`px-2 py-0.5 text-right font-mono ${a.actual === null ? 'text-zinc-700' : a.actual >= a.predicted ? 'text-emerald-400' : 'text-red-400'}`}>
                              {a.actual !== null ? a.actual.toFixed(1) : '—'}
                            </td>
                            <td className="px-2 py-0.5 text-right font-mono text-zinc-500">
                              {a.err !== null ? `${a.err >= 0 ? '+' : ''}${a.err.toFixed(1)}` : '·'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {d.calibration.scoredWeeks > 0 && (
                      <p className="mt-2 text-[11px] text-zinc-600">
                        league calibration over {d.calibration.scoredWeeks} team-weeks: bias{' '}
                        {d.calibration.meanBias! >= 0 ? '+' : ''}
                        {d.calibration.meanBias!.toFixed(1)} · mae {d.calibration.mae!.toFixed(1)} · p10–p90 coverage{' '}
                        {(d.calibration.bandCoverage! * 100).toFixed(0)}% (target ~80%)
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-zinc-600">
            predicted chart = weekly optimal-lineup mean with monte-carlo p10–p90 band (same draws as the week page) · prediction-vs-actual
            overlay starts accruing week 1 once the freeze job lands
          </p>
        </>
      )}
    </div>
  );
}
