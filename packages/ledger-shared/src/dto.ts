import type {
  AccountCurrencyStatus,
  AccountStatus,
  AccountType,
  AmountStatus,
  CardForm,
  CardLinkRole,
  CardLinkStatus,
  CardNetwork,
  CardStatus,
  CardType,
  ChannelSourceStatus,
  ChannelStatus,
  ChannelType,
  CounterpartyKind,
  CountrySource,
  CurrencyStatusAtSave,
  DepositKind,
  EntryDirection,
  ForeignStatus,
  HomeRegionSource,
  IdempotentOperation,
  InstitutionStatus,
  InstitutionType,
  LedgerErrorCode,
  MerchantScope,
  NoMatchReason,
  RecordMode,
  RevisionKind,
  SpendingSkipReason,
  TransactionErrorCode,
  TransferMethod,
  TransferScope,
  TxnStatus,
  TxnType,
} from './enums.ts';
import type { EntryShapeRule } from './transactions.ts';

/**
 * Response shapes of the M2 API (API_SPEC §3). camelCase; dates YYYY-MM-DD, expiry YYYY-MM,
 * timestamps epoch milliseconds. No DTO carries an amount or a balance — X-UI v1 has neither
 * in M2 — and no card DTO carries a card number, BIN, CVV, PIN or holder name.
 */

export interface ErrorBody {
  error: string;
  code: LedgerErrorCode | TransactionErrorCode | (string & {});
  details?: unknown;
}

export interface ProfileSettingsDto {
  homeRegion: string;
  /** true while the user has no user_preferences row (homeRegion is then DEFAULT_HOME_REGION); false once saved, CN included. */
  isDefault: boolean;
}

// ------------------------------------------------------------------ summaries (embedded in other DTOs)

export interface InstitutionSummary {
  id: string;
  name: string;
  institutionType: InstitutionType;
  color: string | null;
  status: InstitutionStatus;
}

export interface AccountSummary {
  id: string;
  name: string;
  accountCountry: string;
  status: AccountStatus;
}

export interface CardSummary {
  id: string;
  name: string;
  network: CardNetwork;
  last4: string;
  cardType: CardType;
  status: CardStatus;
}

export interface ChannelSummary {
  id: string;
  name: string;
  channelType: ChannelType;
  status: ChannelStatus;
}

// ------------------------------------------------------------------ institutions

export interface InstitutionDto {
  id: string;
  name: string;
  country: string | null;
  institutionType: InstitutionType;
  website: string | null;
  color: string | null;
  notes: string | null;
  status: InstitutionStatus;
  sort: number;
  createdAt: number;
  updatedAt: number;
}

export interface InstitutionListItem extends InstitutionDto {
  accountCount: number;
  cardCount: number;
  channelCount: number;
}

export interface InstitutionDetail extends InstitutionListItem {
  accounts: AccountSummary[];
  cards: CardSummary[];
  channels: ChannelSummary[];
}

// ------------------------------------------------------------------ accounts

export interface AccountCurrencyDto {
  currency: string;
  isDefault: boolean;
  status: AccountCurrencyStatus;
  sort: number;
}

export interface AccountDto {
  id: string;
  institutionId: string;
  institution: InstitutionSummary;
  name: string;
  accountType: AccountType;
  depositKind: DepositKind | null;
  accountCountry: string;
  numberHint: string | null;
  status: AccountStatus;
  openedOn: string | null;
  closedOn: string | null;
  notes: string | null;
  sort: number;
  currencies: AccountCurrencyDto[];
  createdAt: number;
  updatedAt: number;
}

export interface AccountListItem extends AccountDto {
  linkedCardCount: number;
  /** First three linked cards. */
  linkedCards: CardSummary[];
}

export interface AccountDetail extends AccountDto {
  /** Every link, ended ones included (status tells them apart). */
  links: CardLinkDto[];
  /** Channels using this account as their balance account. */
  balanceOfChannels: ChannelSummary[];
  /** Channels listing this account as a funding source. */
  sourceOfChannels: ChannelSummary[];
}

