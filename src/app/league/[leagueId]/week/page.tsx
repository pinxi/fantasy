import Link from 'next/link';
import { weekReport, type LineupRow } from '@/services/matchup';

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

function LineupTable({ title, rows, total, rangeMax }: { title: string; rows: LineupRow[]; total: number; rangeMax: number }) {
  return (
    <div className="rounded border border-zinc-800 p-3">
      <div className="mb-2 flex items-baseline">
        <span className="text-[11px] font-bold text-zinc-300">{title}</span>
        <span className="ml-auto font-mono text-[13px] font-bold text-zinc-100">{total.toFixed(1)}</span>
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.slot}-${i}`} className="border-t border-zinc-800/60">
              <td className="w-20 py-0.5 pr-2 text-[10px] text-zinc-500">{r.slot}</td>
              <td className="max-w-[160px] truncate py-0.5 pr-2">
                <span className={`mr-1.5 text-[10px] ${POS_COLORS[r.pos] ?? 'text-zinc-600'}`}>{r.pos}</span>
                {r.playerId ? (
                  <Link href={`/player/${r.playerId}`} className="hover:underline">
                    {r.name}
                  </Link>
                ) : (
                  <span className="font-bold text-red-400">EMPTY SLOT</span>
                )}
              </td>
              <td className="w-24 py-0.5">
                {r.p10 !== null && r.p90 !== null ? (
                  <div className="relative h-1.5 w-full rounded-sm bg-zinc-800" title={`p10 ${r.p10.toFixed(0)} · mean ${r.mean.toFixed(1)} · p90 ${r.p90.toFixed(0)}`}>
                    <div
                      className="absolute h-1.5 rounded-sm bg-zinc-600"
                      style={{ left: `${(r.p10 / rangeMax) * 100}%`, width: `${(Math.max(r.p90 - r.p10, 0.5) / rangeMax) * 100}%` }}
                    />
                    <div className="absolute -top-0.5 h-2.5 w-0.5 bg-emerald-400" style={{ left: `${(Math.min(r.mean, rangeMax) / rangeMax) * 100}%` }} />
                  </div>
                ) : null}
              </td>
              <td className="w-12 py-0.5 text-right font-mono text-zinc-300">{r.mean.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function WeekPage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { leagueId } = await params;
  const { week } = await searchParams;
  const weekNum = week ? Number.parseInt(week, 10) : undefined;
  const report = await weekReport(leagueId, Number.isFinite(weekNum) ? weekNum : undefined);
  if ('error' in report) {
    return <p className="text-sm text-zinc-500">{report.error}</p>;
  }

  const winPct = report.winProb * 100;
  const winColor = winPct >= 55 ? 'text-emerald-400' : winPct <= 45 ? 'text-red-400' : 'text-zinc-200';
  const rangeMax = Math.max(...[...report.myLineup, ...report.oppLineup].map((r) => r.p90 ?? r.mean), 1);
  const emptySlots = report.myLineup.filter((r) => !r.playerId).length;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h1 className="font-bold text-zinc-100">{report.league}</h1>
        <span className="text-xs text-zinc-500">week {report.week} command center</span>
        <Link href={`/league/${leagueId}/streams`} className="text-xs text-cyan-400 hover:underline">
          streams →
        </Link>
        <Link href={`/league/${leagueId}/trade`} className="text-xs text-violet-400 hover:underline">
          trade →
        </Link>
        <span className="ml-auto flex gap-1 text-[10px]">
          {Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
            <Link
              key={w}
              href={`?week=${w}`}
              className={w === report.week ? 'rounded bg-zinc-700 px-1 text-zinc-100' : 'px-1 text-zinc-600 hover:text-zinc-300'}
            >
              {w}
            </Link>
          ))}
        </span>
      </div>

      <div className="mb-4 rounded border border-zinc-800 p-3">
        <div className="flex flex-wrap items-baseline gap-4">
          <span className={`font-mono text-2xl font-bold ${winColor}`}>{winPct.toFixed(0)}%</span>
          <span className="text-sm text-zinc-400">
            win probability vs{' '}
            {report.opponentRosterId !== null ? (
              <Link href={`/league/${leagueId}/team/${report.opponentRosterId}?vs=${report.myRosterId}`} className="text-zinc-200 hover:underline">
                {report.opponentName}
              </Link>
            ) : (
              <span className="text-zinc-200">{report.opponentName}</span>
            )}
            {report.synthetic && <span className="ml-1 text-[10px] text-zinc-600">(no pairing yet — league-median opponent)</span>}
          </span>
          <span className="ml-auto font-mono text-[12px] text-zinc-500">
            {report.myTotalMean.toFixed(1)} <span className="text-zinc-700">vs</span> {report.oppTotalMean.toFixed(1)}
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-sm bg-zinc-800">
          <div
            className={`h-2 ${winPct >= 55 ? 'bg-emerald-500' : winPct <= 45 ? 'bg-red-500' : 'bg-zinc-400'}`}
            style={{ width: `${winPct}%` }}
          />
        </div>
        <div className="mt-2 text-[11px] text-zinc-500">
          stance: <span className="text-zinc-300">{report.stance}</span>
          {emptySlots > 0 && <span className="ml-3 font-bold text-red-400">⚠ {emptySlots} empty starting slot{emptySlots > 1 ? 's' : ''}</span>}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LineupTable title="my lineup" rows={report.myLineup} total={report.myTotalMean} rangeMax={rangeMax} />
        {report.oppLineup.length > 0 ? (
          <LineupTable title={report.opponentName} rows={report.oppLineup} total={report.oppTotalMean} rangeMax={rangeMax} />
        ) : (
          <div className="rounded border border-zinc-800 p-3 text-xs text-zinc-600">
            synthetic opponent — median optimal-lineup total across the league ({report.oppTotalMean.toFixed(1)})
          </div>
        )}
      </div>

      <div className="rounded border border-zinc-800 p-3">
        <div className="mb-2 text-[11px] font-bold text-zinc-300">
          swap what-ifs <span className="font-normal text-zinc-600">· Δwin% from 400 common-random draws · ⚡ = points and win-odds disagree</span>
        </div>
        {report.suggestions.length === 0 ? (
          <p className="text-xs text-zinc-600">no swaps move the needle — lineup optimal by both lenses</p>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
                <th className="py-1 pr-2 font-normal">slot</th>
                <th className="px-2 py-1 font-normal">sit</th>
                <th className="px-2 py-1 font-normal">start</th>
                <th className="px-2 py-1 text-right font-normal">Δ win</th>
                <th className="px-2 py-1 text-right font-normal">Δ mean</th>
                <th className="px-2 py-1 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {report.suggestions.map((s, i) => (
                <tr key={i} className="border-t border-zinc-800/60">
                  <td className="py-0.5 pr-2 text-[10px] text-zinc-500">{s.slot}</td>
                  <td className="max-w-[170px] truncate px-2 py-0.5 text-zinc-400">
                    <Link href={`/player/${s.outId}`} className="hover:underline">
                      {s.out}
                    </Link>
                  </td>
                  <td className="max-w-[170px] truncate px-2 py-0.5 text-zinc-200">
                    <Link href={`/player/${s.inId}`} className="hover:underline">
                      {s.in}
                    </Link>
                  </td>
                  <td className={`px-2 py-0.5 text-right font-mono font-bold ${s.deltaWin > 0 ? 'text-emerald-400' : 'text-zinc-500'}`}>
                    {s.deltaWin > 0 ? '+' : ''}
                    {s.deltaWin.toFixed(1)}pp
                  </td>
                  <td className={`px-2 py-0.5 text-right font-mono ${s.deltaMean > 0 ? 'text-emerald-500/80' : 'text-zinc-500'}`}>
                    {s.deltaMean > 0 ? '+' : ''}
                    {s.deltaMean.toFixed(1)}
                  </td>
                  <td className="px-2 py-0.5">
                    {s.disagree && (
                      <span
                        className="rounded border border-amber-800 px-1.5 py-0.5 text-[10px] text-amber-300"
                        title="expected points and win probability point different ways — trust win% (it prices variance against this exact opponent)"
                      >
                        ⚡ disagree
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-[11px] text-zinc-600">
          start/sit by win probability, not points: as underdog prefer wide-band (ceiling) players, as favorite prefer tight-band (floor) players ·
          bars = weekly p10–p90 with mean marked · positive Δwin swaps are upgrades even when Δmean is negative
        </p>
      </div>
    </div>
  );
}
