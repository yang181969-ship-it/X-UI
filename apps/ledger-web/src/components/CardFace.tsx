import type { CardDto, CardNetwork, InstitutionSummary } from '@xui/ledger-shared';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { colorFor } from '../lib/format.ts';

type FaceCard = Pick<CardDto, 'name' | 'network' | 'cardType' | 'form' | 'last4' | 'expiresOn' | 'status'> & { issuer: Pick<InstitutionSummary, 'name' | 'color'> };

/** Plain-text network names (no network logos or artwork are reproduced). */
const NETWORK_MARK: Record<CardNetwork, string> = {
  visa: 'VISA',
  mastercard: 'Mastercard',
  amex: 'AMEX',
  unionpay: 'UnionPay',
  jcb: 'JCB',
  discover: 'Discover',
  diners: 'Diners Club',
  maestro: 'Maestro',
  other: '',
};

/** Relative luminance of #rrggbb (WCAG), to pick readable text on the card colour. */
function luminance(hex: string): number {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

/**
 * A card face drawn in CSS from safe metadata only: issuer name and colour, card name, type,
 * network name, form, the last four digits ("•••• 1234" — never a full-number layout) and the
 * expiry month. The colour is the issuer's avatar colour (cards have no colour of their own).
 */
export function CardFace({ card, size = 'md' }: { card: FaceCard; size?: 'sm' | 'md' | 'lg' }) {
  const { t } = useTranslation();
  const base = card.issuer.color ?? colorFor(card.issuer.name);
  const expiry = card.expiresOn ? `${card.expiresOn.slice(5, 7)}/${card.expiresOn.slice(2, 4)}` : null;
  const classes = ['card-face', `size-${size}`, `is-${card.status}`, card.form === 'virtual' && 'is-virtual', luminance(base) > 0.45 && 'is-light'].filter(Boolean).join(' ');
  return (
    <div className={classes} style={{ '--face': base } as CSSProperties} role="img" aria-label={`${card.name} · ${card.issuer.name} · •••• ${card.last4}`}>
      <div className="card-face-top">
        <span className="card-face-issuer">{card.issuer.name}</span>
        <span className="card-face-type">{t(`cards.types.${card.cardType}`)}</span>
      </div>
      <div className="card-face-mid">{card.form === 'physical' ? <span className="card-face-chip" aria-hidden /> : <span className="card-face-virtual">{t('cards.face.virtual')}</span>}</div>
      <div className="card-face-name">{card.name}</div>
      <div className="card-face-bottom">
        <span className="card-face-number">•••• {card.last4}</span>
        {expiry && <span className="card-face-expiry">{expiry}</span>}
        <span className="card-face-network">{NETWORK_MARK[card.network]}</span>
      </div>
      {card.status !== 'active' && <span className="card-face-status">{t(`cards.statuses.${card.status}`)}</span>}
    </div>
  );
}
