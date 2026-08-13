import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { leagueRostersDetailed, leagueShape, weeklyPointsForLeague } from '@/services/trade';
import TradeLab from './TradeLab';

export const dynamic = 'force-dynamic';

export default async function TradePage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const shape = leagueShape(leagueId);
  if (!shape) return <p className="text-sm text-zinc-500">unknown league</p>;

  if (shape.tradesDisabled) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-bold text-zinc-100">{shape.name}</h1>
        <p className="mt-2 text-sm text-zinc-500">trades are disabled in this league — nothing to evaluate.</p>
      </div>
    );
  }

  const rosters = leagueRostersDetailed(leagueId);
  const mine = rosters.find((r) => r.isMe);
  const weekly = weeklyPointsForLeague(leagueId);

  if (!mine || mine.players.length === 0 || !weekly) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-bold text-zinc-100">{shape.name}</h1>
        <p className="mt-2 text-sm text-zinc-500">
          {!weekly
            ? 'no weekly valuation data yet — run a recompute from the board page first.'
            : 'no rosters yet — the trade lab activates after this league drafts.'}
        </p>
        <Link href={`/league/${leagueId}/board`} className="text-xs text-emerald-400 hover:underline">
          board →
        </Link>
      </div>
    );
  }

  const pickLabels = shape.isDynasty
    ? db
        .all<{ asset_id: string }>(
          sql`select distinct asset_id from market_value_snapshots where source = 'ktc' and asset_type = 'pick' and format = ${shape.format} order by asset_id`,
        )
        .map((r) => r.asset_id)
    : [];

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="font-bold text-zinc-100">{shape.name}</h1>
        <span className="text-xs text-zinc-500">
          trade lab · {shape.format}
          {shape.tradeDeadline !== null ? ` · deadline wk ${shape.tradeDeadline}` : ''}
        </span>
        <Link href={`/league/${leagueId}/board`} className="text-xs text-emerald-400 hover:underline">
          board →
        </Link>
      </div>
      <TradeLab leagueId={leagueId} rosters={rosters} myRosterId={mine.rosterId} isDynasty={shape.isDynasty} pickLabels={pickLabels} />
    </div>
  );
}
