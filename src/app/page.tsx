import Link from 'next/link';
import { listLeagues } from '@/services/leagues';

export const dynamic = 'force-dynamic';

const FLAG_STYLES: Record<string, string> = {
  SF: 'text-rose-300 border-rose-800',
  TEP: 'text-amber-300 border-amber-800',
  FD: 'text-sky-300 border-sky-800',
  KR: 'text-emerald-300 border-emerald-800',
  BONUS: 'text-violet-300 border-violet-800',
  IDP: 'text-orange-300 border-orange-800',
  CHOPPED: 'text-red-300 border-red-800',
  DYNASTY: 'text-cyan-300 border-cyan-800',
};

function draftLabel(type: string | null, status: string | null, at: number | null): string {
  if (!type) return 'no draft';
  const when = at
    ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })
    : 'TBD';
  return `${type} · ${status === 'pre_draft' ? `drafts ${when}` : (status ?? '')}`;
}

export default function Home() {
  const leagues = listLeagues();
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-4 text-sm text-zinc-400">
        {leagues.length} leagues · season 2026
      </h1>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {leagues.map((l) => (
          <div key={l.leagueId} className="rounded border border-zinc-800 bg-zinc-900/50 px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-bold text-zinc-100">{l.name}</span>
              <span className="shrink-0 text-[11px] text-zinc-500">
                {l.teams} tm · {draftLabel(l.draftType, l.draftStatus, l.draftAt)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {l.flags.map((f) => (
                <span key={f} className={`rounded border px-1.5 py-0.5 text-[10px] ${FLAG_STYLES[f] ?? 'text-zinc-400 border-zinc-700'}`}>
                  {f}
                </span>
              ))}
            </div>
            <div className="mt-3 flex gap-3 text-[12px]">
              <Link className="text-emerald-400 hover:underline" href={`/league/${l.leagueId}/board`}>
                draft board →
              </Link>
              <Link className="text-sky-400 hover:underline" href={`/league/${l.leagueId}/edge`}>
                edge board →
              </Link>
              <Link className="text-amber-400 hover:underline" href={`/league/${l.leagueId}/managers`}>
                managers →
              </Link>
              <a className="text-zinc-500 hover:underline" href={`/league/${l.leagueId}/board.csv`}>
                csv
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
