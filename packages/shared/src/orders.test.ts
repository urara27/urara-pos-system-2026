import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, type OrderStatus } from './domain.js';
import {
  formatOrderNumber,
  isKitchenDone,
  kitchenDoneAt,
  kitchenItems,
  nextStatus,
  ORDER_ACTIONS,
  type OrderAction,
  type OrderView,
} from './orders.js';

describe('注文の状態遷移', () => {
  // [操作, 遷移元, 期待する遷移先（null は拒否）]
  const table: [OrderAction, OrderStatus, OrderStatus | null][] = [
    ['call', 'accepted', 'calling'],
    ['call', 'calling', null],
    ['call', 'completed', null],
    ['call', 'cancelled', null],
    ['recall', 'calling', 'calling'],
    ['recall', 'accepted', null],
    ['uncall', 'calling', 'accepted'],
    ['uncall', 'accepted', null],
    ['handover', 'accepted', 'completed'],
    ['handover', 'calling', 'completed'],
    ['handover', 'completed', null],
    ['handover', 'cancelled', null],
    ['undoHandover', 'completed', 'calling'],
    ['undoHandover', 'calling', null],
    ['undoHandover', 'cancelled', null],
    ['cancel', 'accepted', 'cancelled'],
    ['cancel', 'calling', 'cancelled'],
    ['cancel', 'completed', null],
    ['cancel', 'cancelled', null],
  ];
  it.each(table)('%s: %s → %s', (action, from, to) => {
    expect(nextStatus(from, action)).toBe(to);
  });

  it('全ての操作 × 全ての状態を表で網羅している', () => {
    const covered = new Set(table.map(([a, s]) => `${a}:${s}`));
    const missing = Object.keys(ORDER_ACTIONS).flatMap((a) =>
      ORDER_STATUSES.filter((s) => !covered.has(`${a}:${s}`)).map((s) => `${a}:${s}`),
    );
    // 表に無い組み合わせはすべて拒否であること
    for (const key of missing) {
      const [a, s] = key.split(':') as [OrderAction, OrderStatus];
      expect(nextStatus(s, a)).toBeNull();
    }
  });

  it('受け渡し済み・取消からは取消できない（取消は completed 以外から）', () => {
    expect(nextStatus('completed', 'cancel')).toBeNull();
  });
});

describe('注文番号', () => {
  it('3桁ゼロ埋め', () => {
    expect(formatOrderNumber(7)).toBe('007');
    expect(formatOrderNumber(100)).toBe('100');
  });
});

const order = (patch: Partial<OrderView> = {}): OrderView => ({
  id: 1,
  orderNumber: 101,
  numberingMode: 'auto',
  diningOption: 'eat_in',
  status: 'accepted',
  acceptedAt: 1000,
  calledAt: null,
  completedAt: null,
  cancelledAt: null,
  modifiedAt: null,
  version: 1,
  receiptNumber: '20261103-1-0001',
  stations: { food: { hasItems: true, completedAt: null }, drink: { hasItems: false, completedAt: null } },
  items: [],
  ...patch,
});

describe('キッチン', () => {
  it('明細の無いステーションは最初から完了扱い', () => {
    expect(isKitchenDone(order())).toBe(false);
    const done = order({ stations: { food: { hasItems: true, completedAt: 5000 }, drink: { hasItems: false, completedAt: null } } });
    expect(isKitchenDone(done)).toBe(true);
    expect(kitchenDoneAt(done)).toBe(5000);
  });

  it('セット商品のドリンクはドリンク側に、商品はフード側に出る', () => {
    const o = order({
      items: [
        {
          lineId: 1,
          name: 'チーズバーガーセット',
          kitchenName: 'チーズセット',
          quantity: 2,
          station: 'food',
          options: [
            { name: 'チーズ増量', kitchenName: '', station: 'food', priceDelta: 100 },
            { name: 'コーラ', kitchenName: 'コーラ', station: 'drink', priceDelta: 0 },
          ],
        },
      ],
    });
    expect(kitchenItems(o, 'food')).toEqual([{ key: '1', name: 'チーズセット', quantity: 2, options: ['チーズ増量'] }]);
    expect(kitchenItems(o, 'drink')).toEqual([
      { key: '1-o0', name: 'コーラ', quantity: 2, options: [], parentName: 'チーズセット' },
    ]);
    expect(kitchenItems(o, 'all')).toEqual([
      { key: '1', name: 'チーズセット', quantity: 2, options: ['チーズ増量', 'コーラ'] },
    ]);
  });
});
