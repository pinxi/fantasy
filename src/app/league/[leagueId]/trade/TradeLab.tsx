'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResolvedAsset, RosterDetail, TradeAsset, TradeEvaluation, TradeProposal } from '@/services/trade';

// First client component in the app: interactive give/get picking with a
// debounced server evaluation. All math happens server-side.

interface Props {
  leagueId: string;
  rosters: RosterDetail[];
  myRosterId: number;
  isDynasty: boolean;
  pickLabels: string[];
}

const POS_COLORS: Record<string, string> = {
  QB: 'text-rose-400',
  RB: 'text-emerald-400',
  WR: 'text-sky-400',
  TE: 'text-amber-400',
  K: 'text-violet-400',
  DEF: 'text-stone-400',
  DL: 'text-orange-400',
  LB: 'text-lime-400',
  DB: 'text-cyan-400',
};

function assetKey(a: TradeAsset): string {
  return a.kind === 'player' ? `p:${a.playerId}` : `k:${a.label}`;
}

function DeltaMeter({ label, value, verdict, unit }: { label: string; value: number; verdict?: string; unit: string }) {
  const even = verdict === 'even';
  const color = even ? 'text-zinc-500' : value > 0 ? 'text-emerald-400' : 'text-red-400';
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-zinc-500">{label}</span>
      <span className={`font-bold ${color}`}>
        {even ? '≈ even' : `${value > 0 ? '+' : ''}${value.toFixed(unit === '$' ? 0 : 1)}${unit === '$' ? '' : ` ${unit}`}`}
      </span>
    </div>
  );
}

