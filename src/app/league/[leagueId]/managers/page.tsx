import Link from 'next/link';
import { getLeagueIntel, type AuctionProfile, type ManagerProfile, type PosGroup } from '@/services/intel';

export const dynamic = 'force-dynamic';

const POS_TEXT: Record<string, string> = {
  QB: 'text-rose-400',
  RB: 'text-emerald-400',
  WR: 'text-sky-400',
  TE: 'text-amber-400',
  K: 'text-violet-400',
  DEF: 'text-stone-400',
  IDP: 'text-orange-400',
};

const POS_BG: Record<string, string> = {
  QB: 'bg-rose-400',
  RB: 'bg-emerald-400',
  WR: 'bg-sky-400',
  TE: 'bg-amber-400',
  K: 'bg-violet-400',
  DEF: 'bg-stone-400',
  IDP: 'bg-orange-400',
};

const MIX_ORDER: PosGroup[] = ['QB', 'RB', 'WR', 'TE', 'IDP', 'K', 'DEF'];

function MixBar({ mix }: { mix: Partial<Record<PosGroup, number>> }) {
  const parts = MIX_ORDER.map((pos) => ({ pos, share: mix[pos] ?? 0 })).filter((p) => p.share >= 0.02);
  return (
    <div className="flex h-2 w-28 overflow-hidden rounded-sm bg-zinc-800" title={parts.map((p) => `${p.pos} ${(p.share * 100).toFixed(0)}%`).join(' · ')}>
      {parts.map((p) => (
        <div key={p.pos} className={POS_BG[p.pos] ?? 'bg-zinc-600'} style={{ width: `${p.share * 100}%` }} />
      ))}
    </div>
  );
}

