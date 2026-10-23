import type { BinInfo, CardBrand, CardForm, CardFunding, CardStatus, LimitPeriod } from './card.ts';
import type {
  AccountType,
  BillKind,
  CardTheme,
  CategoryKind,
  InstitutionType,
  OccurrenceStatus,
  Role,
  SessionMethod,
  TransactionType,
  VerificationStatus,
} from './enums.ts';
import type { RecurrenceFreq } from './recurrence.ts';

/** Response shapes of the REST API. Amounts are integer minor units. */

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled' | 'pending';
  totpEnabled: boolean;
  passkeyCount: number;
  /** Image data URL, or null (initials are shown). */
  avatar: string | null;
  createdAt: number;
}

export interface MeDto {
  user: UserDto;
  session: {
    id: string;
    method: SessionMethod;
    createdAt: number;
    /** Epoch ms until which sensitive actions are allowed without re-verifying. */
    stepUpUntil: number | null;
  };
}

export interface SessionDto {
  id: string;
  method: SessionMethod;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

export interface PasskeyDto {
  id: string;
  name: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface InviteDto {
  id: string;
  role: Role;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByName: string | null;
}

export interface AuditDto {
  id: string;
  action: string;
  detail: unknown;
  ip: string | null;
  createdAt: number;
  username: string | null;
}

export interface InstitutionDto {
  id: string;
  name: string;
  country: string;
  type: InstitutionType;
  color: string | null;
  website: string | null;
  note: string | null;
  extra: Record<string, unknown>;
  sort: number;
  archived: boolean;
  accountCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AccountCurrencyDto {
  currency: string;
  openingBalance: number;
  /** The opening balance is the balance at the end of this day (null: all transactions count). */
  balanceDate: string | null;
  includeInTotal: boolean;
  /** Opening balance + Σ transactions in this currency. */
  balance: number;
  transactionCount: number;
}

export interface AccountDto {
  id: string;
  institutionId: string;
  name: string;
  type: AccountType;
  /** Primary currency (first of `currencies`). */
  currency: string;
  /** One entry per currency held; multi-currency accounts have several. */
  currencies: AccountCurrencyDto[];
  openingDate: string;
  creditLimit: number | null;
  numberLast4: string | null;
  note: string | null;
  extra: Record<string, unknown>;
  sort: number;
  archived: boolean;
  transactionCount: number;
  cardCount: number;
  /**
   * Stocks held in this account. Their market value is already included in the USD balance
   * (balance = cash + market value).
   */
  investment: { marketValue: number; costBasis: number; unrealized: number; positions: number; unpriced: number } | null;
  /** Credit accounts with a limit: amount owed in the primary currency vs the limit. */
  creditUsage: { used: number; limit: number; percent: number; over: boolean } | null;
  /** Pays for stock trades: its USD balance is always shown, even at 0. */
  stockCash: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CardDto {
  id: string;
  accountId: string;
  form: CardForm;
  parentCardId: string | null;
  status: CardStatus;
  spendLimit: number | null;
  limitPeriod: LimitPeriod | null;
  singleUse: boolean;
  merchant: string | null;
  binInfo: BinInfo | null;
  /** Expenses counted against the limit (this month / all time), in the account's primary currency. */
  spent: number | null;
  nickname: string | null;
  brand: CardBrand;
  funding: CardFunding;
  bin: string | null;
  last4: string;
  hasPan: boolean;
  expMonth: number | null;
  expYear: number | null;
  holderName: string | null;
  statementDay: number | null;
  dueDay: number | null;
  theme: CardTheme;
  note: string | null;
  extra: Record<string, unknown>;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CategoryDto {
  id: string;
  kind: CategoryKind;
  name: string;
  parentId: string | null;
  icon: string | null;
  color: string | null;
  sort: number;
  archived: boolean;
}

export interface TagDto {
  id: string;
  name: string;
  color: string | null;
  count: number;
}

export interface TransactionDto {
  id: string;
  accountId: string;
  cardId: string | null;
  type: TransactionType;
  /** Signed: income > 0, expense < 0, transfer out < 0, transfer in > 0. */
  amount: number;
  currency: string;
  occurredAt: string;
  /** Optional details (null when not recorded; older transactions have none). Both legs of a transfer share them. */
  occurredTime: string | null;
  timeZone: string | null;
  purpose: string | null;
  paymentChannel: string | null;
  referenceNumber: string | null;
  evidenceSource: string | null;
  verificationStatus: VerificationStatus | null;
  categoryId: string | null;
  counterparty: string | null;
  note: string | null;
  transferGroupId: string | null;
  /** For transfers: the account on the other side. */
  counterpartAccountId: string | null;
  counterpartAmount: number | null;
  counterpartCurrency: string | null;
  billOccurrenceId: string | null;
  statementId: string | null;
  tagIds: string[];
  extra: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CurrencySums {
  currency: string;
  income: number;
  expense: number;
}

export interface TransactionListDto {
  items: TransactionDto[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * Income/expense of the whole filtered set (not just the page), per currency. Transfers excluded.
   * Always empty for the outflow view, whose rows mix spending with transfers and share purchases.
   */
  sums: CurrencySums[];
}

export interface BillDto {
  id: string;
  name: string;
  kind: BillKind;
  amount: number;
  currency: string;
  accountId: string | null;
  cardId: string | null;
  categoryId: string | null;
  /** null for one-time bills. */
  freq: RecurrenceFreq | null;
  interval: number;
  startDate: string;
  endDate: string | null;
  remindDaysBefore: number;
  active: boolean;
  note: string | null;
  nextDueDate: string | null;
  createdAt: number;
  updatedAt: number;
  /** Only on create: how past due dates were handled. */
  past?: { recorded: number; markedPaid: number };
}

export interface BillOccurrenceDto {
  id: string;
  billId: string;
  billName: string;
  billKind: BillKind;
  dueDate: string;
  amount: number;
  currency: string;
  status: OccurrenceStatus;
  transactionId: string | null;
}

export interface StatementDto {
  id: string;
  cardId: string;
  accountId: string;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  statementDate: string;
  dueDate: string;
  statementAmount: number;
  minPayment: number | null;
  paidAmount: number;
  remaining: number;
  status: 'unpaid' | 'partial' | 'paid';
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ReminderKind = 'bill' | 'statement' | 'card_due' | 'card_expiry' | 'over_limit';

export interface ReminderDto {
  key: string;
  kind: ReminderKind;
  title: string;
  date: string;
  daysLeft: number;
  amount: number | null;
  currency: string | null;
  refId: string;
  severity: 'overdue' | 'soon' | 'upcoming';
}

export interface CurrencyTotal {
  currency: string;
  assets: number;
  liabilities: number;
  net: number;
  accountCount: number;
}

export interface DashboardAccountNode {
  id: string;
  name: string;
  type: AccountType;
  balances: { currency: string; balance: number }[];
  creditUsage: AccountDto['creditUsage'];
  /** Market value of the stocks held (included in the USD balance). */
  holdings: number | null;
  stockCash: boolean;
}

export interface DashboardInstitutionNode {
  id: string;
  name: string;
  type: InstitutionType;
  color: string | null;
  accounts: DashboardAccountNode[];
}

export interface DashboardCountryNode {
  country: string;
  institutions: DashboardInstitutionNode[];
}

export interface DashboardDto {
  totals: CurrencyTotal[];
  /** Everything converted to the default currency with the last synced FX rates. */
  converted: { currency: string; net: number; assets: number; liabilities: number; asOf: string | null; missing: string[] } | null;
  investments: { marketValue: number; unrealized: number; positions: number } | null;
  tree: DashboardCountryNode[];
  recent: TransactionDto[];
  month: CurrencySums[];
  counts: { institutions: number; accounts: number; cards: number };
}

export interface StatsDto {
  /** Currencies with income/expense (or stock activity) in the range. */
  currencies: string[];
  /** The single currency shown, or null for the combined view. */
  currency: string | null;
  /** Combined view: everything converted to this currency with the synced FX rates. */
  convertedTo: string | null;
  /** Combined view: currencies left out for lack of an FX rate. */
  missing: string[];
  totals: { income: number; expense: number; count: number };
  months: { month: string; income: number; expense: number }[];
  byCategory: { categoryId: string | null; amount: number; count: number }[];
  byTag: { tagId: string; amount: number; count: number }[];
  byInstitution: { institutionId: string; income: number; expense: number }[];
  /** Realized stock P/L in the range (USD only; null when excluded or another currency). */
  invest: { gain: number; loss: number; sells: number } | null;
  /**
   * Money paid for stock buys (out) and received from sells (in), from the cash legs in the
   * paying accounts. Shown on its own: buying shares is not spending (USD only).
   */
  stockFlows: {
    buy: number;
    sell: number;
    count: number;
    months: { month: string; buy: number; sell: number }[];
    byAccount: { accountId: string; buy: number; sell: number }[];
  } | null;
}

/** byCategory entry standing for realized stock losses. */
export const INVEST_CATEGORY = '__invest';

/**
 * Tag name for small everyday spending kept out of the transactions list by default
 * (still counted in the statistics). Case-insensitive.
 */
export const HIDDEN_TAG = 'hidden';

export interface ConfigSaveResultDto {
  changed: boolean;
  diff: string;
}

export interface FxRateDto {
  currency: string;
  /** Units of the currency per 1 USD. */
  perUsd: number;
  asOf: string;
  source: string;
  updatedAt: number;
}

export interface FxDto {
  rates: FxRateDto[];
  syncedAt: number | null;
}

export interface TradeDto {
  id: string;
  /** Investment account holding the shares. */
  accountId: string | null;
  /** Account paid from / into (where the cash leg `transactionId` is booked). */
  cashAccountId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  /** Decimal strings (fractional shares, 6 decimals). */
  quantity: string;
  price: string;
  /** Gross amount (quantity × price) and fee, in minor units of `currency`. */
  amount: number;
  fee: number;
  currency: string;
  tradeDate: string;
  transactionId: string | null;
  note: string | null;
}

export interface HoldingDto {
  symbol: string;
  name: string | null;
  accountId: string | null;
  quantity: string;
  /** Average cost per share (decimal string) and total cost basis (minor units, incl. fees). */
  avgCost: string;
  costBasis: number;
  price: string | null;
  priceAt: number | null;
  marketValue: number | null;
  unrealized: number | null;
  realized: number;
}

export interface InvestDto {
  currency: 'USD';
  holdings: HoldingDto[];
  /** Positions closed out completely (realized P/L only). */
  closed: HoldingDto[];
  trades: TradeDto[];
  totals: { marketValue: number; costBasis: number; unrealized: number; realized: number };
}

export interface QuoteProblem {
  symbol: string;
  /** not_found: the quote source has no such ticker (typo?); error: temporary failure. */
  reason: 'not_found' | 'error';
  /** Closest ticker from the quote source's search, e.g. APPL → AAPL. */
  suggestion: string | null;
}

export interface PriceSyncDto extends InvestDto {
  updated: number;
  failed: QuoteProblem[];
  /** Holdings not refreshed this time (more than 30); press sync again. */
  remaining: number;
}
