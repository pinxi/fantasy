import Link from 'next/link';
import { boardRows, leagueMeta, myRosterIds } from '@/services/board';
import { SLEEPER_USER_ID } from '@/config';
import { recomputeAction } from '../actions';

export const dynamic = 'force-dynamic';

const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];
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

export default async function BoardPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const meta = leagueMeta(leagueId);
  const name = meta?.name;
  const rows = boardRows(leagueId);
  const mine = myRosterIds(leagueId, SLEEPER_USER_ID);
  const myRows = rows.filter((r) => mine.has(r.playerId)).sort((a, b) => b.points - a.points);

  const byPos = new Map<string, typeof rows>();
  for (const row of rows) {
    let list = byPos.get(row.pos);
    if (!list) byPos.set(row.pos, (list = []));
    list.push(row);
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="no-print mb-3 flex items-baseline gap-3">
        <h1 className="font-bold text-zinc-100">{name}</h1>
        <span className="text-xs text-zinc-500">draft board · league-scored season projections</span>
        <Link href={`/league/${leagueId}/edge`} className="text-xs text-sky-400 hover:underline">
          edge board →
        </Link>
        <Link href={`/league/${leagueId}/auction`} className="text-xs text-amber-400 hover:underline">
          auction console →
        </Link>
        <a href={`/league/${leagueId}/board.csv`} className="text-xs text-zinc-500 hover:underline">
          csv export
        </a>
        <form action={recomputeAction} className="ml-auto">
          <input type="hidden" name="leagueId" value={leagueId} />
          <button type="submit" className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-emerald-500 hover:text-emerald-300">
            recompute (~10s)
          </button>
        </form>
      </div>
      {meta?.isKeeper && myRows.length > 0 && (
        <div className="mb-4 rounded border border-amber-900/60 bg-amber-950/20 px-4 py-3">
          <div className="mb-2 text-xs font-bold text-amber-300">
            keeper shortlist — my roster by value (3 keepers, none from the top 3 rounds)
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
            {myRows.slice(0, 12).map((r) => (
              <span key={r.playerId} className="text-zinc-300">
                {r.name} <span className="text-zinc-500">{r.pos}</span>{' '}
                <span className="font-bold text-zinc-100">${r.dollar ?? 0}</span>
                <span className="text-zinc-500"> adp {r.adp !== null ? r.adp.toFixed(0) : '—'}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {POS_ORDER.filter((pos) => byPos.has(pos)).map((pos) => {
          const list = byPos.get(pos)!.slice(0, 40);
          return (
            <div key={pos} className="rounded border border-zinc-800" style={{ breakInside: 'avoid' }}>
              <div className={`border-b border-zinc-800 px-3 py-1.5 text-xs font-bold ${POS_COLORS[pos] ?? ''}`}>{pos}</div>
              <table className="w-full text-[12px]">
                <tbody>
                  {list.map((row, i) => {
                    const tierBreak = i > 0 && row.tier !== list[i - 1]!.tier;
                    return (
                      <tr key={row.playerId} className={tierBreak ? 'border-t-2 border-zinc-600' : i > 0 ? 'border-t border-zinc-800/60' : ''}>
                        <td className="w-7 px-2 py-0.5 text-right text-zinc-600">{row.posRank}</td>
                        <td className="max-w-[150px] truncate py-0.5">
                          {mine.has(row.playerId) && <span className="mr-1 text-emerald-400">◆</span>}
                          <Link href={`/player/${row.playerId}`} className="hover:underline">
                            {row.name}
                          </Link>{' '}
                          <span className="text-zinc-600">{row.team ?? ''}</span>
                        </td>
                        <td className="px-1 py-0.5 text-right text-zinc-400">{row.points.toFixed(0)}</td>
                        <td className="px-1 py-0.5 text-right text-zinc-500">{row.adp !== null ? row.adp.toFixed(0) : '·'}</td>
                        <td className="px-1 py-0.5 text-right font-bold text-zinc-200">${row.dollar ?? 0}</td>
                        <td className={`px-2 py-0.5 text-right ${row.edge !== null && row.edge > 2 ? 'text-emerald-400' : row.edge !== null && row.edge < -2 ? 'text-red-400' : 'text-zinc-600'}`}>
                          {row.edge !== null ? (row.edge > 0 ? `+${row.edge.toFixed(0)}` : row.edge.toFixed(0)) : '·'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-zinc-600">
        columns: rank · player · pts · sleeper adp (format-matched) · our $ · edge — thick rules = tier breaks
      </p>
    </div>
  );
}
