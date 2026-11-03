import { useState } from 'react';
import { yen } from './common';

interface HourRow {
  hour: number;
  amount: number;
  count: number;
}

const W = 720;
const H = 240;
const PAD = { top: 16, right: 8, bottom: 28, left: 64 };

/** 目盛りをきりのよい値で3〜5本 */
function niceTicks(min: number, max: number) {
  const span = Math.max(max - min, 1);
  const raw = span / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step / 2; v += step) ticks.push(v);
  return ticks;
}

/** 上端だけ 4px 丸めた棒（負の値は下端を丸める） */
function barPath(x: number, y0: number, y1: number, w: number) {
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const h = bottom - top;
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return '';
  if (y1 <= y0) {
    // 正: 上を丸める
    return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bottom}Z`;
  }
  return `M${x},${top}V${bottom - r}Q${x},${bottom} ${x + r},${bottom}H${x + w - r}Q${x + w},${bottom} ${x + w},${bottom - r}V${top}Z`;
}

/**
 * 時間帯別の売上（1系列の棒グラフ）。凡例は無く、見出しが系列名を兼ねる。
 * 色は DADS のブルー600（白地でのコントラスト・明度を検証済み）。棒にカーソルを当てると金額と件数を出す。
 * 同じ数値は下の表でも見られる。
 */
export function HourlyChart({ rows }: { rows: HourRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // 取引のあった時間帯の前後だけを描く
  const first = rows.findIndex((r) => r.amount !== 0 || r.count > 0);
  const last = rows.length - 1 - [...rows].reverse().findIndex((r) => r.amount !== 0 || r.count > 0);
  if (first < 0) return <p className="muted">この期間の取引はありません。</p>;
  const data = rows.slice(Math.max(0, first - 1), Math.min(rows.length, last + 2));

  const max = Math.max(0, ...data.map((d) => d.amount));
  const min = Math.min(0, ...data.map((d) => d.amount));
  const ticks = niceTicks(min, max);
  const lo = Math.min(min, ticks[0]!);
  const hi = Math.max(max, ticks.at(-1)!);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + ((hi - v) / (hi - lo || 1)) * plotH;
  const band = plotW / data.length;
  const barW = Math.min(36, band - 2); // 隣の棒との間に 2px 以上空ける
  const hovered = hover !== null ? data[hover] : null;

  return (
    <div className="hourly-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="時間帯別の売上の棒グラフ（同じ内容は下の表にあります）">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'hourly-chart__zero' : 'hourly-chart__grid'} />
            <text x={PAD.left - 8} y={y(t)} className="hourly-chart__tick" textAnchor="end" dominantBaseline="middle">
              {yen(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD.left + i * band + (band - barW) / 2;
          return (
            <g key={d.hour}>
              <path d={barPath(x, y(0), y(d.amount), barW)} className={`hourly-chart__bar${hover === i ? ' is-hover' : ''}`} />
              {/* 当たり判定は帯全体（棒より大きく） */}
              <rect
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${d.hour}時台 ${yen(d.amount)}・${d.count}件`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
              <text x={PAD.left + i * band + band / 2} y={H - 8} className="hourly-chart__tick" textAnchor="middle">
                {d.hour}時
              </text>
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <div
          className="hourly-chart__tooltip"
          style={{ left: `${((PAD.left + hover * band + band / 2) / W) * 100}%`, top: `${(Math.min(y(hovered.amount), y(0)) / H) * 100}%` }}
          role="status"
        >
          <strong>{hovered.hour}時台</strong>
          <span>{yen(hovered.amount)}</span>
          <span className="muted">販売 {hovered.count}件</span>
        </div>
      )}
    </div>
  );
}