/**
 * details of DELETE /accounts/:id → 409 IN_USE: the channels using the account as their balance
 * account, and (M3, API_SPEC §5.12) how many transactions — any version, voided ones too — have an
 * entry on it. Both counts are always present.
 */
export interface AccountInUseDetails {
  references: { balanceOfChannels: number; transactions: number };
  channels: ChannelSummary[];
}

/** details of DELETE /cards/:id and DELETE /payment-channels/:id → 409 IN_USE (M3, API_SPEC §5.12). */
export interface TransactionReferencesDetails {
  references: { transactions: number };
}

/** details of PUT /accounts/:id/currencies → 409 CURRENCY_IN_USE: removed currencies still referenced by a card link or an entry. */
export interface CurrencyInUseDetails {
  currencies: string[];
}

// ------------------------------------------------------------------ cards

export interface CardDto {
  id: string;
  issuerInstitutionId: string;
  issuer: InstitutionSummary;
  name: string;
  network: CardNetwork;
  cardType: CardType;
  form: CardForm;
  last4: string;
  issuingCountry: string;
  expiresOn: string | null;
  status: CardStatus;
  notes: string | null;
  sort: number;
  createdAt: number;
  updatedAt: number;
}

export interface CardListItem extends CardDto {
  linkedAccounts: AccountSummary[];
}

export interface CardDetail extends CardDto {
  /** Every link, ended ones included (status tells them apart). */
  links: CardLinkDto[];
  /** Channels listing the card as an active funding source. */
  channels: ChannelSummary[];
  /** Channel-source records of the card by status (ended ones too) — what a DELETE removes with it (M2-B3). */
  channelSourceCounts: { active: number; ended: number };
}

/** POST /cards with createStoredValueAccount. */
export interface CardCreateResult {
  card: CardDto;
  account?: AccountDto;
  link?: CardLinkDto;
}

// ------------------------------------------------------------------ links

export interface CardLinkDto {
  id: string;
  cardId: string;
  accountId: string;
  /** null = every currency of the account. */
  currency: string | null;
  role: CardLinkRole;
  isDefault: boolean;
  priority: number | null;
  status: CardLinkStatus;
  startedOn: string | null;
  endedOn: string | null;
  notes: string | null;
  card: CardSummary;
  account: AccountSummary;
  createdAt: number;
  updatedAt: number;
}

// ------------------------------------------------------------------ payment channels

