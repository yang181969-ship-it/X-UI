import { EditOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Input, Space, Typography } from 'antd';
import { NOTES_MAX, type TransactionDto } from '@xui/ledger-shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '../../api/hooks.ts';
import { useUpdateNotes } from '../../api/transactions.ts';

/**
 * Notes (API_SPEC §5.9, P9): the user's remark, not a transaction fact — PATCH without an
 * Idempotency-Key, no version, allowed on voided transactions, last write wins, no history.
 * "Save" sends the text exactly as typed (an empty box is saved as ""), "Clear" sends null. On a
 * failure the editor stays open with the typed text.
 */
export function NotesEditor({ txn }: { txn: TransactionDto }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const mutation = useUpdateNotes(txn.id);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (notes: string | null) => {
    setError(null);
    try {
      await mutation.mutateAsync(notes);
      setEditing(false);
      void message.success(t(notes === null ? 'transactions.detail.notesCleared' : 'transactions.detail.notesSaved'));
    } catch (e) {
      setError(errorText(e, t));
    }
  };

  return (
    <Card
      title={t('transactions.detail.notes')}
      className="txn-notes"
      extra={
        !editing && (
          <Space size={4}>
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setText(txn.notes ?? '');
                setError(null);
                setEditing(true);
              }}
            >
              {t('transactions.detail.editNotes')}
            </Button>
            {txn.notes !== null && (
              <Button size="small" onClick={() => void submit(null)} loading={mutation.isPending}>
                {t('transactions.detail.clearNotes')}
              </Button>
            )}
          </Space>
        )
      }
    >
      <Typography.Paragraph type="secondary" className="field-note">
        {t('transactions.detail.notesHint')}
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon title={error} className="form-alert" />}
      {editing ? (
        <div className="txn-notes-edit">
          <Input.TextArea aria-label={t('transactions.detail.notes')} value={text} onChange={(e) => setText(e.target.value)} maxLength={NOTES_MAX} showCount autoSize={{ minRows: 3, maxRows: 10 }} autoFocus />
          <Space className="txn-notes-actions">
            <Button onClick={() => setEditing(false)} disabled={mutation.isPending}>
              {t('transactions.detail.cancel')}
            </Button>
            <Button type="primary" onClick={() => void submit(text)} loading={mutation.isPending}>
              {t('common.save')}
            </Button>
          </Space>
        </div>
      ) : (
        <div className="txn-notes-text pre-wrap" data-notes={txn.notes === null ? 'null' : txn.notes === '' ? 'blank' : 'text'}>
          {txn.notes === null ? <span className="muted">{t('transactions.detail.notesEmpty')}</span> : txn.notes === '' ? <span className="muted">{t('transactions.detail.notesBlank')}</span> : txn.notes}
        </div>
      )}
    </Card>
  );
}
