import Link from 'next/link';
import { streamsReport } from '@/services/streams';

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

const VERDICT_STYLE: Record<string, string> = {
  hold: 'border-emerald-800 text-emerald-300',
  'coin-flip': 'border-zinc-700 text-zinc-400',
  stream: 'border-amber-800 text-amber-300',
};

export default async function StreamsPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const report = streamsReport(leagueId);
  if ('error' in report) {
    return <p className="text-sm text-zinc-500">{report.error}</p>;
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="font-bold text-zinc-100">{report.league}</h1>
        <span className="text-xs text-zinc-500">stream vs hold · wire baseline = top-2 free agents per week</span>
        <Link href={`/league/${leagueId}/board`} className="text-xs text-emerald-400 hover:underline">
          board →
        </Link>
      </div>

      <div className="mb-4 rounded border border-zinc-800 p-3">
        <div className="mb-2 text-[11px] font-bold text-zinc-300">position streamability</div>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
              <th className="py-1 font-normal">pos</th>
              <th className="px-2 py-1 text-right font-normal">free agents</th>
              <th className="px-2 py-1 text-right font-normal">wire ppw (top-2 avg)</th>
              <th className="px-2 py-1 text-right font-normal">replacement ppw</th>
              <th className="px-2 py-1 font-normal">verdict</th>
            </tr>
          </thead>
          <tbody>
            {report.positions.map((p) => (
              <tr key={p.pos} className="border-t border-zinc-800/60">
                <td className={`py-0.5 font-bold ${POS_COLORS[p.pos] ?? ''}`}>{p.pos}</td>
                <td className="px-2 py-0.5 text-right text-zinc-500">{p.faCount}</td>
                <td className="px-2 py-0.5 text-right text-zinc-200">{p.baselineAvg.toFixed(1)}</td>
                <td className="px-2 py-0.5 text-right text-zinc-500">{p.replacement.toFixed(1)}</td>
                <td className="px-2 py-0.5">
                  {p.streamable ? (
                    <span className="rounded border border-amber-800 px-1.5 py-0.5 text-[10px] text-amber-300">
                      streamable — don't pay for depth
                    </span>
                  ) : (
                    <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">thin wire — roster it</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded border border-zinc-800 p-3">
        <div className="mb-2 text-[11px] font-bold text-zinc-300">
          my roster — hold or stream <span className="font-normal text-zinc-600">(sorted worst margin first)</span>
        </div>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
              <th className="py-1 font-normal">player</th>
              <th className="px-2 py-1 text-right font-normal">starts</th>
              <th className="px-2 py-1 text-right font-normal">avg ppw</th>
              <th className="px-2 py-1 text-right font-normal">wire ppw</th>
              <th className="px-2 py-1 text-right font-normal">margin</th>
              <th className="px-2 py-1 font-normal">verdict</th>
            </tr>
          </thead>
          <tbody>
            {report.myVerdicts.map((v) => (
              <tr key={v.playerId} className="border-t border-zinc-800/60">
                <td className="max-w-[220px] truncate py-0.5">
                  <span className={`mr-1.5 text-[10px] ${POS_COLORS[v.pos] ?? ''}`}>{v.pos}</span>
                  <Link href={`/player/${v.playerId}`} className="hover:underline">
                    {v.name}
                  </Link>
                  {(v.taxi || v.reserve) && <span className="ml-1 text-[9px] text-amber-500">{v.taxi ? 'TX' : 'IR'}</span>}
                </td>
                <td className="px-2 py-0.5 text-right text-zinc-500">{v.starts}</td>
                <td className="px-2 py-0.5 text-right text-zinc-200">{v.avgPts.toFixed(1)}</td>
                <td className="px-2 py-0.5 text-right text-zinc-500">{v.baselineAvg.toFixed(1)}</td>
                <td className={`px-2 py-0.5 text-right font-bold ${v.margin >= 1 ? 'text-emerald-400' : v.margin <= -1 ? 'text-amber-400' : 'text-zinc-400'}`}>
                  {v.margin > 0 ? '+' : ''}
                  {v.margin.toFixed(1)}
                </td>
                <td className="px-2 py-0.5">
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] ${VERDICT_STYLE[v.verdict]}`}>{v.verdict}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-zinc-600">
          stream = the wire's weekly best beats this player — the spot is worth more as a stash · starts = weeks in my optimal lineup ·
          draft $ keep the starter baseline; this view is for roster decisions
        </p>
      </div>
    </div>
  );
}
