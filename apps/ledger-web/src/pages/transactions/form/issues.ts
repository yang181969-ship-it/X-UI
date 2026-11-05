import { useTranslation } from 'react-i18next';
import type { DraftIssue } from '../../../lib/txnDraft.ts';

/** Issues by field, and the translated text of one (an ENTRY_SHAPE rule names the rule broken). */
export function useIssueText() {
  const { t } = useTranslation();
  return (i: DraftIssue): string => {
    if (i.code === 'shape') return t(`transactions.form.shapeRules.${i.detail ?? 'unknown'}`, { defaultValue: t('errors.codes.ENTRY_SHAPE') });
    if (i.code === 'invalid' && i.detail) return `${t('transactions.form.issues.invalid')}（${i.detail}）`;
    return t(`transactions.form.issues.${i.code}`);
  };
}

export type IssueMap = Map<string, DraftIssue[]>;

export function issueMap(issues: readonly DraftIssue[]): IssueMap {
  const m: IssueMap = new Map();
  for (const i of issues) m.set(i.field, [...(m.get(i.field) ?? []), i]);
  return m;
}

/** Form.Item props for a field: error status and the messages. */
export function useFieldStatus(issues: IssueMap) {
  const text = useIssueText();
  return (field: string) => {
    const list = issues.get(field);
    return list?.length ? { validateStatus: 'error' as const, help: list.map(text).join('；') } : {};
  };
}
