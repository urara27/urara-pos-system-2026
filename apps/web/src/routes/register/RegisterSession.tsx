import { useEffect, useState } from 'react';
import { NUMBERING_MODE_LABELS, type RegisterSessionSummary, type RegisterStatus } from '@pos/shared';
import { Keypad } from '../../components/Keypad';
import { api, ApiError } from '../../lib/api';
import { yen } from './CatalogView';

const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** 起動時のレジ番号の選択（ログイン前） */
export function RegisterSelect({ deviceName, onSelect }: { deviceName: string; onSelect: (r: RegisterStatus) => void }) {
  const [list, setList] = useState<RegisterStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ registers: RegisterStatus[] }>('/api/register/registers')
      .then((res) => {
        setList(res.registers);
        // この端末で開設中のレジがあれば、そのまま再開する
        const mine = res.registers.find((r) => r.openSession?.mine);
        if (mine) onSelect(mine);
      })
      .catch((err: unknown) => setError(message(err, 'レジの一覧を読み込めませんでした')));
  }, [onSelect]);

  return (
    <main className="panel-page">
      <div className="panel panel--wide">
        <h1>{deviceName}：レジを選択</h1>
        {error && <p className="error">{error}</p>}
        {!list ? (
          <p className="muted">読み込んでいます…</p>
        ) : list.length === 0 ? (
          <p className="muted">レジが登録されていません。管理画面の「レジ」で登録してください。</p>
        ) : (
          <div className="register-choices">
            {list.map((r) => {
              const busyElsewhere = r.openSession !== null && !r.openSession.mine;
              return (
                <button key={r.id} className="register-choice" disabled={busyElsewhere} onClick={() => onSelect(r)}>
                  <strong>{r.name}</strong>
                  <span className="muted">
                    レジ番号 {r.number} ・ {NUMBERING_MODE_LABELS[r.numberingMode]}
                  </span>
                  <span className={busyElsewhere ? 'error small' : 'small'}>
                    {r.openSession === null
                      ? '未開設'
                      : r.openSession.mine
                        ? 'この端末で開設中（再開）'
                        : `${r.openSession.deviceName}で開設中`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

/** レジの開設: 釣銭準備金を入力する */
export function OpenRegister({
  register,
  onOpened,
  onBack,
}: {
  register: RegisterStatus;
  onOpened: (s: RegisterSessionSummary) => void;
  onBack: () => void;
}) {
  const [cash, setCash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onOpened(
        await api<RegisterSessionSummary>('/api/register/sessions', {
          method: 'POST',
          auth: 'staff',
          body: { registerId: register.id, openingCash: Number(cash || 0) },
        }),
      );
    } catch (err) {
      setError(message(err, '開設できませんでした'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="panel-page">
      <div className="panel panel--wide">
        <h1>{register.name}を開設</h1>
        <div className="login-steps">
          <Keypad label="釣銭準備金（円）" value={cash} onChange={setCash} maxLength={7} />
          <div className="login-steps__actions">
            <p className="muted">ドロアに入れた釣銭の合計を入力してください。</p>
            <p className="big-amount">{yen(Number(cash || 0))}</p>
            {error && <p className="error">{error}</p>}
            <button className="btn btn--primary btn--block btn--large" disabled={busy} onClick={submit}>
              開設する
            </button>
            <button className="btn btn--block" onClick={onBack}>
              レジの選択に戻る
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

/** レジの閉設: 現金を数えて入力し、理論在高との過不足を表示する */
export function CloseRegister({ sessionId, onClosed, onCancel }: { sessionId: number; onClosed: () => void; onCancel: () => void }) {
  const [summary, setSummary] = useState<RegisterSessionSummary | null>(null);
  const [cash, setCash] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<RegisterSessionSummary>(`/api/register/sessions/${sessionId}`, { auth: 'staff' })
      .then(setSummary)
      .catch((err: unknown) => setError(message(err, '集計を読み込めませんでした')));
  }, [sessionId]);

  const submit = async () => {
    if (!window.confirm('レジを閉設します。よろしいですか？')) return;
    setBusy(true);
    setError(null);
    try {
      setSummary(
        await api<RegisterSessionSummary>(`/api/register/sessions/${sessionId}/close`, {
          method: 'POST',
          auth: 'staff',
          body: { countedCash: Number(cash || 0) },
        }),
      );
    } catch (err) {
      setError(message(err, '閉設できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  const closed = summary?.closedAt != null;
  const diff = summary?.cashDifference ?? null;

  return (
    <main className="panel-page">
      <div className="panel panel--wide">
        <h1>{summary?.registerName ?? 'レジ'}の閉設</h1>
        {error && <p className="error">{error}</p>}
        {summary && (
          <div className="login-steps">
            <div>
              <dl className="summary-list">
                <div>
                  <dt>釣銭準備金</dt>
                  <dd>{yen(summary.openingCash)}</dd>
                </div>
                <div>
                  <dt>現金売上</dt>
                  <dd>{yen(summary.cashSales)}</dd>
                </div>
                <div>
                  <dt>理論在高</dt>
                  <dd>
                    <strong>{yen(summary.expectedCash)}</strong>
                  </dd>
                </div>
                <div>
                  <dt>PayPay売上（PayPay側と照合）</dt>
                  <dd>{yen(summary.paypaySales)}</dd>
                </div>
                <div>
                  <dt>取引数</dt>
                  <dd>{summary.transactionCount}件</dd>
                </div>
                {closed && (
                  <>
                    <div>
                      <dt>実査</dt>
                      <dd>{yen(summary.countedCash ?? 0)}</dd>
                    </div>
                    <div className={diff === 0 ? '' : 'is-diff'}>
                      <dt>過不足</dt>
                      <dd>
                        <strong>
                          {diff === 0 ? '±0（一致）' : diff! > 0 ? `+${yen(diff!)}（過剰）` : `−${yen(-diff!)}（不足）`}
                        </strong>
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </div>
            <div className="login-steps__actions">
              {closed ? (
                <>
                  <p className="notice">閉設しました。</p>
                  <button className="btn btn--primary btn--block btn--large" onClick={onClosed}>
                    終了
                  </button>
                </>
              ) : (
                <>
                  <Keypad label="数えた現金（円）" value={cash} onChange={setCash} maxLength={7} />
                  <button className="btn btn--primary btn--block btn--large" disabled={busy || cash === ''} onClick={submit}>
                    閉設する
                  </button>
                  <button className="btn btn--block" onClick={onCancel}>
                    会計に戻る
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
