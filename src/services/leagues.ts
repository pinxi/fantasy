import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { SEASON } from '@/config';

export interface LeagueSummary {
  leagueId: string;
  name: string;
  teams: number;
  flags: string[]; // SF, TEP, FD, KR, BONUS, IDP, CHOPPED
  draftType: string | null;
  draftStatus: string | null;
  draftAt: number | null;
  tradesDisabled: boolean;
}

export function listLeagues(): LeagueSummary[] {
  const rows = db.all<{
    league_id: string;
    name: string;
    total_rosters: number;
    scoring_settings: string;
    roster_positions: string;
    settings: string;
    draft_type: string | null;
    draft_status: string | null;
    draft_at: number | null;
  }>(sql`
    select l.league_id, l.name, l.total_rosters, l.scoring_settings, l.roster_positions, l.settings,
      d.type as draft_type, d.status as draft_status, d.start_time_ms as draft_at
    from leagues l
    left join drafts d on d.draft_id = l.draft_id
    where l.season = ${SEASON}
    order by l.name
  `);

  return rows.map((r) => {
    const scoring = JSON.parse(r.scoring_settings) as Record<string, number>;
    const positions = JSON.parse(r.roster_positions) as string[];
    const settings = JSON.parse(r.settings) as Record<string, unknown>;
    const flags: string[] = [];
    if (positions.includes('SUPER_FLEX') || positions.filter((p) => p === 'QB').length >= 2) flags.push('SF');
    if ((scoring.bonus_rec_te ?? 0) > 0) flags.push('TEP');
    if ((scoring.rec_fd ?? 0) > 0 || (scoring.rush_fd ?? 0) > 0) flags.push('FD');
    if ((scoring.kr_yd ?? 0) > 0 || (scoring.pr_yd ?? 0) > 0) flags.push('KR');
    if (Object.entries(scoring).some(([k, v]) => k.startsWith('bonus_') && k !== 'bonus_rec_te' && v > 0)) flags.push('BONUS');
    if (positions.some((p) => ['DL', 'LB', 'DB', 'IDP_FLEX'].includes(p))) flags.push('IDP');
    if (settings.type === 3) flags.push('CHOPPED');
    if (settings.type === 2) flags.push('DYNASTY');
    return {
      leagueId: r.league_id,
      name: r.name,
      teams: r.total_rosters,
      flags,
      draftType: r.draft_type,
      draftStatus: r.draft_status,
      draftAt: r.draft_at,
      tradesDisabled: settings.disable_trades === 1,
    };
  });
}

export interface SourceHealthRow {
  source: string;
  ok: boolean;
  stale: boolean;
  message: string | null;
}

export function sourceHealthStrip(): SourceHealthRow[] {
  const rows = db.all<{
    source: string;
    last_success_at: number | null;
    consecutive_failures: number;
    stale_after_hours: number;
    message: string | null;
  }>(sql`select source, last_success_at, consecutive_failures, stale_after_hours, message from source_health order by source`);
  return rows.map((r) => ({
    source: r.source,
    ok: r.consecutive_failures === 0,
    stale: r.last_success_at === null || Date.now() - r.last_success_at > r.stale_after_hours * 3600 * 1000,
    message: r.message,
  }));
}
