import Link from 'next/link';
import { seasonOdds } from '@/services/odds';
import { teamsOverview } from '@/services/team';

export const dynamic = 'force-dynamic';

export default async function TeamsPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const [ov, odds] = await Promise.all([teamsOverview(leagueId), seasonOdds(leagueId)]);
  if ('error' in ov) return <p className="text-sm text-zinc-500">{ov.error}</p>;
  const oddsBy = 'error' in odds ? null : new Map(odds.teams.map((t) => [t.rosterId, t]));

  const maxRos = Math.max(...ov.teams.map((t) => t.rosTotal), 1);
  const posCols = [...new Set(ov.teams.flatMap((t) => Object.keys(t.posPoints)))].sort();
  const bestByPos = new Map(posCols.map((pos) => [pos, Math.max(...ov.teams.map((t) => t.posPoints[pos] ?? 0))]));

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="font-bold text-zinc-100">{ov.league}</h1>
        <span className="text-xs text-zinc-500">teams by predicted ROS points (optimal lineups, wk {ov.fromWeek}–17)</span>
        <Link href={`/league/${leagueId}/managers`} className="text-xs text-amber-400 hover:underline">
          managers →
        </Link>
        <Link href={`/league/${leagueId}/week`} className="text-xs text-rose-400 hover:underline">
          week →
        </Link>
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
            <th className="py-1 pr-2 font-normal">#</th>
            <th className="px-2 py-1 font-normal">team</th>
            <th className="px-2 py-1 text-right font-normal">record</th>
            <th className="px-2 py-1 text-right font-normal">ros pts</th>
            <th className="px-2 py-1 font-normal"></th>
            <th className="px-2 py-1 text-right font-normal">playoff wks</th>
            {oddsBy && (
              <>
                <th className="px-2 py-1 text-right font-normal">exp w</th>
                <th className="px-2 py-1 text-right font-normal">playoff %</th>
                <th className="px-2 py-1 text-right font-normal">title %</th>
              </>
            )}
            <th className="px-2 py-1 text-right font-normal">market $</th>
            {posCols.map((p) => (
              <th key={p} className="px-1.5 py-1 text-right font-normal">
                {p.toLowerCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ov.teams.map((t, i) => (
            <tr key={t.rosterId} className={`border-t border-zinc-800/60 ${t.isMe ? 'bg-emerald-950/20' : ''}`}>
              <td className="py-0.5 pr-2 text-zinc-600">{i + 1}</td>
              <td className="max-w-[190px] truncate px-2 py-0.5">
                {t.isMe && <span className="mr-1 text-emerald-400">◆</span>}
                <Link href={`/league/${leagueId}/team/${t.rosterId}`} className="font-bold text-zinc-200 hover:underline">
                  {t.name}
                </Link>
              </td>
              <td className="px-2 py-0.5 text-right text-zinc-500">{t.record ? `${t.record.wins}-${t.record.losses}` : '·'}</td>
              <td className="px-2 py-0.5 text-right font-mono font-bold text-zinc-100">{t.rosTotal.toFixed(0)}</td>
              <td className="w-28 px-2 py-0.5">
                <div className="h-1.5 rounded-sm bg-zinc-800">
                  <div className="h-1.5 rounded-sm bg-zinc-500" style={{ width: `${(t.rosTotal / maxRos) * 100}%` }} />
                </div>
              </td>
              <td className="px-2 py-0.5 text-right font-mono text-zinc-400">{t.playoffTotal.toFixed(0)}</td>
              {oddsBy && (
                <>
                  <td className="px-2 py-0.5 text-right font-mono text-zinc-400">{oddsBy.get(t.rosterId)?.expWins.toFixed(1) ?? '·'}</td>
                  <td className="px-2 py-0.5 text-right font-mono text-zinc-300">
                    {oddsBy.get(t.rosterId) ? `${oddsBy.get(t.rosterId)!.playoffPct.toFixed(0)}%` : '·'}
                  </td>
                  <td
                    className={`px-2 py-0.5 text-right font-mono font-bold ${
                      (oddsBy.get(t.rosterId)?.titlePct ?? 0) >= 15 ? 'text-emerald-400' : (oddsBy.get(t.rosterId)?.titlePct ?? 0) >= 5 ? 'text-zinc-200' : 'text-zinc-500'
                    }`}
                  >
                    {oddsBy.get(t.rosterId) ? `${oddsBy.get(t.rosterId)!.titlePct.toFixed(1)}%` : '·'}
                  </td>
                </>
              )}
              <td className="px-2 py-0.5 text-right font-mono text-zinc-400">{Math.round(t.marketTotal).toLocaleString()}</td>
              {posCols.map((p) => {
                const v = t.posPoints[p] ?? 0;
                const isBest = v > 0 && v === bestByPos.get(p);
                return (
                  <td key={p} className={`px-1.5 py-0.5 text-right font-mono ${isBest ? 'font-bold text-emerald-400' : 'text-zinc-500'}`}>
                    {v > 0 ? v.toFixed(0) : '·'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-zinc-600">
        ros pts = sum of weekly optimal-lineup projections (our league-conditional numbers) · playoff wks = this league's playoff weeks ·
        exp w / playoff % / title % = monte carlo over the real schedule + bracket · market $ = fantasycalc roster total ·
        position columns = ROS lineup points from that position (green = league best) · click a team for detail, history + head-to-head
      </p>
    </div>
  );
}
