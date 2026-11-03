import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  DEVICE_TOKEN_HEADER,
  STAFF_SESSION_HEADER,
  type Category,
  type OptionGroup,
  type Product,
  type Station,
} from '@pos/shared';
import { ApiError } from '../../lib/api';
import { keys, local, session } from '../../lib/storage';
import {
  adminApi,
  Checkbox,
  errorMessage,
  Field,
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

export const STATION_OPTIONS = [
  { value: 'food', label: 'フード' },
  { value: 'drink', label: 'ドリンク' },
] as const satisfies readonly { value: Station; label: string }[];
const stationLabel = (s: Station) => STATION_OPTIONS.find((o) => o.value === s)!.label;

type ProductForm = Omit<Product, 'id'>;

export function ProductsPage() {
  const products = useAdminList<Product>('/api/admin/products', 'products');
  const categories = useAdminList<Category>('/api/admin/categories', 'categories');
  const groups = useAdminList<OptionGroup>('/api/admin/option-groups', 'optionGroups');
  const [categoryFilter, setCategoryFilter] = useState<number | 'all'>('all');
  const [editing, setEditing] = useState<{ id: number | null; form: ProductForm } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const categoryName = useMemo(() => new Map(categories.items.map((c) => [c.id, c.name])), [categories.items]);
  const visible = products.items.filter((p) => categoryFilter === 'all' || p.categoryId === categoryFilter);

  const newProduct = (): ProductForm => ({
    name: '',
    kitchenName: '',
    priceEatIn: 0,
    priceTakeOut: null,
    reducedTaxEligible: true,
    categoryId: categoryFilter === 'all' ? (categories.items[0]?.id ?? 0) : categoryFilter,
    station: 'food',
    optionGroupIds: [],
    sortOrder: products.items.length + 1,
    buttonColor: '',
    soldOut: false,
    enabled: true,
  });

  const toggleSoldOut = async (p: Product) => {
    await adminApi(`/api/admin/products/${p.id}/sold-out`, { method: 'POST', body: { soldOut: !p.soldOut } }).catch(
      (err: unknown) => setMessage(errorMessage(err)),
    );
    products.reload();
  };

  return (
    <>
      <PageHeader title="商品">
        <ProductCsv onImported={(msg) => {
          setMessage(msg);
          products.reload();
        }} />
        <button
          className="btn btn--primary"
          disabled={categories.items.length === 0}
          onClick={() => setEditing({ id: null, form: newProduct() })}
        >
          ＋ 商品を追加
        </button>
      </PageHeader>
      {categories.items.length === 0 && !categories.loading && (
        <p className="notice">先に「カテゴリ」を登録してください。</p>
      )}
      {message && <p className="notice">{message}</p>}
      {products.error && <p className="error">{products.error}</p>}
      <section className="card">
        <div className="chips">
          <button className={categoryFilter === 'all' ? 'chip is-active' : 'chip'} onClick={() => setCategoryFilter('all')}>
            すべて
          </button>
          {categories.items.map((c) => (
            <button
              key={c.id}
              className={categoryFilter === c.id ? 'chip is-active' : 'chip'}
              onClick={() => setCategoryFilter(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>表示順</th>
                <th>商品名</th>
                <th>カテゴリ</th>
                <th className="num">価格（税込）</th>
                <th>税区分</th>
                <th>ステーション</th>
                <th>売切</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className={p.enabled ? '' : 'is-disabled'}>
                  <td>{p.sortOrder}</td>
                  <td>
                    {p.buttonColor && <span className="swatch" style={{ background: p.buttonColor }} />}
                    {p.name}
                    {p.kitchenName && <small className="muted">（{p.kitchenName}）</small>}
                  </td>
                  <td>{categoryName.get(p.categoryId) ?? '—'}</td>
                  <td className="num">
                    {yen(p.priceEatIn)}
                    {p.priceTakeOut !== null && <small className="muted"> / 持帰 {yen(p.priceTakeOut)}</small>}
                  </td>
                  <td>{p.reducedTaxEligible ? '軽減対象' : '対象外'}</td>
                  <td>{stationLabel(p.station)}</td>
                  <td>
                    <button className={`btn btn--small ${p.soldOut ? 'btn--danger' : ''}`} onClick={() => toggleSoldOut(p)}>
                      {p.soldOut ? '売切中' : '販売中'}
                    </button>
                  </td>
                  <td>
                    <StatusPill enabled={p.enabled} />
                  </td>
                  <td>
                    <button className="btn btn--small" onClick={() => setEditing({ id: p.id, form: { ...p } })}>
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
        <ProductEditor
          id={editing.id}
          initial={editing.form}
          categories={categories.items}
          groups={groups.items}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            products.reload();
          }}
        />
      )}
    </>
  );
}

function ProductEditor({
  id,
  initial,
  categories,
  groups,
  onClose,
  onSaved,
}: {
  id: number | null;
  initial: ProductForm;
  categories: Category[];
  groups: OptionGroup[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(initial);
  const { busy, error, save } = useSave(onSaved);
  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const toggleGroup = (groupId: number, on: boolean) =>
    set('optionGroupIds', on ? [...form.optionGroupIds, groupId] : form.optionGroupIds.filter((g) => g !== groupId));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(() =>
      adminApi(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PUT' : 'POST', body: form }),
    );
  };

  return (
    <Modal title={id ? '商品を編集' : '商品を追加'} onClose={onClose}>
      <form className="form form--grid" onSubmit={submit}>
        <TextInput label="商品名" value={form.name} maxLength={60} required onChange={(v) => set('name', v)} />
        <TextInput
          label="キッチン用の略称"
          hint="空欄なら商品名を表示"
          value={form.kitchenName}
          maxLength={30}
          onChange={(v) => set('kitchenName', v)}
        />
        <IntInput
          label="税込価格"
          suffix="円"
          min={0}
          value={form.priceEatIn}
          onChange={(v) => set('priceEatIn', v ?? 0)}
        />
        <div className="field">
          <span>持ち帰り価格</span>
          <Checkbox
            label="店内と別の価格にする"
            checked={form.priceTakeOut !== null}
            onChange={(on) => set('priceTakeOut', on ? form.priceEatIn : null)}
          />
          {form.priceTakeOut !== null && (
            <span className="input-suffix">
              <input
                type="number"
                min={0}
                step={1}
                value={form.priceTakeOut}
                onChange={(e) => set('priceTakeOut', Math.trunc(Number(e.target.value) || 0))}
              />
              <span>円</span>
            </span>
          )}
        </div>
        <Select
          label="カテゴリ"
          value={String(form.categoryId)}
          options={categories.map((c) => ({ value: String(c.id), label: c.enabled ? c.name : `${c.name}（無効）` }))}
          onChange={(v) => set('categoryId', Number(v))}
        />
        <Select label="ステーション" value={form.station} options={STATION_OPTIONS} onChange={(v) => set('station', v)} />
        <Field label="税区分" hint="飲食料品は軽減税率の対象（店内10% / 持ち帰り8%）。酒類などは対象外（常に10%）">
          <select
            value={form.reducedTaxEligible ? '1' : '0'}
            onChange={(e) => set('reducedTaxEligible', e.target.value === '1')}
          >
            <option value="1">軽減税率の対象（飲食料品）</option>
            <option value="0">対象外（酒類など）</option>
          </select>
        </Field>
        <IntInput label="表示順" min={0} value={form.sortOrder} onChange={(v) => set('sortOrder', v ?? 0)} />
        <Field label="ボタン色">
          <span className="row">
            <input
              type="color"
              value={form.buttonColor || '#ffffff'}
              onChange={(e) => set('buttonColor', e.target.value)}
            />
            <button type="button" className="btn btn--small" onClick={() => set('buttonColor', '')}>
              色なし
            </button>
          </span>
        </Field>
        <div className="field">
          <span>状態</span>
          <Checkbox label="売切" checked={form.soldOut} onChange={(v) => set('soldOut', v)} />
          <Checkbox label="有効（レジに表示する）" checked={form.enabled} onChange={(v) => set('enabled', v)} />
        </div>
        <div className="field form--full">
          <span>オプショングループ（チェックした順にレジで表示）</span>
          {groups.length === 0 ? (
            <small className="muted">オプショングループは未登録です</small>
          ) : (
            <div className="check-grid">
              {groups.map((g) => (
                <Checkbox
                  key={g.id}
                  label={`${g.name}${g.enabled ? '' : '（無効）'}`}
                  checked={form.optionGroupIds.includes(g.id)}
                  onChange={(on) => toggleGroup(g.id, on)}
                />
              ))}
            </div>
          )}
        </div>
        <div className="form--full">
          <FormActions busy={busy} error={error} onCancel={onClose} />
        </div>
      </form>
    </Modal>
  );
}

/** 商品 CSV の出力・取り込み */
function ProductCsv({ onImported }: { onImported: (message: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<{ message: string; rows: { row: number; message: string }[] } | null>(null);

  const download = async () => {
    // 認証ヘッダーが要るので fetch してから保存する
    const headers: Record<string, string> = { [STAFF_SESSION_HEADER]: session.get(keys.adminSession) ?? '' };
    const deviceToken = local.get(keys.deviceToken);
    if (deviceToken) headers[DEVICE_TOKEN_HEADER] = deviceToken;
    const res = await fetch('/api/admin/products/export', { headers });
    if (!res.ok) return onImported('CSV の出力に失敗しました');
    const name = /filename="(.+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'products.csv';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const upload = async (file: File) => {
    setErrors(null);
    try {
      const csv = await file.text();
      const res = await adminApi<{ created: number; updated: number }>('/api/admin/products/import', {
        method: 'POST',
        body: { csv },
      });
      onImported(`CSV を取り込みました（新規 ${res.created}件・更新 ${res.updated}件）`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'csv_invalid') {
        setErrors({ message: err.message, rows: (err.details?.rows as { row: number; message: string }[]) ?? [] });
      } else {
        onImported(errorMessage(err, 'CSV の取り込みに失敗しました'));
      }
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <button className="btn" onClick={download}>
        CSV 出力
      </button>
      <button className="btn" onClick={() => fileRef.current?.click()}>
        CSV 取り込み
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
      />
      {errors && (
        <Modal title="CSV を取り込めませんでした" onClose={() => setErrors(null)}>
          <p className="error">{errors.message}</p>
          <ul className="error-list">
            {errors.rows.map((r) => (
              <li key={`${r.row}-${r.message}`}>
                {r.row}行目: {r.message}
              </li>
            ))}
          </ul>
          <p className="muted small">
            UTF-8 の CSV を取り込めます。まず「CSV 出力」で形式を確認し、id が空の行は新規、値がある行は更新になります。
          </p>
        </Modal>
      )}
    </>
  );
}
