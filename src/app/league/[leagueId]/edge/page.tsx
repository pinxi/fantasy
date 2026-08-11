import Link from 'next/link';
import { boardRows, leagueMeta } from '@/services/board';

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

export default async function EdgePage({
  params,
  searchParams,
}: {
  params: Promise<{ leagueId: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const { leagueId } = await params;
  const { sort } = await searchParams;
  const meta = leagueMeta(leagueId);
  const name = meta?.name;
  let rows = boardRows(leagueId).filter((r) => r.edge !== null);

  if (sort === 'sell') rows = rows.sort((a, b) => a.edge! - b.edge!);
  else if (sort === 'points') rows = rows.sort((a, b) => b.points - a.points);
  else rows = rows.sort((a, b) => b.edge! - a.edge!);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="font-bold text-zinc-100">{name}</h1>
        <span className="text-xs text-zinc-500">edge board · our $ vs market $</span>
        <Link href={`/league/${leagueId}/board`} className="text-xs text-emerald-400 hover:underline">
          draft board →
        </Link>
        <span className="ml-auto flex gap-2 text-xs">
          <Link href="?sort=buy" className={!sort || sort === 'buy' ? 'text-emerald-400' : 'text-zinc-500'}>
            buys
          </Link>
          <Link href="?sort=sell" className={sort === 'sell' ? 'text-red-400' : 'text-zinc-500'}>
            sells
          </Link>
          <Link href="?sort=points" className={sort === 'points' ? 'text-zinc-200' : 'text-zinc-500'}>
            points
          </Link>
        </span>
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
            <th className="py-1 pr-2 font-normal">player</th>
            <th className="px-2 py-1 text-right font-normal">tier</th>
            <th className="px-2 py-1 text-right font-normal">pts</th>
            <th className="px-2 py-1 text-right font-normal">our $</th>
            <th className="px-2 py-1 text-right font-normal">mkt $</th>
            <th className="px-2 py-1 text-right font-normal">edge</th>
            <th className="px-2 py-1 text-right font-normal">fd</th>
            <th className="px-2 py-1 text-right font-normal">kr</th>
            <th className="px-2 py-1 text-right font-normal">bonus</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 150).map((row) => {
            const marketDollar = row.dollar !== null && row.edge !== null ? row.dollar - row.edge : null;
            return (
              <tr key={row.playerId} className="border-t border-zinc-800/60">
                <td className="max-w-[220px] truncate py-0.5 pr-2">
                  <span className={`mr-1.5 text-[10px] ${POS_COLORS[row.pos] ?? ''}`}>{row.pos}</span>
                  {row.name} <span className="text-zinc-600">{row.team ?? ''}</span>
                </td>
                <td className="px-2 py-0.5 text-right text-zinc-500">{row.tier ?? '·'}</td>
                <td className="px-2 py-0.5 text-right text-zinc-400">{row.points.toFixed(0)}</td>
                <td className="px-2 py-0.5 text-right font-bold text-zinc-200">${row.dollar ?? 0}</td>
                <td className="px-2 py-0.5 text-right text-zinc-400">{marketDollar !== null ? `$${marketDollar.toFixed(0)}` : '·'}</td>
                <td className={`px-2 py-0.5 text-right font-bold ${row.edge! > 2 ? 'text-emerald-400' : row.edge! < -2 ? 'text-red-400' : 'text-zinc-500'}`}>
                  {row.edge! > 0 ? `+${row.edge!.toFixed(0)}` : row.edge!.toFixed(0)}
                </td>
                <td className="px-2 py-0.5 text-right text-sky-500/80">{row.fdPts > 1 ? row.fdPts.toFixed(0) : '·'}</td>
                <td className="px-2 py-0.5 text-right text-emerald-500/80">{row.krPts > 1 ? row.krPts.toFixed(0) : '·'}</td>
                <td className="px-2 py-0.5 text-right text-violet-400/80">{row.bonusPts > 1 ? row.bonusPts.toFixed(0) : '·'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-zinc-600">
        fd/kr/bonus = season points from modeled first downs, grafted kick returns, and bonus EV — the value generic rankings can't see
        {meta?.isDynasty && (
          <>
            <br />
            dynasty league: edge compares THIS-SEASON production $ vs the dynasty market — big positive edges are win-now buys
            (aging producers the market discounts), not free money
          </>
        )}
      </p>
    </div>
  );
}