export interface ChannelSourceDto {
  id: string;
  channelId: string;
  cardId: string | null;
  accountId: string | null;
  card: CardSummary | null;
  account: AccountSummary | null;
  isDefault: boolean;
  status: ChannelSourceStatus;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentChannelDto {
  id: string;
  name: string;
  channelType: ChannelType;
  providerInstitutionId: string | null;
  provider: InstitutionSummary | null;
  balanceAccountId: string | null;
  balanceAccount: AccountSummary | null;
  region: string | null;
  status: ChannelStatus;
  notes: string | null;
  sort: number;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentChannelListItem extends PaymentChannelDto {
  sourceCount: number;
}

export interface PaymentChannelDetail extends PaymentChannelDto {
  /** Every source, ended ones included. */
  sources: ChannelSourceDto[];
}

// ------------------------------------------------------------------ spending-source recommendation (DATA_MODEL §5)

/**
 * One (not ended) link of the card as the recommendation saw it (M2-B4 addition, for explaining the
 * result; the spec fields of the result are unchanged). Ended links are history and never considered.
 */
export interface SpendingSourceCandidate {
  linkId: string;
  account: AccountSummary;
  /** The link's currency scope (null = every currency of the account). */
  currency: string | null;
  role: CardLinkRole;
  status: CardLinkStatus;
  isDefault: boolean;
  priority: number | null;
  /** Active currencies the link can fund from (account default first, then by sort); [] when none. */
  scope: string[];
  /** null = eligible; otherwise the first rule it failed. */
  skipped: SpendingSkipReason | null;
  /** Eligible and its scope holds the event currency. */
  exact: boolean;
}

interface SpendingSourceExplained {
  /**
   * Decision order: eligible links holding the event currency (ranked), then the other eligible
   * links (ranked), then the ineligible ones (ranked). When a source is recommended it is
   * considered[0]. Rank: default first, currency-specific before all-currency, priority ascending
   * (none last), then oldest. Empty when the card itself is not active.
   */
  considered: SpendingSourceCandidate[];
}

export interface SpendingSourceExact extends SpendingSourceExplained {
  match: 'exact_currency';
  eventCurrency: string;
  accountId: string;
  linkId: string;
  /** Always equal to eventCurrency. */
  fundingCurrency: string;
}

export interface SpendingSourceConversion extends SpendingSourceExplained {
  match: 'conversion_required';
  eventCurrency: string;
  accountId: string;
  linkId: string;
  /** Always null: the user picks the funding currency from the real transaction record. */
  fundingCurrency: null;
  /** Active currencies of the source, account default first — candidates only. */
  candidateCurrencies: string[];
}

export interface SpendingSourceNoMatch extends SpendingSourceExplained {
  match: 'no_match';
  eventCurrency: string;
  reason: NoMatchReason;
}

export type SpendingSourceResult = SpendingSourceExact | SpendingSourceConversion | SpendingSourceNoMatch;

/** details of a 409 LINK_STATE: the link's current status does not allow the operation (M2-B4). */
export interface LinkStateDetails {
  status: CardLinkStatus;
}

/**
 * details of PATCH /payment-channels/:id → 400 CHANNEL_SOURCE_KIND when the channel would become a
 * device wallet but has account sources (M2-B5). Ended ones count: they are kept history, never
 * deleted to allow the change — a new device-wallet channel is created instead.
 */
export interface ChannelTypeChangeDetails {
  accountSources: number;
  activeAccountSources: number;
  endedAccountSources: number;
}

/** details of a 409 DUPLICATE: the existing record (an institution, or the unfinished link with the same card, account, scope and role). */
export interface DuplicateDetails {
  existingId: string;
}

// ================================================================== M3 transactions (API_SPEC §5.2)
//
// Transaction DTOs carry transaction amounts (K4) — minor-unit integers ≤ 999 999 999 999 999,
// exact as JSON numbers — and never a balance, exchange rate, fee or converted amount. Sums are
// decimal strings (money.ts). Field mapping: accountId ↔ funding_account_id, currency ↔
// funding_currency, fundingAccountCountry ↔ funding_account_country (for an `in` entry: the
// receiving account and currency, DATA_MODEL §10.4); everything else is the column in camelCase.

export interface CounterpartyFacts {
  kind: CounterpartyKind;
  name: string | null;
  country: string | null;
  institution: string | null;
  accountHint: string | null;
}

/** One saved version of a transaction (an immutable transaction_events row). */
export interface EventFacts {
  eventId: string;
  revision: number;
  revisionKind: RevisionKind;
  correctionReason: string | null;
  recordMode: RecordMode;
  occurredOn: string;
  occurredTime: string | null;
  postedOn: string | null;
  eventCurrency: string | null;
  eventAmount: number | null;
  eventCurrencyExponent: number | null;
  merchantName: string | null;
  merchantCountry: string | null;
  cardId: string | null;
  paymentChannelId: string | null;
  transferMethod: TransferMethod | null;
  /** Always an object for transfers (kind from the type), null for spend / refund. */
  counterparty: CounterpartyFacts | null;
  homeRegion: string;
  homeRegionSource: HomeRegionSource;
  merchantScope: MerchantScope | null;
  transferScope: TransferScope | null;
  foreignStatus: ForeignStatus;
  classifierVersion: number;
  createdAt: number;
}

/** One immutable transaction_entries row. */
export interface EntryFacts {
  entryId: string;
  direction: EntryDirection;
  accountId: string;
  currency: string;
  currencyExponent: number;
  amount: number | null;
  amountStatus: AmountStatus;
  /** Snapshot at save time (or carried / user-corrected) — not the account's current country. */
  fundingAccountCountry: string;
  countrySource: CountrySource;
  /** The currency's status when this entry was saved, not when the transaction happened. */
  currencyStatusAtSave: CurrencyStatusAtSave;
  closedCurrencyAck: boolean;
  carriedFromEntryId: string | null;
}

/**
 * Result of a create, correction or void: immutable data only, so the first response and every
 * replay are byte-for-byte equal. No notes, no current names, no currentRevision, no current
 * status, no warnings.
 */
export interface TransactionWriteResult {
  operation: IdempotentOperation;
  transactionId: string;
  txnType: TxnType;
  /** The version this operation produced or acted on (not the transaction's current revision). */
  revision: number;
  eventId: string;
  /** Decided by the operation: active for create / correct, voided for void. */
  statusAfter: TxnStatus;
  /** createdAt of that version's event; voidedAt for a void. */
  recordedAt: number;
  event: EventFacts;
  entries: EntryFacts[];
  void: { voidedAt: number; reason: string | null } | null;
}

export interface TransactionEntryDto extends EntryFacts {
  /** Current summary of the account (its name may have changed since). */
  account: AccountSummary;
}

export interface TransactionRevisionSummary {
  revision: number;
  revisionKind: RevisionKind;
  correctionReason: string | null;
  createdAt: number;
}

/** GET /transactions/:id: the current version plus mutable data (notes, status) and current names. */
export interface TransactionDto {
  id: string;
  txnType: TxnType;
  status: TxnStatus;
  currentRevision: number;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
  voidedAt: number | null;
  voidReason: string | null;
  event: EventFacts;
  entries: TransactionEntryDto[];
  card: CardSummary | null;
  paymentChannel: { id: string; name: string; channelType: ChannelType; status: ChannelStatus } | null;
  revisions: TransactionRevisionSummary[];
}

export type TransactionListItem = Omit<TransactionDto, 'revisions'>;

export interface TransactionListDto {
  items: TransactionListItem[];
  nextCursor: string | null;
}

/** GET /transactions/:id/revisions/:revision */
export interface TransactionRevisionDto {
  transactionId: string;
  txnType: TxnType;
  revision: number;
  event: EventFacts;
  entries: TransactionEntryDto[];
}

/** PATCH /transactions/:id/notes */
export interface TransactionNotesDto {
  id: string;
  notes: string | null;
  updatedAt: number;
}

export interface SummaryGroup {
  txnType: TxnType;
  direction: EntryDirection;
  currency: string;
  currencyExponent: number;
  merchantScope: MerchantScope | null;
  transferScope: TransferScope | null;
  /** From the entry's jurisdiction snapshot and the transaction's home_region snapshot. */
  accountScope: 'foreign' | 'domestic';
  /** Exact minor-unit decimal string (may exceed 2^53). */
  amount: string;
  count: number;
}

/** GET /transactions/summary: per original currency, never summed across currencies or exponents. */
export interface TransactionSummaryDto {
  from: string | null;
  to: string | null;
  /** Home regions saved in the period's transactions (more than one: the UI points it out). */
  homeRegions: string[];
  foreign: SummaryGroup[];
  undetermined: SummaryGroup[];
  /** Always empty under P2 (confirmed domestic versions are never published). */
  domestic: SummaryGroup[];
  pending: { foreignStatus: ForeignStatus; txnType: TxnType; direction: EntryDirection; currency: string; currencyExponent: number; count: number }[];
}

/** details of a 409 IDEMPOTENCY_CONFLICT (only the caller's own data). */
export interface IdempotencyConflictDetails {
  operation: IdempotentOperation;
  transactionId: string;
}

/** details of a 400 ENTRY_SHAPE: the first Entry-shape rule the request breaks (transactionShapeProblem). */
export interface EntryShapeDetails {
  rule: EntryShapeRule;
}

/**
 * details of a transaction API 400 CURRENCY_NOT_ON_ACCOUNT: the entry's currency is not registered
 * on its account (status null), or is closed in a current (not backfill) transaction.
 */
export interface EntryCurrencyDetails {
  direction: EntryDirection;
  currency: string;
  status: AccountCurrencyStatus | null;
}

/** details of a 400 CLOSED_CURRENCY_ACK_REQUIRED: the backfill entry that uses a closed currency unacknowledged. */
export interface ClosedCurrencyAckDetails {
  direction: EntryDirection;
}

/** details of a 409 REVISION_CONFLICT. */
export interface RevisionConflictDetails {
  currentRevision: number;
}
