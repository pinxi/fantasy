import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { normalizeName } from '@/ids/resolver';
import { mapAsset, dismissAsset } from './actions';

export const dynamic = 'force-dynamic';

interface Candidate {
  sleeperId: string;
  name: string;
  pos: string | null;
  team: string | null;
}

function candidates(name: string, pos: string | null): Candidate[] {
  const tokens = normalizeName(name).split(' ');
  const lastToken = tokens[tokens.length - 1] ?? name;
  const firstToken = tokens[0] ?? '';
  const rows = db.all<{ sleeper_id: string; full_name: string; pos: string | null; team: string | null }>(sql`
    select sleeper_id, full_name, pos, team from players
    where search_name like ${'%' + lastToken + '%'}
      and (${pos ?? ''} = '' or pos = ${pos ?? ''} or pos is null)
    order by
      case when search_name like ${firstToken.slice(0, 3) + '%'} then 0 else 1 end,
      case when team is null then 1 else 0 end,
      full_name
    limit 5
  `);
  return rows.map((r) => ({ sleeperId: r.sleeper_id, name: r.full_name, pos: r.pos, team: r.team }));
}

export default function CrosswalkPage() {
  const unmatched = db.all<{ source: string; source_key: string; name: string; pos: string | null; context: string | null }>(
    sql`select source, source_key, name, pos, context from unmatched_assets where ignored = 0 order by source, name`,
  );

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 font-bold text-zinc-100">crosswalk — unmatched assets</h1>
      <p className="mb-4 text-xs text-zinc-500">
        {unmatched.length} unresolved. Click the correct player to record a manual mapping (beats all automatic resolution). Dismiss
        entries that aren't real players.
      </p>
      {unmatched.length === 0 && <p className="text-emerald-400">✓ nothing unmatched — all sources fully resolved</p>}
      <div className="flex flex-col gap-3">
        {unmatched.map((u) => (
          <div key={`${u.source}:${u.source_key}`} className="rounded border border-zinc-800 px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="font-bold text-zinc-100">{u.name}</span>
              <span className="text-xs text-zinc-500">
                {u.pos ?? '?'} · {u.source} · {u.context ?? ''}
              </span>
              <form action={dismissAsset} className="ml-auto">
                <input type="hidden" name="source" value={u.source} />
                <input type="hidden" name="sourceKey" value={u.source_key} />
                <button type="submit" className="text-xs text-zinc-600 hover:text-red-400">
                  dismiss
                </button>
              </form>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {candidates(u.name, u.pos).map((c) => (
                <form key={c.sleeperId} action={mapAsset}>
                  <input type="hidden" name="source" value={u.source} />
                  <input type="hidden" name="sourceKey" value={u.source_key} />
                  <input type="hidden" name="sleeperId" value={c.sleeperId} />
                  <button
                    type="submit"
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-emerald-500 hover:text-emerald-300"
                  >
                    {c.name} <span className="text-zinc-500">{c.pos ?? '?'} {c.team ?? 'FA'}</span>
                  </button>
                </form>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
