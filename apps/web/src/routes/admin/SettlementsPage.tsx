import { useEffect, useState } from 'react';
import type { RegisterSettlementRow } from '@pos/shared';
import { adminApi, errorMessage, PageHeader, yen } from './common';
import { downloadReportCsv, useBusinessToday } from './reporting';
import { DateRangeBar } from './SalesPage';

const time = (ms: number) => new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

/** 過不足は色だけに頼らず、記号と言葉でも示す */
function Difference({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">未精算</span>;
  if (value === 0) return <span className="diff diff--ok">✓ 一致</span>;
  return value < 0 ? (
    <span className="diff diff--short">▼ {yen(-value)} 不足</span>
  ) : (
    <span className="diff diff--over">▲ {yen(value)} 過剰</span>
  );
}

/**
 * レジ点検・精算（要件3.8）。開設中のレジは点検（現時点の理論在高）、閉設済みは精算結果を出す。
 * PayPay 売上は PayPay 側の売上と照合するために出す。
 */
export function SettlementsPage() {
  const today = useBusinessToday();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [rows, setRows] = useState<RegisterSettlementRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (today && !range) setRange({ from: today, to: today });
  }, [today, range]);
  useEffect(() => {
    if (!range) return;
    adminApi<{ settlements: RegisterSettlementRow[] }>(`/api/admin/reports/settlements?from=${range.from}&to=${range.to}`)
      .then((res) => {
        setRows(res.settlements);
        setError(null);
      })
      .catch((err: unknown) => setError(errorMessage(err, '読み込めませんでした')));
  }, [range]);

  if (!range || !today) return <p className="muted">読み込み中…</p>;
  const paypayTotal = (rows ?? []).reduce((s, r) => s + r.paypaySales, 0);
  // 単日なら営業日の列は省く（表を狭くする）
  const multiDay = range.from !== range.to;

  return (
    <>
      <PageHeader title="レジ点検・精算">
        <button className="btn" onClick={() => void downloadReportCsv('settlements', range.from, range.to).catch(() => setError('CSV を出力できませんでした'))}>
          CSV 出力
        </button>
      </PageHeader>
      <DateRangeBar from={range.from} to={range.to} today={today} onChange={(from, to) => setRange({ from, to })} />
      {error && <p className="error">{error}</p>}
      <section className="card">
        <p className="muted small">
          理論在高 = 釣銭準備金 + 現金売上（返金はマイナス）。閉設時に数えた現金（実査）との差が過不足です。開設中のレジは点検として現時点の理論在高を出しています。
        </p>
        {rows && rows.length === 0 ? (
          <p className="muted">この期間に開設したレジはありません。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {multiDay && <th>営業日</th>}
                  <th>レジ</th>
                  <th>開設</th>
                  <th>閉設</th>
                  <th className="num">釣銭準備金</th>
                  <th className="num">現金売上</th>
                  <th className="num">理論在高</th>
                  <th className="num">実査</th>
                  <th>過不足</th>
                  <th className="num">PayPay 売上</th>
                </tr>
              </thead>
              <tbody>
                {rows?.map((r) => (
                  <tr key={r.sessionId}>
                    {multiDay && <td className="nowrap">{r.businessDate.slice(5).replace('-', '/')}</td>}
                    <td className="nowrap" title={`端末: ${r.deviceName}`}>
                      {r.registerName}
                    </td>
                    <td className="nowrap">
                      {time(r.openedAt)}
                      <small className="muted"> {r.openedByName}</small>
                    </td>
                    <td className="nowrap">
                      {r.closedAt ? (
                        <>
                          {time(r.closedAt)}
                          <small className="muted"> {r.closedByName ?? ''}</small>
                        </>
                      ) : (
                        <span className="pill">開設中</span>
                      )}
                    </td>
                    <td className="num">{yen(r.openingCash)}</td>
                    <td className="num">{yen(r.cashSales)}</td>
                    <td className="num">{yen(r.expectedCash)}</td>
                    <td className="num">{r.countedCash === null ? '—' : yen(r.countedCash)}</td>
                    <td>
                      <Difference value={r.cashDifference} />
                    </td>
                    <td className="num">{yen(r.paypaySales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows && rows.length > 0 && (
          <p className="notice">PayPay 売上の合計 {yen(paypayTotal)} を、PayPay の管理画面の売上と照合してください。</p>
        )}
      </section>
    </>
  );
}
