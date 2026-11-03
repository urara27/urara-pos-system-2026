import { expect, test } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config';
import { adminApi, openRegister, pairDevice, snap, typeKeypad } from './helpers';

/**
 * フェーズ5の完了条件: 返金・変更がキッチン表示と売上に正しく反映される。
 * 一部返金でキッチンの数量が減って「変更あり」になり、残りを返金すると注文が取消になって消える。
 * レジの閉設で、返金した分だけ現金の理論在高が減っていることも確かめる。
 */
test('一部返金・全額返金がキッチンとレジの在高に反映される', async ({ browser, request }) => {
  const post = await adminApi(request);
  const category = await post<{ id: number }>('/api/admin/categories', { name: 'サイド' });
  await post('/api/admin/products', { name: 'からあげ', priceEatIn: 300, categoryId: category.id, station: 'food' });

  const register = await pairDevice(browser, post, 'register', '返金テスト用レジ');
  const kitchen = await pairDevice(browser, post, 'kitchen', '返金テスト用キッチン');
  // 別のテストがレジ1を使うので、レジ2で行う
  await openRegister(register, 'レジ2');

  // ── からあげ ×3 を現金ちょうど（900円）で会計 ──
  await register.getByRole('tab', { name: 'サイド' }).click();
  const karaage = register.locator('.product-btn', { hasText: 'からあげ' });
  await karaage.click();
  await karaage.click();
  await karaage.click();
  await register.getByRole('radio', { name: '店内' }).click();
  await register.getByRole('button', { name: '会計へ' }).click();
  await register.getByRole('radio', { name: '現金' }).click();
  await register.getByRole('button', { name: 'ちょうど' }).click();
  await register.getByRole('button', { name: '会計を確定' }).click();
  const orderNumber = (await register.locator('.complete__number').textContent())!;
  await register.getByRole('button', { name: '次のお客様' }).click();

  const card = kitchen.locator('.kcard', { hasText: orderNumber });
  await expect(card).toContainText('からあげ');
  await expect(card.locator('.kcard__qty')).toHaveText('3');

  // ── 取引履歴から1個だけ返金（責任者 PIN・理由つき） ──
  await register.getByRole('button', { name: '取引履歴' }).click();
  await snap(register, 'refund-1-history');
  await register.locator('.history-row', { hasText: orderNumber }).first().click();
  await register.getByRole('button', { name: '増やす' }).click();
  await snap(register, 'refund-2-detail');
  await register.getByRole('button', { name: '選んだ数量を返金' }).click();
  await expect(register.locator('.refund__total')).toContainText('¥300');
  await snap(register, 'refund-3-confirm');
  await register.getByRole('button', { name: '作り間違い' }).click();
  await typeKeypad(register, E2E_ADMIN.code);
  await register.getByRole('button', { name: /^PIN/ }).click();
  await typeKeypad(register, E2E_ADMIN.pin);
  await register.getByRole('button', { name: /返金を確定/ }).click();
  await expect(register.locator('.refund-instruction')).toHaveText('現金 ¥300 をお客様にお返しください');

  // キッチン: 数量が減り、「変更あり」で知らせる
  await expect(kitchen.getByRole('status').filter({ hasText: `注文 ${orderNumber} の内容が変更されました` })).toBeVisible();
  await expect(card.locator('.kcard__qty')).toHaveText('2');
  await expect(card).toContainText('変更あり');
  await snap(kitchen, 'refund-4-kitchen');

  // ── 残り2個も返金 → 全額返金になり、注文は取消 ──
  await register.getByRole('button', { name: '完了' }).click();
  await register.getByRole('button', { name: 'すべて選ぶ' }).click();
  await register.getByRole('button', { name: '選んだ数量を返金' }).click();
  await expect(register.getByText('全額返金です')).toBeVisible();
  await register.getByRole('button', { name: 'お客様都合' }).click();
  await typeKeypad(register, E2E_ADMIN.code);
  await register.getByRole('button', { name: /^PIN/ }).click();
  await typeKeypad(register, E2E_ADMIN.pin);
  await register.getByRole('button', { name: /返金を確定/ }).click();
  await expect(register.locator('.refund-instruction')).toHaveText('現金 ¥600 をお客様にお返しください');
  await expect(register.getByText('注文は取消になり')).toBeVisible();

  await expect(kitchen.getByRole('status').filter({ hasText: `注文 ${orderNumber} は取消になりました` })).toBeVisible();
  await expect(card).toHaveCount(0);

  // 返金レシート: 【返金】と元のレシート番号
  await register.getByRole('button', { name: 'レシートを表示' }).click();
  const paper = register.getByRole('document', { name: 'レシート' });
  await expect(paper).toContainText('【返金】');
  await expect(paper).toContainText('元のレシート番号');
  await expect(paper).toContainText('返品 からあげ');
  await snap(register, 'refund-5-receipt');
  await register.getByRole('button', { name: '閉じる' }).click();
  await register.getByRole('button', { name: '完了' }).click();

  // ── 売上（レジの在高）: 900 − 300 − 600 = 0 円の増減 ──
  await register.getByRole('button', { name: '← 一覧に戻る' }).click();
  await register.getByRole('button', { name: '← 会計に戻る' }).click();
  await register.getByRole('button', { name: 'レジ閉設' }).click();
  const summary = register.locator('.summary-list');
  await expect(summary).toContainText('現金売上¥0');
  await expect(summary).toContainText('理論在高¥10,000');
});