export default function TradeLab({ leagueId, rosters, myRosterId, isDynasty, pickLabels }: Props) {
  const rivals = rosters.filter((r) => r.rosterId !== myRosterId && r.ownerId);
  const mine = rosters.find((r) => r.rosterId === myRosterId)!;
  const [counterpartyId, setCounterpartyId] = useState(rivals[0]?.rosterId ?? 0);
  const [give, setGive] = useState<TradeAsset[]>([]);
  const [receive, setReceive] = useState<TradeAsset[]>([]);
  const [evaluation, setEvaluation] = useState<TradeEvaluation | null>(null);
  const [proposals, setProposals] = useState<TradeProposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const counterparty = rivals.find((r) => r.rosterId === counterpartyId);

  const toggle = (side: 'give' | 'receive', asset: TradeAsset) => {
    const [list, set] = side === 'give' ? ([give, setGive] as const) : ([receive, setReceive] as const);
    const key = assetKey(asset);
    set(list.some((a) => assetKey(a) === key) ? list.filter((a) => assetKey(a) !== key) : [...list, asset]);
  };

  const evaluate = useCallback(async () => {
    if (give.length === 0 && receive.length === 0) {
      setEvaluation(null);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const res = await fetch(`/league/${leagueId}/trade/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'evaluate', counterpartyRosterId: counterpartyId, give, receive }),
        signal: controller.signal,
      });
      const data = (await res.json()) as TradeEvaluation | { error: string };
      if (!controller.signal.aborted) setEvaluation('error' in data ? null : data);
    } catch {
      // aborted or network — keep last state
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [leagueId, counterpartyId, give, receive]);

  useEffect(() => {
    const t = setTimeout(() => void evaluate(), 150);
    return () => clearTimeout(t);
  }, [evaluate]);

  const scan = async () => {
    setBusy(true);
    setProposals(null);
    try {
      const res = await fetch(`/league/${leagueId}/trade/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'find' }),
      });
      const data = (await res.json()) as TradeProposal[] | { error: string };
      setProposals(Array.isArray(data) ? data : []);
    } finally {
      setBusy(false);
    }
  };

  const loadProposal = (p: TradeProposal) => {
    setCounterpartyId(p.counterpartyRosterId);
    setGive(p.give.map((a) => ({ kind: 'player', playerId: a.playerId! })));
    setReceive(p.receive.map((a) => ({ kind: 'player', playerId: a.playerId! })));
  };

  const rosterColumn = (roster: RosterDetail, side: 'give' | 'receive', selected: TradeAsset[]) => (
    <div className="max-h-[560px] overflow-y-auto rounded border border-zinc-800">
      <table className="w-full text-[11px]">
        <tbody>
          {roster.players.map((p) => {
            const asset: TradeAsset = { kind: 'player', playerId: p.playerId! };
            const isSelected = selected.some((a) => assetKey(a) === assetKey(asset));
            return (
              <tr
                key={p.playerId}
                onClick={() => toggle(side, asset)}
                className={`cursor-pointer border-t border-zinc-800/50 hover:bg-zinc-900 ${
                  isSelected ? (side === 'give' ? 'bg-emerald-950/40' : 'bg-sky-950/40') : ''
                }`}
              >
                <td className={`w-7 px-1.5 py-0.5 ${POS_COLORS[p.pos ?? ''] ?? 'text-zinc-500'}`}>{p.pos}</td>
                <td className="max-w-[140px] truncate py-0.5">
                  {p.label}
                  {(p.taxi || p.reserve) && <span className="ml-1 text-[9px] text-amber-500">{p.taxi ? 'TX' : 'IR'}</span>}
                </td>
                <td className="px-1.5 py-0.5 text-right text-zinc-500">{p.seasonPts?.toFixed(0) ?? '·'}</td>
                <td className="px-1.5 py-0.5 text-right text-zinc-600">{p.marketValue !== null ? Math.round(p.marketValue) : '·'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1.2fr_1fr]">
        <div>
          <div className="mb-1 text-[11px] font-bold text-zinc-400">my roster — click to give</div>
          {rosterColumn(mine, 'give', give)}
        </div>

        <div className="rounded border border-zinc-800 p-3">
          <div className="mb-2 text-[11px] font-bold text-zinc-400">verdict {busy && <span className="text-zinc-600">…</span>}</div>
          {evaluation ? (
            <div className="flex flex-col gap-3">
              <div className="rounded border border-zinc-800 p-2">
                <div className="mb-1 text-[10px] text-zinc-500">MY SIDE</div>
                <DeltaMeter label="rest of season" value={evaluation.me.deltaRos} verdict={evaluation.verdict.ros} unit="pts" />
                <DeltaMeter label="playoff wks 15-17 (×2)" value={evaluation.me.deltaWeighted} verdict={evaluation.verdict.playoff} unit="pts" />
                <DeltaMeter
                  label={evaluation.league.isDynasty ? 'dynasty market' : 'market value'}
                  value={evaluation.me.deltaMarket}
                  verdict={evaluation.verdict.market}
                  unit="$"
                />
                <div className="mt-1 text-[10px] text-zinc-600">
                  lineup {evaluation.me.before.rosPts.toFixed(0)} → {evaluation.me.after.rosPts.toFixed(0)}
                </div>
              </div>
              <div className="rounded border border-zinc-800 p-2">
                <div className="mb-1 text-[10px] text-zinc-500">{evaluation.them.ownerName.toUpperCase()}</div>
                <DeltaMeter label="rest of season" value={evaluation.them.deltaRos} unit="pts" />
                <DeltaMeter label="market" value={evaluation.them.deltaMarket} unit="$" />
                <div className="mt-1 text-[10px] text-zinc-600">
                  lineup {evaluation.them.before.rosPts.toFixed(0)} → {evaluation.them.after.rosPts.toFixed(0)}
                </div>
              </div>
              {evaluation.warnings.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {evaluation.warnings.map((w) => (
                    <span key={w} className="rounded border border-amber-900 px-1.5 py-0.5 text-[10px] text-amber-300">
                      {w}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-[10px] text-zinc-600">mkt src: {evaluation.marketSource} · from wk {evaluation.fromWeek}</div>
            </div>
          ) : (
            <p className="text-[11px] text-zinc-600">click players on both sides to evaluate</p>
          )}

          {isDynasty && pickLabels.length > 0 && (
            <div className="mt-3 flex gap-2 text-[10px]">
              <select
                className="rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-zinc-300"
                onChange={(e) => {
                  if (e.target.value) toggle('give', { kind: 'pick', label: e.target.value });
                  e.target.value = '';
                }}
                defaultValue=""
              >
                <option value="">+ pick I give…</option>
                {pickLabels.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
              <select
                className="rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-zinc-300"
                onChange={(e) => {
                  if (e.target.value) toggle('receive', { kind: 'pick', label: e.target.value });
                  e.target.value = '';
                }}
                defaultValue=""
              >
                <option value="">+ pick I get…</option>
                {pickLabels.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </div>
          )}
          {(give.some((a) => a.kind === 'pick') || receive.some((a) => a.kind === 'pick')) && (
            <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
              {give.filter((a) => a.kind === 'pick').map((a) => (
                <button key={assetKey(a)} onClick={() => toggle('give', a)} className="rounded border border-emerald-900 px-1.5 py-0.5 text-emerald-300">
                  give {a.kind === 'pick' ? a.label : ''} ✕
                </button>
              ))}
              {receive.filter((a) => a.kind === 'pick').map((a) => (
                <button key={assetKey(a)} onClick={() => toggle('receive', a)} className="rounded border border-sky-900 px-1.5 py-0.5 text-sky-300">
                  get {a.kind === 'pick' ? a.label : ''} ✕
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-baseline gap-2">
            <select
              className="rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-300"
              value={counterpartyId}
              onChange={(e) => {
                setCounterpartyId(Number(e.target.value));
                setReceive([]);
              }}
            >
              {rivals.map((r) => (
                <option key={r.rosterId} value={r.rosterId}>
                  {r.ownerName}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-zinc-500">— click to receive</span>
          </div>
          {counterparty && rosterColumn(counterparty, 'receive', receive)}
        </div>
      </div>

      <div className="mt-4">
        <button
          onClick={() => void scan()}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-violet-500 hover:text-violet-300"
        >
          scan league for trades
        </button>
        {proposals && (
          <div className="mt-2 flex flex-col gap-1">
            {proposals.length === 0 && <p className="text-[11px] text-zinc-600">no plausible upgrades found</p>}
            {proposals.map((p, i) => (
              <button
                key={i}
                onClick={() => loadProposal(p)}
                title={p.reasons.join('\n')}
                className="flex items-baseline gap-2 rounded border border-zinc-800 px-2 py-1 text-left text-[11px] hover:border-zinc-600"
              >
                <span className="text-zinc-400">{p.ownerName}:</span>
                <span className="text-emerald-300">{p.give.map((a) => a.label).join(' + ')}</span>
                <span className="text-zinc-600">→</span>
                <span className="text-sky-300">{p.receive.map((a) => a.label).join(' + ')}</span>
                <span className="ml-auto font-bold text-emerald-400">+{p.myDeltaRos.toFixed(0)} ROS</span>
                <span className="text-zinc-500">{Math.round(p.plausibility * 100)}% plaus</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
