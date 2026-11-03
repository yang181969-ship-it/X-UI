import { Alert, App, Form, Modal, Typography } from 'antd';
import type { AccountDto, CurrencyCode, CurrencyInUseDetails } from '@xui/ledger-shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { replaceCurrencies, useRefreshAccounts } from '../../api/accounts.ts';
import { ApiError } from '../../api/client.ts';
import { errorText } from '../../api/hooks.ts';
import { CurrencyListEditor, currencyListProblem, toInput, type CurrencyItem } from './CurrencyListEditor.tsx';

/**
 * Replace an account's currency list (PUT /accounts/:id/currencies). A currency still used by a
 * card link can't be removed — the server answers 409 CURRENCY_IN_USE and the dialog explains
 * that closing it keeps the link and its history.
 */
export function CurrencyModal({ account, open, onClose }: { account: AccountDto; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const refresh = useRefreshAccounts();
  const [form] = Form.useForm<{ currencies: CurrencyItem[] }>();
  const [busy, setBusy] = useState(false);
  const [inUse, setInUse] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setInUse([]);
    form.setFieldsValue({ currencies: account.currencies.map((c) => ({ code: c.currency as CurrencyCode, isDefault: c.isDefault, status: c.status })) });
  }, [open, account, form]);

  const submit = async () => {
    let v: { currencies: CurrencyItem[] };
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    setInUse([]);
    try {
      await replaceCurrencies(account.id, toInput(v.currencies));
      await refresh();
      void message.success(t('common.saved'));
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CURRENCY_IN_USE') setInUse((e.details as CurrencyInUseDetails | undefined)?.currencies ?? []);
      else void message.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('accounts.currency.manageTitle', { name: account.name })}
      onCancel={onClose}
      onOk={submit}
      okText={t('common.save')}
      confirmLoading={busy}
      forceRender
      width={600}
    >
      {inUse.length > 0 && <Alert className="form-alert" type="warning" showIcon title={t('accounts.currency.inUse', { codes: inUse.join(', ') })} />}
      <Typography.Paragraph type="secondary">{t('accounts.currency.closedHint')}</Typography.Paragraph>
      <Form form={form} name="account_currencies" layout="vertical">
        <Form.Item
          name="currencies"
          extra={t('accounts.currenciesHint')}
          rules={[{ validator: async (_: unknown, v?: CurrencyItem[]) => (currencyListProblem(v, t) ? Promise.reject(new Error(currencyListProblem(v, t)!)) : undefined) }]}
        >
          <CurrencyListEditor />
        </Form.Item>
      </Form>
    </Modal>
  );
}
