'use server';

import { revalidatePath } from 'next/cache';
import { runValuation } from '@/valuation/compute';

// User-initiated recompute — a sanctioned occasional write from the web process.
export async function recomputeAction(formData: FormData): Promise<void> {
  const leagueId = String(formData.get('leagueId') ?? '');
  if (!leagueId) return;
  runValuation(leagueId);
  revalidatePath(`/league/${leagueId}/board`);
  revalidatePath(`/league/${leagueId}/edge`);
  revalidatePath(`/league/${leagueId}/auction`);
}
