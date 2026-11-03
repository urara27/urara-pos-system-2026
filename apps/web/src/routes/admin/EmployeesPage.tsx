import { useState, type FormEvent } from 'react';
import { EMPLOYEE_ROLE_LABELS, EMPLOYEE_ROLES, type Employee, type EmployeeRole } from '@pos/shared';
import {
  adminApi,
  Checkbox,
  FormActions,
  Modal,
  PageHeader,
  Select,
  StatusPill,
  TextInput,
  useAdminList,
  useSave,
} from './common';

interface EmployeeForm {
  code: string;
  name: string;
  role: EmployeeRole;
  canManualDiscount: boolean;
  enabled: boolean;
  pin: string;
  password: string;
}

export function EmployeesPage() {
  const { items, error, reload } = useAdminList<Employee>('/api/admin/employees', 'employees');
  const [editing, setEditing] = useState<{ target: Employee | null; form: EmployeeForm } | null>(null);

  return (
    <>
      <PageHeader title="従業員">
        <button
          className="btn btn--primary"
          onClick={() =>
            setEditing({
              target: null,
              form: { code: '', name: '', role: 'staff', canManualDiscount: false, enabled: true, pin: '', password: '' },
            })
          }
        >
          ＋ 従業員を追加
        </button>
      </PageHeader>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <p className="muted small">
          レジには従業員コードと PIN でログインします。返金などには「責任者」以上の PIN が必要です。管理画面に入れるのは「管理者」だけで、パスワードを使います。
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>コード</th>
                <th>氏名</th>
                <th>権限</th>
                <th>手入力値引き</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} className={e.enabled ? '' : 'is-disabled'}>
                  <td>{e.code}</td>
                  <td>{e.name}</td>
                  <td>{EMPLOYEE_ROLE_LABELS[e.role]}</td>
                  <td>{e.canManualDiscount ? '可' : '不可'}</td>
                  <td>
                    <StatusPill enabled={e.enabled} />
                  </td>
                  <td>
                    <button
                      className="btn btn--small"
                      onClick={() => setEditing({ target: e, form: { ...e, pin: '', password: '' } })}
                    >
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
        <EmployeeEditor
          target={editing.target}
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

function EmployeeEditor({
  target,
  initial,
  onClose,
  onSaved,
}: {
  target: Employee | null;
  initial: EmployeeForm;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(initial);
  const { busy, error, save } = useSave(onSaved);
  const set = <K extends keyof EmployeeForm>(key: K, value: EmployeeForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const isNew = target === null;
  const needsPassword = form.role === 'admin' && (isNew || !target.hasPassword);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(() =>
      adminApi(isNew ? '/api/admin/employees' : `/api/admin/employees/${target.id}`, {
        method: isNew ? 'POST' : 'PUT',
        body: form,
      }),
    );
  };

  return (
    <Modal title={isNew ? '従業員を追加' : '従業員を編集'} onClose={onClose}>
      <form className="form form--grid" onSubmit={submit}>
        <TextInput
          label="従業員コード"
          inputMode="numeric"
          pattern="\d{1,8}"
          value={form.code}
          required
          onChange={(v) => set('code', v.replace(/\D/g, ''))}
        />
        <TextInput label="氏名" value={form.name} maxLength={30} required onChange={(v) => set('name', v)} />
        <Select
          label="権限"
          value={form.role}
          options={EMPLOYEE_ROLES.map((r) => ({ value: r, label: EMPLOYEE_ROLE_LABELS[r] }))}
          onChange={(v) => set('role', v)}
        />
        <TextInput
          label={isNew ? 'PIN（4〜8桁）' : 'PIN（変更する場合のみ）'}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          pattern="\d{4,8}"
          required={isNew}
          value={form.pin}
          onChange={(v) => set('pin', v.replace(/\D/g, ''))}
        />
        {form.role === 'admin' && (
          <TextInput
            label={needsPassword ? '管理画面のパスワード（8文字以上）' : '管理画面のパスワード（変更する場合のみ）'}
            type="password"
            autoComplete="new-password"
            minLength={8}
            required={needsPassword}
            value={form.password}
            onChange={(v) => set('password', v)}
          />
        )}
        <div className="field">
          <span>設定</span>
          <Checkbox label="手入力の値引きを許可" checked={form.canManualDiscount} onChange={(v) => set('canManualDiscount', v)} />
          <Checkbox label="有効" checked={form.enabled} onChange={(v) => set('enabled', v)} />
        </div>
        <div className="form--full">
          <FormActions busy={busy} error={error} onCancel={onClose} />
        </div>
      </form>
    </Modal>
  );
}
