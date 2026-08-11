import { boardRows, leagueName } from '@/services/board';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const name = leagueName(leagueId) ?? leagueId;
  const rows = boardRows(leagueId);

  const header = 'pos,pos_rank,tier,player,team,points,vorp,dollar,market_value,edge,fd_pts,kr_pts,bonus_pts';
  const lines = rows.map((r) =>
    [
      r.pos,
      r.posRank ?? '',
      r.tier ?? '',
      `"${r.name.replaceAll('"', '""')}"`,
      r.team ?? '',
      r.points.toFixed(1),
      r.vorp?.toFixed(1) ?? '',
      r.dollar ?? '',
      r.marketValue ?? '',
      r.edge?.toFixed(1) ?? '',
      r.fdPts.toFixed(1),
      r.krPts.toFixed(1),
      r.bonusPts.toFixed(1),
    ].join(','),
  );

  return new Response([header, ...lines].join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name.replaceAll(/[^\w-]+/g, '_')}_board.csv"`,
    },
  });
}
