import { grossMinor, microsToString, type HoldingDto } from '@z-ui/shared';

export interface TradeRow {
  id: string;
  accountId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  quantityMicros: number;
  priceMicros: number;
  amount: number;
  fee: number;
  tradeDate: string;
  createdAt: number;
}

export interface PriceRow {
  symbol: string;
  name: string | null;
  priceMicros: number | null;
  priceAt: number | null;
}

interface Position {
  symbol: string;
  accountId: string | null;
  qty: bigint; // micros
  cost: number; // minor units, fees included
  realized: number;
}

export interface RealizedSell {
  tradeId: string;
  date: string;
  accountId: string | null;
  symbol: string;
  /** Gain (> 0) or loss (< 0) in minor units. */
  realized: number;
}

/**
 * Average-cost positions per (account, symbol), trades replayed in date order:
 *   buy  → qty += q, cost += amount + fee
 *   sell → cost out = cost × q / qty; realized += (amount − fee) − cost out
 * Also returns the realized result of each sell (for statistics).
 */
function replay(trades: TradeRow[]): { positions: Position[]; sells: RealizedSell[] } {
  const sorted = [...trades].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.createdAt - b.createdAt);
  const map = new Map<string, Position>();
  const sells: RealizedSell[] = [];
  for (const t of sorted) {
    const key = `${t.accountId ?? ''}|${t.symbol}`;
    const p = map.get(key) ?? { symbol: t.symbol, accountId: t.accountId, qty: 0n, cost: 0, realized: 0 };
    const q = BigInt(t.quantityMicros);
    if (t.side === 'buy') {
      p.qty += q;
      p.cost += t.amount + t.fee;
    } else if (p.qty > 0n) {
      const sold = q > p.qty ? p.qty : q;
      const costOut = Math.round((p.cost * Number(sold)) / Number(p.qty));
      const realized = t.amount - t.fee - costOut;
      p.realized += realized;
      p.cost -= costOut;
      p.qty -= sold;
      sells.push({ tradeId: t.id, date: t.tradeDate, accountId: t.accountId, symbol: t.symbol, realized });
    }
    map.set(key, p);
  }
  return { positions: [...map.values()], sells };
}

export const positions = (trades: TradeRow[]): Position[] => replay(trades).positions;
export const realizedSells = (trades: TradeRow[]): RealizedSell[] => replay(trades).sells;

/** Shares held right now for one account/symbol, ignoring one trade (when editing it). */
export function heldMicros(trades: TradeRow[], accountId: string | null, symbol: string, excludeId?: string): bigint {
  const p = positions(trades.filter((t) => t.id !== excludeId && t.symbol === symbol && t.accountId === accountId))[0];
  return p?.qty ?? 0n;
}

export function toHoldings(list: Position[], prices: PriceRow[]): HoldingDto[] {
  return list.map((p) => {
    const price = prices.find((x) => x.symbol === p.symbol);
    const qty = Number(p.qty);
    const marketValue = price?.priceMicros != null ? grossMinor(qty, price.priceMicros) : null;
    return {
      symbol: p.symbol,
      name: price?.name ?? null,
      accountId: p.accountId,
      quantity: microsToString(qty),
      avgCost: qty > 0 ? microsToString(Math.round((p.cost * 1e10) / qty)) : '0',
      costBasis: p.cost,
      price: price?.priceMicros != null ? microsToString(price.priceMicros) : null,
      priceAt: price?.priceAt ?? null,
      marketValue,
      unrealized: marketValue !== null ? marketValue - p.cost : null,
      realized: p.realized,
    };
  });
}
