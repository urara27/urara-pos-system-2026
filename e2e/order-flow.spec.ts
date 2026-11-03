import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config';

/**
 * フェーズ3の完了条件: 1件の注文がレジから受け渡し済みまで通しで流れる。
 * レジ・キッチン・カスタマーモニター・ピックアップを別々のブラウザコンテキスト（＝別端末）で動かす。
 */

async function adminApi(request: APIRequestContext) {
  const login = await request.post('/api/admin/login', { data: { code: E2E_ADMIN.code, password: E2E_ADMIN.password } });
  expect(login.ok()).toBeTruthy();
  const { token } = (await login.json()) as { token: string };
  const headers = { 'x-staff-session': token };
  return async <T>(url: string, data: object): Promise<T> => {
    const res = await request.post(url, { headers, data });
    expect(res.ok(), `${url}: ${await res.text()}`).toBeTruthy();
    return (await res.json()) as T;
  };
}

/** 管理画面で発行したコードを、その端末の /pairing 画面で入力して登録する */
async function pairDevice(browser: Browser, post: Awaited<ReturnType<typeof adminApi>>, role: string, name: string) {
  const { code } = await post<{ code: string }>('/api/admin/pairing-codes', { role });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/pairing');
  await page.getByLabel('ペアリングコード').fill(code);
  await page.getByLabel(/端末名/).fill(name);
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page).toHaveURL(new RegExp(`/${role}$`));
  await expect(page.getByRole('status').filter({ hasText: 'オンライン' })).toBeVisible();
  return page;
}

/** テンキーで数字を入力する */
async function typeKeypad(page: Page, digits: string) {
  const keypad = page.locator('.keypad').first();
  for (const d of digits) await keypad.getByRole('button', { name: d, exact: true }).click();
}

test('レジで会計した注文が、キッチン・カスタマーモニター・ピックアップを通って受け渡し済みになる', async ({ browser, request }) => {
  // ── マスタ: セット商品（フード）+ セットドリンク（ドリンク） ──
  const post = await adminApi(request);
  const category = await post<{ id: number }>('/api/admin/categories', { name: 'バーガー' });
  const setDrink = await post<{ id: number }>('/api/admin/option-groups', {
    name: 'セットドリンク',
    selection: 'single',
    options: [
      { name: 'コーラ', priceDelta: 0, station: 'drink', isDefault: true },
      { name: 'アイスティー', priceDelta: 0, station: 'drink' },
    ],
  });
  await post('/api/admin/products', {
    name: 'チーズバーガーセット',
    kitchenName: 'チーズセット',
    priceEatIn: 850,
    categoryId: category.id,
    station: 'food',
    optionGroupIds: [setDrink.id],
  });

  // ── 端末の登録 ──
  const register = await pairDevice(browser, post, 'register', 'レジ用iPad');
  const kitchen = await pairDevice(browser, post, 'kitchen', 'キッチン');
  const customer = await pairDevice(browser, post, 'customer', 'カスタマーモニター');
  const pickup = await pairDevice(browser, post, 'pickup', 'ピックアップ');

  await customer.getByRole('button', { name: /画面をタップして開始/ }).click();
  const preparing = customer.locator('.customer__area--preparing');
  const calling = customer.locator('.customer__area--calling');

  // ── レジ: レジ選択 → ログイン → 開設 ──
  await register.getByRole('button', { name: /レジ1/ }).click();
  await typeKeypad(register, E2E_ADMIN.code);
  await register.getByRole('button', { name: '次へ' }).click();
  await typeKeypad(register, E2E_ADMIN.pin);
  await register.getByRole('button', { name: 'ログイン' }).click();
  await expect(register.getByRole('heading', { name: 'レジ1を開設' })).toBeVisible();
  await typeKeypad(register, '10000');
  await register.getByRole('button', { name: '開設する' }).click();

  // ── レジ: 商品選択（オプションは既定のコーラ）→ 店内 → 現金ちょうど ──
  await register.getByRole('button', { name: /チーズバーガーセット/ }).click();
  await expect(register.getByRole('button', { name: 'コーラ' })).toHaveAttribute('aria-pressed', 'true');
  await register.getByRole('button', { name: '追加 ¥850' }).click();
  await register.getByRole('radio', { name: '店内' }).click();
  await expect(register.locator('.pos__total')).toContainText('¥850');
  await register.getByRole('button', { name: '会計へ' }).click();
  await register.getByRole('radio', { name: '現金' }).click();
  await register.getByRole('button', { name: 'ちょうど' }).click();
  await register.getByRole('button', { name: '会計を確定' }).click();

  await expect(register.locator('.complete__number')).toHaveText('100');
  await expect(register.locator('.complete__details')).toContainText(/\d{8}-1-0001/);

  // ── カスタマーモニター: おつくり中に表示 ──
  await expect(preparing).toContainText('100');
  await expect(calling).not.toContainText('100');

  // ── キッチン（すべて）: カードが出て、タップで調理完了 ──
  const card = kitchen.locator('.kcard', { hasText: '100' });
  await expect(card).toContainText('チーズセット');
  await expect(card).toContainText('コーラ');
  await card.click();
  await expect(card).toHaveCount(0);
  await expect(kitchen.locator('.kitchen__history')).toContainText('100');

  // ── ピックアップ: 調理完了の目印 → 呼び出し ──
  const tile = pickup.locator('.ptile', { hasText: '100' });
  await expect(tile).toHaveClass(/is-ready/);
  await tile.click();
  await expect(pickup.locator('.pdetail')).toContainText('チーズセット');
  await pickup.getByRole('button', { name: '呼び出し', exact: true }).click();

  // カスタマーモニター: お呼び出し中に移り、強調される
  await expect(calling.locator('.cnum', { hasText: '100' })).toHaveClass(/is-new/);
  await expect(preparing).not.toContainText('100');

  // ── ピックアップ: 受け渡し済み（確認ダイアログを承認） ──
  pickup.once('dialog', (d) => void d.accept());
  await pickup.getByRole('button', { name: '受け渡し済み' }).click();
  await expect(pickup.locator('.ptile', { hasText: '100' })).toHaveCount(0);
  await expect(pickup.locator('.pickup__recent')).toContainText('100');

  // カスタマーモニターから消える
  await expect(calling).not.toContainText('100');
  await expect(preparing).not.toContainText('100');

  // ── 誤操作の取消: 受け渡し済みを呼び出し中に戻せる ──
  await pickup.locator('.pickup__recent').getByRole('button', { name: '100' }).click();
  await pickup.getByRole('button', { name: '呼び出し中に戻す' }).click();
  await expect(calling).toContainText('100');

  // ── ピックアップは iPhone の画面幅でも操作できる（横スクロールなし） ──
  await pickup.setViewportSize({ width: 390, height: 844 });
  await expect(pickup.getByRole('button', { name: '受け渡し済み' })).toBeInViewport();
  const overflow = await pickup.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
