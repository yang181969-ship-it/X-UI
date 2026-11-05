import { Alert, Card, Select, Skeleton, Space, Tag, Typography } from 'antd';
import type { CardDetail, SpendingSourceCandidate, SpendingSourceResult } from '@xui/ledger-shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useSpendingSource } from '../../api/cardLinks.ts';
import { errorText } from '../../api/hooks.ts';
import { currencyOptions } from '../../lib/currencies.ts';

/**
 * Which account a purchase in a given (event) currency would be pre-filled with, and why
 * (GET /cards/:id/spending-source, DATA_MODEL §5). A preview only: it is not how the payment
 * provider really charges, nothing is paid, converted or saved, and no rate or amount is shown.
 * Only an exact currency match names a funding currency; otherwise the user picks it from the real
 * transaction record (M3).
 */
export function SpendingSourcePreview({ card }: { card: CardDetail }) {
  const { t, i18n } = useTranslation();
  const [currency, setCurrency] = useState('USD');
  const options = useMemo(() => currencyOptions(i18n.language), [i18n.language]);
  const { data, isLoading, isError, error } = useSpendingSource(card.id, currency);
  const result = data?.eventCurrency === currency ? data : undefined;

  return (
    <Card title={t('links.preview.title')} className="spending-preview">
      <Typography.Paragraph type="secondary" className="field-note">
        {t('links.preview.intro')}
      </Typography.Paragraph>
      <label className="spending-preview-currency">
        {t('links.preview.currency')}
        <Select aria-label={t('links.preview.currency')} value={currency} onChange={setCurrency} showSearch={{ optionFilterProp: 'label' }} options={options} style={{ width: 240 }} />
      </label>
      {isLoading && <Skeleton active paragraph={{ rows: 2 }} />}
      {isError && <Alert type="error" showIcon title={errorText(error, t)} />}
      {result && <SpendingSourceExplain result={result} />}
      <Typography.Paragraph type="secondary" className="field-note">
        {t('links.preview.rule')}
      </Typography.Paragraph>
    </Card>
  );
}

/** The result and the links it considered (also shown in the transaction form, M3-B4-C). */
export function SpendingSourceExplain({ result: r }: { result: SpendingSourceResult }) {
  const { t } = useTranslation();
  const chosen = r.match === 'no_match' ? undefined : r.considered.find((c) => c.linkId === r.linkId);
  const name = chosen?.account.name ?? '';
  return (
    <div className="spending-result" data-match={r.match}>
      {r.match === 'exact_currency' && <Alert type="success" showIcon title={t('links.preview.exact', { account: name, currency: r.fundingCurrency })} description={t('links.preview.exactHint')} />}
      {r.match === 'conversion_required' && (
        <Alert
          type="warning"
          showIcon
          title={t('links.preview.conversion', { account: name, currency: r.eventCurrency })}
          description={
            <>
              <div>{t('links.preview.conversionHint')}</div>
              <Space size={4} wrap className="spending-candidates">
                {t('links.preview.candidates')}
                {r.candidateCurrencies.map((c) => (
                  <Tag key={c}>{c}</Tag>
                ))}
              </Space>
            </>
          }
        />
      )}
      {r.match === 'no_match' && <Alert type="info" showIcon title={t(`links.preview.noMatch.${r.reason}`, { currency: r.eventCurrency })} />}
      {r.considered.length > 0 && (
        <section className="ref-section spending-considered">
          <Typography.Title level={5}>{t('links.preview.considered')}</Typography.Title>
          <ol>
            {r.considered.map((c) => (
              <Candidate key={c.linkId} c={c} chosen={c.linkId === chosen?.linkId} />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function Candidate({ c, chosen }: { c: SpendingSourceCandidate; chosen: boolean }) {
  const { t } = useTranslation();
  const verdict = chosen ? (
    <Tag color="blue">{t('links.preview.chosen')}</Tag>
  ) : c.skipped ? (
    <Tag>{t(`links.preview.skipped.${c.skipped}`)}</Tag>
  ) : (
    <Tag color={c.exact ? 'green' : 'gold'}>{t(c.exact ? 'links.preview.alsoExact' : 'links.preview.alsoConversion')}</Tag>
  );
  return (
    <li className={`spending-candidate ${c.skipped ? 'is-closed' : ''}`} data-link={c.linkId} data-skipped={c.skipped ?? ''}>
      <Link to={`/accounts/${encodeURIComponent(c.account.id)}`}>{c.account.name}</Link>
      <span className="muted">
        {' · '}
        {t(`accounts.roles.${c.role}`)} · {c.currency ?? t('accounts.scopeAll')}
        {c.priority !== null && ` · ${t('links.priorityValue', { n: c.priority })}`}
        {c.scope.length > 0 && ` · ${t('links.preview.scope', { list: c.scope.join(', ') })}`}
      </span>{' '}
      {c.isDefault && <Tag color="blue">{t('accounts.defaultSource')}</Tag>}
      {verdict}
    </li>
  );
}
