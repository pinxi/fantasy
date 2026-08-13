import { z } from 'zod';
import { evaluateTrade, findTrades, type TradeAsset } from '@/services/trade';

export const dynamic = 'force-dynamic';

const AssetSchema = z.union([
  z.object({ kind: z.literal('player'), playerId: z.string() }),
  z.object({ kind: z.literal('pick'), label: z.string() }),
]);

const BodySchema = z.union([
  z.object({
    mode: z.literal('evaluate'),
    counterpartyRosterId: z.number(),
    give: z.array(AssetSchema),
    receive: z.array(AssetSchema),
  }),
  z.object({
    mode: z.literal('find'),
    position: z.string().optional(),
    stance: z.enum(['any', 'consolidate', 'spread']).optional(),
  }),
]);

export async function POST(request: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const { leagueId } = await params;
  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: 'bad request' }, { status: 400 });

  if (parsed.data.mode === 'evaluate') {
    const result = await evaluateTrade({
      leagueId,
      counterpartyRosterId: parsed.data.counterpartyRosterId,
      give: parsed.data.give as TradeAsset[],
      receive: parsed.data.receive as TradeAsset[],
    });
    return Response.json(result);
  }
  const result = await findTrades(leagueId, { position: parsed.data.position, stance: parsed.data.stance });
  return Response.json(result);
}
