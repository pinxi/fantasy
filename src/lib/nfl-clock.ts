import { z } from 'zod';
import { fetchJson } from './http';

const StateSchema = z.object({
  season: z.coerce.number(),
  week: z.number(),
  season_type: z.string(),
  leg: z.number().optional(),
  display_week: z.number().optional(),
  league_season: z.coerce.number().optional(),
});

export interface NflClock {
  season: number;
  week: number;
  seasonType: string; // 'pre' | 'regular' | 'post' | 'off'
  fetchedAt: number;
}

let cached: NflClock | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function getNflClock(): Promise<NflClock> {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  const raw = await fetchJson('https://api.sleeper.app/v1/state/nfl');
  const state = StateSchema.parse(raw);
  cached = {
    season: state.season,
    week: Math.max(state.week, 1),
    seasonType: state.season_type,
    fetchedAt: Date.now(),
  };
  return cached;
}
