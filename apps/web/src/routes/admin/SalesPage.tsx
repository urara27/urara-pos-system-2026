import { useEffect, useState, type ReactNode } from 'react';
import {
  DINING_OPTION_LABELS,
  PAYMENT_METHOD_LABELS,
  type ReportCsvKind,
  type SalesReport,
} from '@pos/shared';
import { adminApi, errorMessage, PageHeader, yen } from './common';
import { HourlyChart } from './HourlyChart';
import { downloadReportCsv, shiftDate, useBusinessToday } from './reporting';

/** 期間の選択（単日が基本。終了日を入れると期間） */
export function DateRangeBar({
  from,
  to,
  today,
  onChange,
}: {
  from: string;
  to: string;
  today: string;
  onChange: (from: string, to: string) => void;
}) {
  return (
    <div className="date-range">
      <label className="field">
        <span>営業日</span>
        <input type="date" value={from} max={today} onChange={(e) => e.target.value && onChange(e.target.value, e.target.value > to ? e.target.value : to === from ? e.target.value : to)} />
      </label>
      <span className="date-range__sep">〜</span>
      <label className="field">
        <span>終了日（期間のとき）</span>
        <input type="date" value={to} min={from} max={today} onChange={(e) => onChange(from, e.target.value || from)} />
      </label>
      <div className="row">
        <button className="btn btn--small" onClick={() => onChange(today, today)}>
          今日
        </button>
        <button className="btn btn--small" onClick={() => onChange(shiftDate(today, -1), shiftDate(today, -1))}>
          昨日
        </button>
        <button className="btn btn--small" onClick={() => onChange(shiftDate(today, -6), today)}>
          直近7日
        </button>
        <button className="btn btn--small" onClick={() => onChange(`${today.slice(0, 8)}01`, today)}>
          今月
        </button>
      </div>
    </div>
  );
}

function CsvButton({ kind, from, to, label = 'CSV' }: { kind: ReportCsvKind; from: string; to: string; label?: string }) {
  const [error, setError] = useState(false);
  return (
    <button
      className="btn btn--small"
      onClick={() => downloadReportCsv(kind, from, to).then(() => setError(false), () => setError(true))}
      title={error ? '出力に失敗しました' : undefined}
    >
      {error ? 'CSV（失敗）' : label}
    </button>
  );
}

function Section({ title, csv, children }: { title: string; csv?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="row row--between">
        <h2>{title}</h2>
        {csv}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, value, sub, hero = false }: { label: string; value: string; sub?: string; hero?: boolean }) {
  return (
    <div className={`stat-tile${hero ? ' stat-tile--hero' : ''}`}>
      <span className="stat-tile__label">{label}</span>
      <span className="stat-tile__value">{value}</span>
      {sub && <span className="stat-tile__sub">{sub}</span>}
    </div>
  );
}

