import { useState, type FormEvent } from 'react';
import {
  DISCOUNT_KIND_LABELS,
  DISCOUNT_KINDS,
  DISCOUNT_SCOPE_LABELS,
  DISCOUNT_SCOPES,
  isDiscountActive,
  type Discount,
} from '@pos/shared';
import {
  adminApi,
  Checkbox,
  Field,
  FormActions,
  fromLocalInput,
  IntInput,
  Modal,
  PageHeader,
  Select,
  StatusPill,
  TextInput,
  toLocalInput,
  useAdminList,
  useSave,
  yen,
} from './common';

type DiscountForm = Omit<Discount, 'id'>;

const formatValue = (d: Pick<Discount, 'kind' | 'value'>) => (d.kind === 'rate' ? `${d.value}%` : yen(d.value));
const formatPeriod = (d: Discount) => {
  if (d.validFrom === null && d.validTo === null) return '無期限';
  const f = (ms: number | null) => (ms === null ? '' : new Date(ms).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }));
  return `${f(d.validFrom)} 〜 ${f(d.validTo)}`;
};

export function DiscountsPage() {
  const { items, error, reload } = useAdminList<Discount>('/api/admin/discounts', 'discounts');
  const [editing, setEditing] = useState<{ id: number | null; form: DiscountForm } | null>(null);
  const now = Date.now();

  return (
    <>
      <PageHeader title="割引・クーポン">
        <button
          className="btn btn--primary"
          onClick={() =>
            setEditing({
              id: null,
              form: {
                name: '',
                kind: 'amount',
                value: 100,
                scope: 'order',
                validFrom: null,
                validTo: null,
                sortOrder: items.length + 1,
                enabled: true,
              },
            })
          }
        >
          ＋ 割引を追加
        </button>
      </PageHeader>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <p className="muted small">
          レジではここに登録した割引から選べます。手入力の値引きは、従業員ごとの「手入力値引き」の権限で許可します。
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>表示順</th>
                <th>名称</th>
                <th>値</th>
                <th>適用範囲</th>
                <th>有効期間</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className={isDiscountActive(d, now) ? '' : 'is-disabled'}>
                  <td>{d.sortOrder}</td>
                  <td>{d.name}</td>
                  <td>{formatValue(d)}</td>
                  <td>{DISCOUNT_SCOPE_LABELS[d.scope]}</td>
                  <td>{formatPeriod(d)}</td>
                  <td>
                    <StatusPill enabled={d.enabled} />
                  </td>
                  <td>
                    <button className="btn btn--small" onClick={() => setEditing({ id: d.id, form: { ...d } })}>
                      編集
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {editing && (
        <DiscountEditor
          id={editing.id}
          initial={editing.form}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function DiscountEditor({
  id,
  initial,
  onClose,
  onSaved,
}: {
  id: number | null;
  initial: DiscountForm;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(initial);
  const { busy, error, save } = useSave(onSaved);
  const set = <K extends keyof DiscountForm>(key: K, value: DiscountForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(() =>
      adminApi(id ? `/api/admin/discounts/${id}` : '/api/admin/discounts', { method: id ? 'PUT' : 'POST', body: form }),
    );
  };
  return (
    <Modal title={id ? '割引を編集' : '割引を追加'} onClose={onClose}>
      <form className="form form--grid" onSubmit={submit}>
        <TextInput label="名称" value={form.name} maxLength={30} required onChange={(v) => set('name', v)} />
        <Select
          label="適用範囲"
          value={form.scope}
          options={DISCOUNT_SCOPES.map((s) => ({ value: s, label: DISCOUNT_SCOPE_LABELS[s] }))}
          onChange={(v) => set('scope', v)}
        />
        <Select
          label="種類"
          value={form.kind}
          options={DISCOUNT_KINDS.map((k) => ({ value: k, label: DISCOUNT_KIND_LABELS[k] }))}
          onChange={(v) => set('kind', v)}
        />
        <IntInput
          label="値"
          min={1}
          max={form.kind === 'rate' ? 100 : undefined}
          suffix={form.kind === 'rate' ? '%' : '円'}
          value={form.value}
          onChange={(v) => set('value', v ?? 0)}
        />
        <Field label="有効期間の開始" hint="空欄なら制限なし">
          <input type="datetime-local" value={toLocalInput(form.validFrom)} onChange={(e) => set('validFrom', fromLocalInput(e.target.value))} />
        </Field>
        <Field label="有効期間の終了" hint="空欄なら制限なし">
          <input type="datetime-local" value={toLocalInput(form.validTo)} onChange={(e) => set('validTo', fromLocalInput(e.target.value))} />
        </Field>
        <IntInput label="表示順" min={0} value={form.sortOrder} onChange={(v) => set('sortOrder', v ?? 0)} />
        <Checkbox label="有効" checked={form.enabled} onChange={(v) => set('enabled', v)} />
        <div className="form--full">
          <FormActions busy={busy} error={error} onCancel={onClose} />
        </div>
      </form>
    </Modal>
  );
}
