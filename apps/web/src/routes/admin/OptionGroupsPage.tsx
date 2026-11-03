import { useState, type FormEvent } from 'react';
import {
  OPTION_SELECTION_LABELS,
  OPTION_SELECTIONS,
  type OptionGroup,
  type OptionSelection,
  type Station,
} from '@pos/shared';
import {
  adminApi,
  Checkbox,
  FormActions,
  IntInput,
  Modal,
  PageHeader,
  Select,
  StatusPill,
  TextInput,
  useAdminList,
  useSave,
  yen,
} from './common';

interface OptionRow {
  /** 保存済みの選択肢なら id。新規は undefined（削除できるのは新規のみ） */
  id?: number;
  key: string;
  name: string;
  kitchenName: string;
  priceDelta: number;
  isDefault: boolean;
  station: Station | null;
  sortOrder: number;
  soldOut: boolean;
  enabled: boolean;
}

interface GroupForm {
  name: string;
  selection: OptionSelection;
  sortOrder: number;
  enabled: boolean;
  options: OptionRow[];
}

let rowKey = 0;
const newOption = (sortOrder: number): OptionRow => ({
  key: `new-${++rowKey}`,
  name: '',
  kitchenName: '',
  priceDelta: 0,
  isDefault: false,
  station: null,
  sortOrder,
  soldOut: false,
  enabled: true,
});

const STATION_CHOICES = [
  { value: '', label: '商品と同じ' },
  { value: 'food', label: 'フード' },
  { value: 'drink', label: 'ドリンク' },
] as const;

export function OptionGroupsPage() {
  const { items, error, reload } = useAdminList<OptionGroup>('/api/admin/option-groups', 'optionGroups');
  const [editing, setEditing] = useState<{ id: number | null; form: GroupForm } | null>(null);

  const edit = (g: OptionGroup) =>
    setEditing({
      id: g.id,
      form: { ...g, options: g.options.map((o) => ({ ...o, key: `saved-${o.id}` })) },
    });

  return (
    <>
      <PageHeader title="オプション">
        <button
          className="btn btn--primary"
          onClick={() =>
            setEditing({
              id: null,
              form: { name: '', selection: 'single', sortOrder: items.length + 1, enabled: true, options: [newOption(1)] },
            })
          }
        >
          ＋ オプショングループを追加
        </button>
      </PageHeader>
      {error && <p className="error">{error}</p>}
      <p className="muted small">
        例: 「サイズ」（1つを必ず選ぶ）、「トッピング」（複数選べる）。セット商品のドリンク選択は、選択肢のステーションを「ドリンク」にするとドリンク側のキッチンに表示されます。
      </p>
      <div className="card-grid">
        {items.map((g) => (
          <section key={g.id} className={`card ${g.enabled ? '' : 'is-disabled'}`}>
            <div className="row row--between">
              <h2>{g.name}</h2>
              <StatusPill enabled={g.enabled} />
            </div>
            <p className="muted small">{OPTION_SELECTION_LABELS[g.selection]}</p>
            <ul className="option-list">
              {g.options.map((o) => (
                <li key={o.id} className={o.enabled ? '' : 'is-disabled'}>
                  <span>
                    {o.name}
                    {o.isDefault && <span className="pill pill--on">既定</span>}
                    {o.station && <span className="pill">{o.station === 'food' ? 'フード' : 'ドリンク'}</span>}
                    {o.soldOut && <span className="pill pill--off">売切</span>}
                  </span>
                  <span>+{yen(o.priceDelta)}</span>
                </li>
              ))}
            </ul>
            <button className="btn btn--small" onClick={() => edit(g)}>
              編集
            </button>
          </section>
        ))}
      </div>
      {editing && (
        <GroupEditor
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

function GroupEditor({
  id,
  initial,
  onClose,
  onSaved,
}: {
  id: number | null;
  initial: GroupForm;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(initial);
  const { busy, error, save } = useSave(onSaved);

  const setOption = (key: string, patch: Partial<OptionRow>) =>
    setForm((f) => ({
      ...f,
      options: f.options.map((o) => {
        if (o.key === key) return { ...o, ...patch };
        // 「1つを必ず選ぶ」では既定は1つだけ
        if (patch.isDefault && f.selection === 'single') return { ...o, isDefault: false };
        return o;
      }),
    }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = { ...form, options: form.options.map(({ key: _key, ...o }) => o) };
    void save(() =>
      adminApi(id ? `/api/admin/option-groups/${id}` : '/api/admin/option-groups', {
        method: id ? 'PUT' : 'POST',
        body,
      }),
    );
  };

  return (
    <Modal title={id ? 'オプショングループを編集' : 'オプショングループを追加'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form--grid">
          <TextInput label="グループ名" value={form.name} maxLength={30} required onChange={(name) => setForm({ ...form, name })} />
          <Select
            label="選び方"
            value={form.selection}
            options={OPTION_SELECTIONS.map((s) => ({ value: s, label: OPTION_SELECTION_LABELS[s] }))}
            onChange={(selection) => setForm({ ...form, selection })}
          />
          <IntInput label="表示順" min={0} value={form.sortOrder} onChange={(v) => setForm({ ...form, sortOrder: v ?? 0 })} />
          <Checkbox label="有効" checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} />
        </div>

        <h3>選択肢</h3>
        <div className="table-wrap">
          <table className="table table--form">
            <thead>
              <tr>
                <th>名称</th>
                <th>キッチン略称</th>
                <th>加算額</th>
                <th>ステーション</th>
                <th>表示順</th>
                <th>既定</th>
                <th>売切</th>
                <th>有効</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {form.options.map((o) => (
                <tr key={o.key}>
                  <td>
                    <input value={o.name} maxLength={30} required onChange={(e) => setOption(o.key, { name: e.target.value })} />
                  </td>
                  <td>
                    <input value={o.kitchenName} maxLength={30} onChange={(e) => setOption(o.key, { kitchenName: e.target.value })} />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="input-narrow"
                      value={o.priceDelta}
                      onChange={(e) => setOption(o.key, { priceDelta: Math.trunc(Number(e.target.value) || 0) })}
                    />
                  </td>
                  <td>
                    <select
                      value={o.station ?? ''}
                      onChange={(e) => setOption(o.key, { station: (e.target.value || null) as Station | null })}
                    >
                      {STATION_CHOICES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className="input-narrow"
                      value={o.sortOrder}
                      onChange={(e) => setOption(o.key, { sortOrder: Math.trunc(Number(e.target.value) || 0) })}
                    />
                  </td>
                  <td>
                    <input type="checkbox" checked={o.isDefault} onChange={(e) => setOption(o.key, { isDefault: e.target.checked })} />
                  </td>
                  <td>
                    <input type="checkbox" checked={o.soldOut} onChange={(e) => setOption(o.key, { soldOut: e.target.checked })} />
                  </td>
                  <td>
                    <input type="checkbox" checked={o.enabled} onChange={(e) => setOption(o.key, { enabled: e.target.checked })} />
                  </td>
                  <td>
                    {o.id === undefined && form.options.length > 1 && (
                      <button
                        type="button"
                        className="btn btn--small"
                        onClick={() => setForm((f) => ({ ...f, options: f.options.filter((x) => x.key !== o.key) }))}
                      >
                        削除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() => setForm((f) => ({ ...f, options: [...f.options, newOption(f.options.length + 1)] }))}
          >
            ＋ 選択肢を追加
          </button>
          <small className="muted">保存済みの選択肢は削除できません。不要なら「有効」を外してください。</small>
        </div>
        <FormActions busy={busy} error={error} onCancel={onClose} />
      </form>
    </Modal>
  );
}