function AuctionTable({ title, entries, footnote }: { title: string; entries: Array<{ m: ManagerProfile; a: AuctionProfile }>; footnote: string }) {
  return (
    <>
      <h2 className="mb-1 mt-6 text-[11px] font-bold uppercase tracking-wide text-zinc-400">{title}</h2>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
            <th className="py-1 pr-2 font-normal">manager</th>
            <th className="px-2 py-1 text-right font-normal">auctions</th>
            <th className="px-2 py-1 text-right font-normal">top-3 $%</th>
            <th className="px-2 py-1 text-right font-normal">early $%</th>
            <th className="px-2 py-1 text-right font-normal">$1-2 buys</th>
            <th className="px-2 py-1 font-normal">$ by position</th>
            <th className="px-2 py-1 font-normal">biggest buy</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(({ m, a }) => (
            <tr key={m.userId} className="border-t border-zinc-800/60">
              <td className="max-w-[160px] truncate py-0.5 pr-2 text-zinc-200">
                {m.isMe && <span className="mr-1 text-emerald-400">◆</span>}
                {m.displayName}
              </td>
              <td className="px-2 py-0.5 text-right text-zinc-500">{a.auctions}</td>
              <td className={`px-2 py-0.5 text-right font-bold ${a.top3Share >= 0.5 ? 'text-amber-400' : 'text-zinc-300'}`}>
                {(a.top3Share * 100).toFixed(0)}
              </td>
              <td className="px-2 py-0.5 text-right text-zinc-400">{(a.earlySpendShare * 100).toFixed(0)}</td>
              <td className="px-2 py-0.5 text-right text-zinc-400">{a.dollarFlyers.toFixed(0)}</td>
              <td className="px-2 py-0.5">
                <MixBar mix={a.spendMix} />
              </td>
              <td className="max-w-[190px] truncate px-2 py-0.5 text-zinc-400">
                {a.maxBuy ? (
                  <>
                    <span className={`mr-1 text-[10px] ${POS_TEXT[a.maxBuy.pos] ?? ''}`}>{a.maxBuy.pos}</span>
                    {a.maxBuy.name} <span className="font-bold text-zinc-200">${a.maxBuy.amount}</span>
                    <span className="text-zinc-600"> '{String(a.maxBuy.season).slice(2)}</span>
                  </>
                ) : (
                  '·'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-zinc-600">
        {footnote} · bar: <span className="text-rose-400">QB</span> <span className="text-emerald-400">RB</span>{' '}
        <span className="text-sky-400">WR</span> <span className="text-amber-400">TE</span>
      </p>
    </>
  );
}

function posNetLabel(posNet: Partial<Record<string, number>>): Array<{ pos: string; n: number }> {
  return Object.entries(posNet)
    .filter(([pos, n]) => n !== 0 && pos !== '?' && pos !== 'K' && pos !== 'DEF')
    .sort((a, b) => Math.abs(b[1]!) - Math.abs(a[1]!))
    .slice(0, 3)
    .map(([pos, n]) => ({ pos, n: n! }));
}

export default async function ManagersPage({ params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const intel = getLeagueIntel(leagueId);
  if (!intel) return <div className="text-zinc-500">league not found</div>;

  const hasAuction = intel.managers.some((m) => m.auction);
  const hasSnake = intel.managers.some((m) => m.snake);
  const hasRookie = intel.managers.some((m) => m.rookie);
  const hasFaab = intel.managers.some((m) => m.faab && m.faab.spendPerSeason > 0);

  const seasonSpan =
    intel.chainSeasons.length > 1
      ? `${intel.chainSeasons[0]}–${intel.chainSeasons[intel.chainSeasons.length - 1]}`
      : String(intel.season);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="font-bold text-zinc-100">{intel.name}</h1>
        <span className="text-xs text-zinc-500">manager intel · {seasonSpan} · draft, trade + faab tendencies</span>
        <Link href={`/league/${leagueId}/board`} className="text-xs text-emerald-400 hover:underline">
          draft board →
        </Link>
        <Link href={`/league/${leagueId}/edge`} className="text-xs text-sky-400 hover:underline">
          edge board →
        </Link>
      </div>

      {/* overview: who they are */}
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
            <th className="py-1 pr-2 font-normal">manager</th>
            <th className="px-2 py-1 font-normal">seasons</th>
            <th className="px-2 py-1 font-normal">read</th>
          </tr>
        </thead>
        <tbody>
          {intel.managers.map((m) => (
            <tr key={m.userId} className="border-t border-zinc-800/60">
              <td className="max-w-[200px] truncate py-0.5 pr-2 font-bold text-zinc-200">
                {m.isMe && <span className="mr-1 text-emerald-400">◆</span>}
                {m.displayName}
                {m.teamName && <span className="ml-1.5 font-normal text-zinc-600">{m.teamName}</span>}
              </td>
              <td className="px-2 py-0.5 text-zinc-500">{m.seasons.length ? `${m.seasons.length} (${m.seasons[0]}–)` : '·'}</td>
              <td className="px-2 py-0.5">
                {m.tags.length ? (
                  <span className="flex flex-wrap gap-1">
                    {m.tags.map((t) => (
                      <span key={t} className="rounded border border-zinc-700 px-1 py-0 text-[10px] text-zinc-300">
                        {t}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-zinc-600">not enough history</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {hasAuction && (
        <AuctionTable
          title="auction bidding"
          entries={intel.managers.filter((m) => m.auction).map((m) => ({ m, a: m.auction! }))}
          footnote="top-3 $% = share of budget on 3 priciest wins (≥50 = stars & scrubs) · early $% = spend committed in first third of the room"
        />
      )}

      {intel.managers.some((m) => m.rookieAuction) && (
        <AuctionTable
          title="rookie auctions"
          entries={intel.managers.filter((m) => m.rookieAuction).map((m) => ({ m, a: m.rookieAuction! }))}
          footnote="small rookies-only auction events (FAAB or budget) — tracked separately from full auctions"
        />
      )}

      {hasSnake && (
        <>
          <h2 className="mb-1 mt-6 text-[11px] font-bold uppercase tracking-wide text-zinc-400">snake drafts</h2>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
                <th className="py-1 pr-2 font-normal">manager</th>
                <th className="px-2 py-1 text-right font-normal">drafts</th>
                <th className="px-2 py-1 text-right font-normal">1st QB</th>
                <th className="px-2 py-1 text-right font-normal">1st RB</th>
                <th className="px-2 py-1 text-right font-normal">1st WR</th>
                <th className="px-2 py-1 text-right font-normal">1st TE</th>
                <th className="px-2 py-1 font-normal">rounds 1-3 mix</th>
              </tr>
            </thead>
            <tbody>
              {intel.managers
                .filter((m) => m.snake)
                .map((m) => (
                  <tr key={m.userId} className="border-t border-zinc-800/60">
                    <td className="max-w-[160px] truncate py-0.5 pr-2 text-zinc-200">
                      {m.isMe && <span className="mr-1 text-emerald-400">◆</span>}
                      {m.displayName}
                    </td>
                    <td className="px-2 py-0.5 text-right text-zinc-500">{m.snake!.drafts}</td>
                    {(['QB', 'RB', 'WR', 'TE'] as const).map((pos) => (
                      <td key={pos} className="px-2 py-0.5 text-right text-zinc-300">
                        {m.snake!.firstRound[pos] !== undefined ? `r${m.snake!.firstRound[pos]!.toFixed(1)}` : '·'}
                      </td>
                    ))}
                    <td className="px-2 py-0.5">
                      <MixBar mix={m.snake!.earlyMix} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-zinc-600">1st QB/RB/WR/TE = average round of their first pick at the position (keepers excluded)</p>
        </>
      )}

      {hasRookie && (
        <>
          <h2 className="mb-1 mt-6 text-[11px] font-bold uppercase tracking-wide text-zinc-400">rookie drafts</h2>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
                <th className="py-1 pr-2 font-normal">manager</th>
                <th className="px-2 py-1 text-right font-normal">drafts</th>
                <th className="px-2 py-1 text-right font-normal">picks</th>
                <th className="px-2 py-1 font-normal">position mix</th>
              </tr>
            </thead>
            <tbody>
              {intel.managers
                .filter((m) => m.rookie)
                .map((m) => (
                  <tr key={m.userId} className="border-t border-zinc-800/60">
                    <td className="max-w-[160px] truncate py-0.5 pr-2 text-zinc-200">
                      {m.isMe && <span className="mr-1 text-emerald-400">◆</span>}
                      {m.displayName}
                    </td>
                    <td className="px-2 py-0.5 text-right text-zinc-500">{m.rookie!.drafts}</td>
                    <td className="px-2 py-0.5 text-right text-zinc-400">{m.rookie!.picks}</td>
                    <td className="px-2 py-0.5">
                      <MixBar mix={m.rookie!.posMix} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}

      <h2 className="mb-1 mt-6 text-[11px] font-bold uppercase tracking-wide text-zinc-400">trades{hasFaab ? ' + faab' : ''}</h2>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-zinc-700 text-left text-[11px] text-zinc-500">
            <th className="py-1 pr-2 font-normal">manager</th>
            <th className="px-2 py-1 text-right font-normal">trades/yr</th>
            <th className="px-2 py-1 text-right font-normal">picks ±</th>
            <th className="px-2 py-1 font-normal">position flow</th>
            <th className="px-2 py-1 font-normal">go-to partner</th>
            {hasFaab && (
              <>
                <th className="px-2 py-1 text-right font-normal">faab %</th>
                <th className="px-2 py-1 text-right font-normal">max bid</th>
                <th className="px-2 py-1 text-right font-normal">adds/yr</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {intel.managers.map((m) => {
            const pickNet = m.trades.picksAcquired - m.trades.picksSent;
            const flow = posNetLabel(m.trades.posNet);
            return (
              <tr key={m.userId} className="border-t border-zinc-800/60">
                <td className="max-w-[160px] truncate py-0.5 pr-2 text-zinc-200">
                  {m.isMe && <span className="mr-1 text-emerald-400">◆</span>}
                  {m.displayName}
                </td>
                <td className={`px-2 py-0.5 text-right font-bold ${m.trades.perSeason >= 3 ? 'text-emerald-400' : m.trades.total === 0 ? 'text-zinc-600' : 'text-zinc-300'}`}>
                  {m.trades.perSeason.toFixed(1)}
                </td>
                <td className={`px-2 py-0.5 text-right ${pickNet > 0 ? 'text-emerald-400' : pickNet < 0 ? 'text-red-400' : 'text-zinc-500'}`}>
                  {pickNet > 0 ? `+${pickNet}` : pickNet || '·'}
                </td>
                <td className="px-2 py-0.5">
                  {flow.length ? (
                    <span className="flex gap-2">
                      {flow.map(({ pos, n }) => (
                        <span key={pos} className={n > 0 ? 'text-emerald-400/90' : 'text-red-400/90'}>
                          <span className={`text-[10px] ${POS_TEXT[pos] ?? ''}`}>{pos}</span>
                          {n > 0 ? `+${n}` : n}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-zinc-600">·</span>
                  )}
                </td>
                <td className="max-w-[150px] truncate px-2 py-0.5 text-zinc-400">
                  {m.trades.topPartners[0] ? `${m.trades.topPartners[0].name} ×${m.trades.topPartners[0].count}` : '·'}
                </td>
                {hasFaab && (
                  <>
                    <td className={`px-2 py-0.5 text-right ${m.faab?.budgetShare !== null && m.faab !== null && m.faab.budgetShare! >= 0.8 ? 'font-bold text-amber-400' : 'text-zinc-300'}`}>
                      {m.faab?.budgetShare !== null && m.faab !== undefined && m.faab !== null ? (m.faab.budgetShare! * 100).toFixed(0) : '·'}
                    </td>
                    <td className="px-2 py-0.5 text-right text-zinc-400">{m.faab ? `$${m.faab.maxBid}` : '·'}</td>
                    <td className="px-2 py-0.5 text-right text-zinc-400">{m.faab ? m.faab.addsPerSeason.toFixed(0) : '·'}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-zinc-600">
        picks ± = draft picks acquired − sent via trade, all seasons · position flow = players in/out by position · faab % = avg share
        of waiver budget actually spent per season (&gt;100 = acquired extra via trade)
      </p>
    </div>
  );
}
