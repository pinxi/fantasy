import Link from 'next/link';
import {
  adpSeries,
  marketDeltas,
  marketSeries,
  playerHeader,
  playerLeagueValues,
  playerNews,
  rosterStatuses,
  weeklyLines,
  type TrendSeries,
} from '@/services/player';

export const dynamic = 'force-dynamic';

const SERIES_COLORS: Record<string, string> = {
  fantasycalc: '#34d399',
  ktc: '#38bdf8',
};

function TrendChart({ series }: { series: TrendSeries[] }) {
  const withData = series.filter((s) => s.points.length > 0);
  if (withData.length === 0) return <p className="text-xs text-zinc-600">no market history yet — the archive grows daily</p>;

  const dates = [...new Set(withData.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const values = withData.flatMap((s) => s.points.map((p) => p.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.15, 1);
  const yOf = (v: number) => 170 - ((v - min + pad) / (max - min + 2 * pad)) * 150;
  const xOf = (i: number) => 40 + (dates.length > 1 ? (i / (dates.length - 1)) * 540 : 270);

  const lines = withData.map((s) => {
    const byDate = new Map(s.points.map((p) => [p.date, p.value]));
    let last: number | null = null;
    const coords: Array<[number, number]> = [];
    dates.forEach((d, i) => {
      const v = byDate.get(d) ?? last;
      if (v === null || v === undefined) return;
      last = v;
      coords.push([xOf(i), yOf(v)]);
    });
    return { key: `${s.source}:${s.format}`, source: s.source, coords, final: s.points[s.points.length - 1]!.value };
  });

  return (
    <svg viewBox="0 0 660 200" className="w-full">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="40" y1={20 + f * 150} x2="580" y2={20 + f * 150} stroke="#27272a" strokeWidth="1" />
      ))}
      {lines.map((l) => (
        <g key={l.key}>
          <polyline
            points={l.coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
            fill="none"
            stroke={SERIES_COLORS[l.source] ?? '#a1a1aa'}
            strokeWidth="2"
          />
          {l.coords.length > 0 && (
            <text
              x={l.coords[l.coords.length - 1]![0] + 6}
              y={l.coords[l.coords.length - 1]![1] + 4}
              fill={SERIES_COLORS[l.source] ?? '#a1a1aa'}
              fontSize="11"
            >
              {Math.round(l.final)}
            </text>
          )}
        </g>
      ))}
      <text x="40" y="192" fill="#71717a" fontSize="10">
        {dates[0]}
      </text>
      <text x="580" y="192" fill="#71717a" fontSize="10" textAnchor="end">
        {dates[dates.length - 1]}
      </text>
    </svg>
  );
}

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ playerId: string }>;
  searchParams: Promise<{ league?: string }>;
}) {
  const { playerId } = await params;
  const { league } = await searchParams;
  const header = playerHeader(playerId);
  if (!header) {
    return <p className="text-sm text-zinc-500">unknown player id: {playerId}</p>;
  }

  const values = playerLeagueValues(playerId);
  const statuses = rosterStatuses(playerId);
  const allSeries = marketSeries(playerId);
  const dynastySeries = allSeries.filter((s) => s.format === 'dynasty_sf');
  const chartSeries = dynastySeries.some((s) => s.points.length > 0) ? dynastySeries : allSeries.filter((s) => s.format === 'redraft_sf');
  const deltas = marketDeltas(playerId);
  const adp = adpSeries(playerId);
  const news = playerNews(playerId);

  const selectedLeague = league ?? values[0]?.leagueId ?? statuses[0]?.leagueId;
  const weekly = selectedLeague ? weeklyLines(playerId, selectedLeague) : [];
  const selectedLeagueName = values.find((v) => v.leagueId === selectedLeague)?.league ?? statuses.find((s) => s.leagueId === selectedLeague)?.league;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-1 flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-bold text-zinc-100">{header.name}</h1>
        <span className="text-sm text-zinc-400">
          {header.pos ?? '?'} · {header.team ?? 'FA'}
          {header.age ? ` · ${header.age}y` : ''}
          {header.yearsExp !== null ? ` · yr ${header.yearsExp + 1}` : ''}
        </span>
        {header.injuryStatus && <span className="rounded border border-red-800 px-1.5 py-0.5 text-[10px] text-red-300">{header.injuryStatus}</span>}
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {statuses.map((s) => (
          <span
            key={s.leagueId}
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              s.status === 'mine' ? 'border-emerald-700 text-emerald-300' : s.status === 'rostered' ? 'border-zinc-700 text-zinc-400' : 'border-sky-900 text-sky-300'
            }`}
            title={s.ownerName ?? undefined}
          >
            {s.status === 'mine' ? '◆ ' : ''}
            {s.league.slice(0, 18)}
            {s.status === 'fa' ? ' · FA' : s.status === 'rostered' ? ` · ${s.ownerName ?? 'taken'}` : ''}
          </span>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded border border-zinc-800 p-3 lg:col-span-2">
          <div className="mb-1 flex items-baseline gap-3 text-[11px] text-zinc-500">
            <span className="font-bold text-zinc-300">market value</span>
            <span>
              <span style={{ color: SERIES_COLORS.fantasycalc }}>■</span> fantasycalc
            </span>
            <span>
              <span style={{ color: SERIES_COLORS.ktc }}>■</span> ktc
            </span>
            <span className="ml-auto">{chartSeries[0]?.format ?? ''}</span>
          </div>
          <TrendChart series={chartSeries} />
          <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-zinc-500">
            {deltas.map((d) => (
              <span key={`${d.source}:${d.format}`}>
                {d.source} {d.format.replace('_sf', '')}: {Math.round(d.current)}
                {d.d7 !== null && (
                  <span className={d.d7 > 0 ? 'text-emerald-400' : d.d7 < 0 ? 'text-red-400' : ''}>
                    {' '}
                    {d.d7 > 0 ? '+' : ''}
                    {Math.round(d.d7)} 7d
                  </span>
                )}
              </span>
            ))}
            {adp.length > 0 && <span>sleeper adp (ppr): {adp[adp.length - 1]!.value.toFixed(0)}</span>}
          </div>
        </div>

        <div className="rounded border border-zinc-800 p-3">
          <div className="mb-2 text-[11px] font-bold text-zinc-300">value in my leagues</div>
          <div className="flex flex-col gap-1 text-[12px]">
            {values.map((v) => (
              <Link key={v.leagueId} href={`?league=${v.leagueId}`} className="flex items-baseline gap-2 hover:bg-zinc-900">
                <span className="w-36 truncate text-zinc-400">{v.league}</span>
                <span className="font-bold text-zinc-100">${v.dollar ?? 0}</span>
                <span className="text-zinc-500">t{v.tier ?? '·'}</span>
                <span className={`ml-auto ${v.edge !== null && v.edge > 2 ? 'text-emerald-400' : v.edge !== null && v.edge < -2 ? 'text-red-400' : 'text-zinc-600'}`}>
                  {v.edge !== null ? `${v.edge > 0 ? '+' : ''}${v.edge.toFixed(0)}` : '·'}
                </span>
              </Link>
            ))}
            {values.length === 0 && <span className="text-zinc-600">no league values (below valuation floor)</span>}
          </div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded border border-zinc-800 p-3">
          <div className="mb-2 text-[11px] font-bold text-zinc-300">
            weekly — {selectedLeagueName ?? 'no league'} <span className="font-normal text-zinc-600">(projected vs actual)</span>
          </div>
          <table className="w-full text-[12px]">
            <tbody>
              {weekly.map((w) => (
                <tr key={w.week} className="border-t border-zinc-800/60">
                  <td className="w-10 py-0.5 text-zinc-500">w{w.week}</td>
                  <td className="w-24 py-0.5 text-right text-[10px] text-zinc-600">
                    {w.p10 !== null && w.p90 !== null ? `${w.p10.toFixed(0)}–${w.p90.toFixed(0)}` : ''}
                  </td>
                  <td className="py-0.5 text-right text-zinc-300">{w.projected.toFixed(1)}</td>
                  <td className={`w-16 py-0.5 text-right ${w.actual === null ? 'text-zinc-700' : w.actual >= w.projected ? 'text-emerald-400' : 'text-red-400'}`}>
                    {w.actual !== null ? w.actual.toFixed(1) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded border border-zinc-800 p-3">
          <div className="mb-2 text-[11px] font-bold text-zinc-300">news</div>
          <div className="flex flex-col gap-2">
            {news.map((n, i) => (
              <div key={i} className="border-t border-zinc-800/60 pt-2 first:border-t-0 first:pt-0">
                <div className="text-[12px] text-zinc-200">{n.title ?? '(untitled)'}</div>
                <div className="text-[10px] text-zinc-600">
                  {n.source}
                  {n.publishedAtMs ? ` · ${new Date(n.publishedAtMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
                </div>
                {n.body && <div className="mt-0.5 line-clamp-3 text-[11px] text-zinc-500">{n.body}</div>}
              </div>
            ))}
            {news.length === 0 && <span className="text-xs text-zinc-600">no news captured yet — hourly job populates this</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
