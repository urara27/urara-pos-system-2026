import { useState, type FormEvent } from 'react';
import { NUMBERING_MODE_LABELS, NUMBERING_MODES, type Register } from '@pos/shared';
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
} from './common';

type RegisterForm = Omit<Register, 'id'>;

export function RegistersPage() {
  const { items, error, reload } = useAdminList<Register>('/api/admin/registers', 'registers');
  const [editing, setEditing] = useState<{ id: number | null; form: RegisterForm } | null>(null);
  const nextNumber = Math.max(0, ...items.map((r) => r.number)) + 1;

  return (
    <>
      <PageHeader title="レジ">
        <button
          className="btn btn--primary"
          onClick={() =>
            setEditing({ id: null, form: { number: nextNumber, name: `レジ${nextNumber}`, numberingMode: 'auto', enabled: true } })
          }
        >
          ＋ レジを追加
        </button>
      </PageHeader>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <p className="muted small">
          レジ番号はレシート番号に使われます。注文番号の発行モード（番号札／自動採番）はレジごとに設定します。番号の範囲は「店舗・運用設定」で変更できます。
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>レジ番号</th>
                <th>名称</th>
                <th>注文番号の発行</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className={r.enabled ? '' : 'is-disabled'}>
                  <td>{r.number}</td>
                  <td>{r.name}</td>
                  <td>{NUMBERING_MODE_LABELS[r.numberingMode]}</td>
                  <td>
                    <StatusPill enabled={r.enabled} />
                  </td>
                  <td>
                    <button className="btn btn--small" onClick={() => setEditing({ id: r.id, form: { ...r } })}>
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
        <RegisterEditor
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

function RegisterEditor({
  id,
  initial,
  onClose,
  onSaved,
}: {
  id: number | null;
  initial: RegisterForm;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(initial);
  const { busy, error, save } = useSave(onSaved);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(() =>
      adminApi(id ? `/api/admin/registers/${id}` : '/api/admin/registers', { method: id ? 'PUT' : 'POST', body: form }),
    );
  };
  return (
    <Modal title={id ? 'レジを編集' : 'レジを追加'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <IntInput label="レジ番号" min={1} max={99} value={form.number} onChange={(v) => setForm({ ...form, number: v ?? 1 })} />
        <TextInput label="名称" value={form.name} maxLength={30} required onChange={(name) => setForm({ ...form, name })} />
        <Select
          label="注文番号の発行モード"
          value={form.numberingMode}
          options={NUMBERING_MODES.map((m) => ({ value: m, label: NUMBERING_MODE_LABELS[m] }))}
          onChange={(numberingMode) => setForm({ ...form, numberingMode })}
        />
        <Checkbox label="有効" checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} />
        <FormActions busy={busy} error={error} onCancel={onClose} />
      </form>
    </Modal>
  );
}
