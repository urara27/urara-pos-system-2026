import { useState, type FormEvent } from 'react';
import type { Category, CategoryInput } from '@pos/shared';
import {
  adminApi,
  Checkbox,
  FormActions,
  IntInput,
  Modal,
  PageHeader,
  StatusPill,
  TextInput,
  useAdminList,
  useSave,
} from './common';

const EMPTY: Required<CategoryInput> = { name: '', sortOrder: 0, enabled: true };

export function CategoriesPage() {
  const { items, error, reload } = useAdminList<Category>('/api/admin/categories', 'categories');
  const [editing, setEditing] = useState<{ id: number | null; form: Required<CategoryInput> } | null>(null);

  return (
    <>
      <PageHeader title="カテゴリ">
        <button
          className="btn btn--primary"
          onClick={() => setEditing({ id: null, form: { ...EMPTY, sortOrder: items.length + 1 } })}
        >
          ＋ カテゴリを追加
        </button>
      </PageHeader>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <p className="muted small">レジのタブに表示順で並びます。不要になったカテゴリは削除せず「無効」にします。</p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>表示順</th>
                <th>名称</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className={c.enabled ? '' : 'is-disabled'}>
                  <td>{c.sortOrder}</td>
                  <td>{c.name}</td>
                  <td>
                    <StatusPill enabled={c.enabled} />
                  </td>
                  <td>
                    <button className="btn btn--small" onClick={() => setEditing({ id: c.id, form: { ...c } })}>
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
        <CategoryEditor
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

function CategoryEditor({
  id,
  initial,
  onClose,
  onSaved,
}: {
  id: number | null;
  initial: Required<CategoryInput>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(initial);
  const { busy, error, save } = useSave(onSaved);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(() =>
      adminApi(id ? `/api/admin/categories/${id}` : '/api/admin/categories', { method: id ? 'PUT' : 'POST', body: form }),
    );
  };
  return (
    <Modal title={id ? 'カテゴリを編集' : 'カテゴリを追加'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <TextInput label="名称" value={form.name} maxLength={30} required onChange={(name) => setForm({ ...form, name })} />
        <IntInput label="表示順" value={form.sortOrder} min={0} onChange={(v) => setForm({ ...form, sortOrder: v ?? 0 })} />
        <Checkbox label="有効" checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} />
        <FormActions busy={busy} error={error} onCancel={onClose} />
      </form>
    </Modal>
  );
}
