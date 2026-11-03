import type {
  AccountCurrencyStatus,
  AccountStatus,
  AccountType,
  CardForm,
  CardLinkRole,
  CardLinkStatus,
  CardNetwork,
  CardStatus,
  CardType,
  ChannelSourceStatus,
  ChannelStatus,
  ChannelType,
  DepositKind,
  InstitutionStatus,
  InstitutionType,
  LedgerErrorCode,
  NoMatchReason,
  SpendingSkipReason,
} from './enums.ts';

/**
 * Response shapes of the M2 API (API_SPEC §3). camelCase; dates YYYY-MM-DD, expiry YYYY-MM,
 * timestamps epoch milliseconds. No DTO carries an amount or a balance — X-UI v1 has neither
 * in M2 — and no card DTO carries a card number, BIN, CVV, PIN or holder name.
 */

export interface ErrorBody {
  error: string;
  code: LedgerErrorCode | (string & {});
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

/** details of DELETE /accounts/:id → 409 IN_USE: the channels using the account as their balance account. */
export interface AccountInUseDetails {
  references: { balanceOfChannels: number };
  channels: ChannelSummary[];
}

/** details of PUT /accounts/:id/currencies → 409 CURRENCY_IN_USE: removed currencies that are still referenced. */
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

/** details of a 409 DUPLICATE: the existing record (an institution, or the unfinished link with the same card, account, scope and role). */
export interface DuplicateDetails {
  existingId: string;
}
