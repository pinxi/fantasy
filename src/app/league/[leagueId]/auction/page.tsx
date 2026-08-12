import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { draftPicks } from '@/db/schema';
import { fetchJson } from '@/lib/http';
import { boardRows, leagueMeta } from '@/services/board';

export const dynamic = 'force-dynamic';

interface SleeperPick {
  pick_no: number;
  round: number | null;
  draft_slot: number | null;
  roster_id: number | null;
  player_id: string | null;
  is_keeper: boolean | null;
  metadata: { amount?: string | number } & Record<string, unknown>;
}

// During a live auction this page is self-sufficient: it pulls picks straight
// from Sleeper on every render (auto-refresh every 30s while in progress).
async function refreshPicks(draftId: string): Promise<void> {
  try {
    const picks = await fetchJson<SleeperPick[]>(`https://api.sleeper.app/v1/draft/${draftId}/picks`, { timeoutMs: 15_000 });
    db.transaction((tx) => {
      for (const p of picks) {
        tx.insert(draftPicks)
          .values({
            draftId,
            pickNo: p.pick_no,
            round: p.round,
            draftSlot: p.draft_slot,
            rosterId: p.roster_id,
            playerId: p.player_id,
            amount: p.metadata?.amount !== undefined ? Number(p.metadata.amount) : null,
            isKeeper: p.is_keeper,
            metadata: p.metadata,
            fetchedAt: Date.now(),
          })
          .onConflictDoUpdate({
            target: [draftPicks.draftId, draftPicks.pickNo],
            set: {
              rosterId: p.roster_id,
              playerId: p.player_id,
              amount: p.metadata?.amount !== undefined ? Number(p.metadata.amount) : null,
              fetchedAt: Date.now(),
            },
          })
          .run();
      }
    });
  } catch {
    // Live refresh is best-effort; stale picks beat a dead page on draft night.
  }
}

