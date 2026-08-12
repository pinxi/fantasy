import Link from 'next/link';
import { searchPlayers } from '@/services/player';

export const dynamic = 'force-dynamic';

export default async function PlayerSearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const results = q ? searchPlayers(q) : [];
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-3 font-bold text-zinc-100">player search{q ? ` — “${q}”` : ''}</h1>
      <div className="flex flex-col gap-1">
        {results.map((r) => (
          <Link key={r.sleeperId} href={`/player/${r.sleeperId}`} className="flex gap-3 rounded border border-zinc-800 px-3 py-1.5 text-[13px] hover:border-zinc-600">
            <span className="text-zinc-100">{r.name}</span>
            <span className="text-zinc-500">
              {r.pos ?? '?'} · {r.team ?? 'FA'}
            </span>
          </Link>
        ))}
        {q && results.length === 0 && <p className="text-sm text-zinc-500">no players match “{q}”</p>}
      </div>
    </div>
  );
}