const time = (ms: number) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 売上確認（要件3.8）。金額は割引後の税込、返金は返金した日・レジに計上 */
export function SalesPage() {
  const today = useBusinessToday();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [report, setReport] = useState<SalesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHourlyTable, setShowHourlyTable] = useState(false);

  useEffect(() => {
    if (today && !range) setRange({ from: today, to: today });
  }, [today, range]);

  useEffect(() => {
    if (!range) return;
    setError(null);
    adminApi<SalesReport>(`/api/admin/reports/sales?from=${range.from}&to=${range.to}`)
      .then(setReport)
      .catch((err: unknown) => setError(errorMessage(err, '売上を読み込めませんでした')));
  }, [range]);

  if (!range || !today) return <p className="muted">読み込み中…</p>;
  const { from, to } = range;
  const s = report?.summary;

  return (
    <>
      <PageHeader title="売上">
        <CsvButton kind="transactions" from={from} to={to} label="取引明細 CSV" />
      </PageHeader>
      <DateRangeBar from={from} to={to} today={today} onChange={(f, t) => setRange({ from: f, to: t })} />
      {error && <p className="error">{error}</p>}
      {report && s && (
        <>
          <section className="card">
            <div className="row row--between">
              <h2>{from === to ? `${from} の売上` : `${from} 〜 ${to} の売上`}</h2>
              <CsvButton kind="summary" from={from} to={to} />
            </div>
            <div className="stat-tiles">
              <Tile hero label="純売上（税込）" value={yen(s.netSales)} sub={`総売上 ${yen(s.grossSales)} ／ 返金・変更 ${yen(s.refunds)}`} />
              <Tile label="客数" value={`${s.customerCount}人`} sub={`会計 ${s.saleCount}件・全額返金 ${s.cancelledCount}件`} />
              <Tile label="客単価" value={yen(s.averagePerCustomer)} />
              <Tile label="割引額" value={yen(s.discountTotal)} />
              <Tile label="返金・変更" value={`${s.refundCount}件`} sub={yen(s.refunds)} />
            </div>
            <p className="muted small">
              金額は割引を引いた後の税込金額です。返金・商品変更は、行った日・行ったレジの売上から差し引いています。客数は会計の件数から全額返金された会計を除いた数です。
            </p>
          </section>

          <Section
            title="時間帯別の売上"
            csv={
              <div className="row">
                <button className="btn btn--small" onClick={() => setShowHourlyTable((v) => !v)}>
                  {showHourlyTable ? 'グラフで表示' : '表で表示'}
                </button>
                <CsvButton kind="hourly" from={from} to={to} />
              </div>
            }
          >
            {showHourlyTable ? (
              <SimpleTable
                head={['時間帯', '金額', '販売件数']}
                rows={report.hourly.filter((h) => h.amount !== 0 || h.count > 0).map((h) => [`${h.hour}時台`, yen(h.amount), `${h.count}件`])}
              />
            ) : (
              <HourlyChart rows={report.hourly} />
            )}
          </Section>

          <div className="report-grid">
            <Section title="支払方法別" csv={<CsvButton kind="payments" from={from} to={to} />}>
              <SimpleTable head={['支払方法', '金額', '販売件数']} rows={report.payments.map((p) => [PAYMENT_METHOD_LABELS[p.method], yen(p.amount), `${p.count}件`])} />
            </Section>
            <Section title="店内／持ち帰り別" csv={<CsvButton kind="dining" from={from} to={to} />}>
              <SimpleTable head={['区分', '金額', '販売件数']} rows={report.dining.map((d) => [DINING_OPTION_LABELS[d.diningOption], yen(d.amount), `${d.count}件`])} />
            </Section>
            <Section title="税率別" csv={<CsvButton kind="taxes" from={from} to={to} />}>
              <SimpleTable head={['税率', '対象額（税込）', '消費税額']} rows={report.taxes.map((t) => [`${t.taxRate}%`, yen(t.taxableAmount), yen(t.taxAmount)])} />
            </Section>
            <Section title="レジ別" csv={<CsvButton kind="registers" from={from} to={to} />}>
              <SimpleTable
                head={['レジ', '金額', '販売件数', '現金', 'PayPay']}
                rows={report.registers.map((r) => [r.name, yen(r.amount), `${r.count}件`, yen(r.cash), yen(r.paypay)])}
              />
            </Section>
          </div>

          <Section title="商品別" csv={<CsvButton kind="products" from={from} to={to} />}>
            <SimpleTable head={['商品', 'カテゴリ', '数量', '金額']} rows={report.products.map((p) => [p.name, p.category, `${p.quantity}`, yen(p.amount)])} />
          </Section>
          <div className="report-grid">
            <Section title="カテゴリ別" csv={<CsvButton kind="categories" from={from} to={to} />}>
              <SimpleTable head={['カテゴリ', '数量', '金額']} rows={report.categories.map((c) => [c.name, `${c.quantity}`, yen(c.amount)])} />
            </Section>
            <Section title="割引の内訳" csv={<CsvButton kind="discounts" from={from} to={to} />}>
              <SimpleTable
                head={['割引', '件数', '割引額']}
                rows={report.discounts.map((d) => [`${d.name}${d.manual ? '（手入力）' : ''}`, `${d.count}件`, yen(d.amount)])}
              />
            </Section>
          </div>
          <Section title="返金・商品変更の一覧" csv={<CsvButton kind="refunds" from={from} to={to} />}>
            <SimpleTable
              head={['日時', '種別', 'レシート番号', '元のレシート', 'レジ', '担当', '承認者', '理由', '金額']}
              rows={report.refunds.map((r) => [
                time(r.createdAt),
                r.kind === 'refund' ? '返金' : '商品変更',
                r.receiptNumber,
                r.originalReceiptNumber ?? '—',
                `${r.registerNumber}`,
                r.employeeName,
                r.approverName ?? '—',
                r.reason ?? '',
                yen(r.amount),
              ])}
            />
          </Section>
        </>
      )}
    </>
  );
}

/** 金額・件数・数量の列（すべてのセルが数値の表記）は右寄せにする表 */
export function SimpleTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  const NUMERIC = /^-?¥[\d,]+$|^-?[\d,]+(件|人)?$/;
  const isNum = (i: number) => rows.length > 0 && rows.every((r) => typeof r[i] === 'string' && NUMERIC.test(r[i] as string));
  if (rows.length === 0) return <p className="muted">データがありません。</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={isNum(i) ? 'num' : ''}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k}>
              {r.map((c, i) => (
                <td key={i} className={isNum(i) ? 'num' : ''}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