export default async function AuctionPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const meta = leagueMeta(leagueId);

  const draft = db.get<{ draft_id: string; status: string | null; budget: number | null; teams: number | null }>(sql`
    select draft_id, status, cast(json_extract(settings, '$.budget') as integer) as budget,
      cast(json_extract(settings, '$.teams') as integer) as teams
    from drafts where league_id = ${leagueId} and type = 'auction'
    order by fetched_at desc limit 1
  `);

  if (!draft) {
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="font-bold text-zinc-100">{meta?.name}</h1>
        <p className="mt-2 text-sm text-zinc-500">
          No auction draft found for this league.{' '}
          <Link href={`/league/${leagueId}/board`} className="text-emerald-400 hover:underline">
            back to board →
          </Link>
        </p>
      </div>
    );
  }

  const live = draft.status === 'drafting' || draft.status === 'in_progress';
  if (live || draft.status === 'complete') await refreshPicks(draft.draft_id);

  const picks = db.all<{ roster_id: number | null; player_id: string | null; amount: number | null }>(
    sql`select roster_id, player_id, amount from draft_picks where draft_id = ${draft.draft_id}`,
  );
  const teamNames = new Map(
    db
      .all<{ roster_id: number; display_name: string | null; team_name: string | null }>(sql`
        select r.roster_id, u.display_name, u.team_name
        from rosters r left join league_users u on u.league_id = r.league_id and u.user_id = r.owner_id
        where r.league_id = ${leagueId}
      `)
      .map((r) => [r.roster_id, r.team_name ?? r.display_name ?? `roster ${r.roster_id}`]),
  );

  const budget = draft.budget ?? 200;
  const teams = draft.teams ?? (teamNames.size || 10);
  const rows = boardRows(leagueId);
  const dollarById = new Map(rows.map((r) => [r.playerId, r.dollar ?? 0]));
  const draftedIds = new Set(picks.map((p) => p.player_id).filter(Boolean) as string[]);

  const spentByRoster = new Map<number, { spent: number; picks: number }>();
  let totalSpent = 0;
  let draftedOurValue = 0;
  for (const p of picks) {
    if (p.roster_id !== null) {
      const agg = spentByRoster.get(p.roster_id) ?? { spent: 0, picks: 0 };
      agg.spent += p.amount ?? 0;
      agg.picks += 1;
      spentByRoster.set(p.roster_id, agg);
    }
    totalSpent += p.amount ?? 0;
    if (p.player_id) draftedOurValue += dollarById.get(p.player_id) ?? 0;
  }

  const moneyRemaining = teams * budget - totalSpent;
  const remaining = rows.filter((r) => !draftedIds.has(r.playerId) && (r.dollar ?? 0) >= 1);
  const remainingPoolValue = remaining.reduce((s, r) => s + (r.dollar ?? 0), 0);
  const inflation = remainingPoolValue > 0 ? moneyRemaining / remainingPoolValue : 1;
  const realizedVsOurs = draftedOurValue > 0 ? totalSpent / draftedOurValue : 1;

  return (
    <div className="mx-auto max-w-5xl">
      {live && <meta httpEquiv="refresh" content="30" />}
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="font-bold text-zinc-100">{meta?.name}</h1>
        <span className="text-xs text-zinc-500">auction console · {draft.status ?? 'pre_draft'}{live ? ' · refreshing every 30s' : ''}</span>
        <Link href={`/league/${leagueId}/board`} className="text-xs text-emerald-400 hover:underline">
          board →
        </Link>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        <div className="rounded border border-zinc-800 px-3 py-2">
          <div className="text-[10px] text-zinc-500">picks made</div>
          <div className="text-lg font-bold text-zinc-100">{picks.length}</div>
        </div>
        <div className="rounded border border-zinc-800 px-3 py-2">
          <div className="text-[10px] text-zinc-500">money remaining</div>
          <div className="text-lg font-bold text-zinc-100">${moneyRemaining}</div>
        </div>
        <div className="rounded border border-zinc-800 px-3 py-2">
          <div className="text-[10px] text-zinc-500">room pays (spent ÷ our value)</div>
          <div className={`text-lg font-bold ${realizedVsOurs > 1.05 ? 'text-red-400' : realizedVsOurs < 0.95 ? 'text-emerald-400' : 'text-zinc-100'}`}>
            {realizedVsOurs.toFixed(2)}×
          </div>
        </div>
        <div className="rounded border border-zinc-800 px-3 py-2">
          <div className="text-[10px] text-zinc-500">inflation on remaining</div>
          <div className={`text-lg font-bold ${inflation > 1.05 ? 'text-red-400' : inflation < 0.95 ? 'text-emerald-400' : 'text-zinc-100'}`}>
            {inflation.toFixed(2)}×
          </div>
        </div>
      </div>

      {spentByRoster.size > 0 && (
        <div className="mb-4 flex flex-wrap gap-2 text-[11px]">
          {[...spentByRoster.entries()]
            .sort((a, b) => b[1].spent - a[1].spent)
            .map(([rosterId, agg]) => (
              <span key={rosterId} className="rounded border border-zinc-800 px-2 py-1 text-zinc-400">
                {teamNames.get(rosterId) ?? rosterId}: <span className="text-zinc-200">${budget - agg.spent}</span> left · {agg.picks} picks
              </span>
            ))}
        </div>
      )}

      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
            <th className="py-1 pr-2 font-normal">best remaining</th>
            <th className="px-2 py-1 text-right font-normal">tier</th>
            <th className="px-2 py-1 text-right font-normal">pts</th>
            <th className="px-2 py-1 text-right font-normal">adp</th>
            <th className="px-2 py-1 text-right font-normal">base $</th>
            <th className="px-2 py-1 text-right font-normal">adj $ (pay up to)</th>
          </tr>
        </thead>
        <tbody>
          {remaining.slice(0, 60).map((r) => (
            <tr key={r.playerId} className="border-t border-zinc-800/60">
              <td className="max-w-[240px] truncate py-0.5 pr-2">
                <span className="mr-1.5 text-[10px] text-zinc-500">{r.pos}</span>
                {r.name} <span className="text-zinc-600">{r.team ?? ''}</span>
              </td>
              <td className="px-2 py-0.5 text-right text-zinc-500">{r.tier ?? '·'}</td>
              <td className="px-2 py-0.5 text-right text-zinc-400">{r.points.toFixed(0)}</td>
              <td className="px-2 py-0.5 text-right text-zinc-500">{r.adp !== null ? r.adp.toFixed(0) : '·'}</td>
              <td className="px-2 py-0.5 text-right text-zinc-400">${r.dollar ?? 0}</td>
              <td className="px-2 py-0.5 text-right font-bold text-zinc-100">${Math.max(1, Math.round((r.dollar ?? 0) * inflation))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-zinc-600">
        adj $ = our value × remaining-pool inflation ({inflation.toFixed(2)}×) — what the player is worth given the money still in the room
      </p>
    </div>
  );
}
