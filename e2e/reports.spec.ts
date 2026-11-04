import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { SalesReport } from '@pos/shared';
import { E2E_ADMIN } from '../playwright.config';
import { adminApi, snap } from './helpers';

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

/**
 * フェーズ6: 売上画面に出る数値が、集計 API の値（サーバーのテストで期待値と照合済み）と一致すること。
 * 先に走る order-flow / refund のテストで作った取引を使う。
 */
test('売上・レジ精算・操作ログの画面', async ({ page, request }) => {
  const api = await adminApi(request);
  const { settings } = await api.get<{ settings: { businessDayCutoverMinutes: number } }>('/api/admin/settings');
  const d = new Date(Date.now() - settings.businessDayCutoverMinutes * 60_000);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const report = await api.get<SalesReport>(`/api/admin/reports/sales?from=${today}`);
  expect(report.summary.saleCount).toBeGreaterThan(0);

  await page.goto('/admin');
  await page.getByLabel('従業員コード').fill(E2E_ADMIN.code);
  await page.getByLabel('パスワード').fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'ログイン' }).click();

  // 管理画面を開くと売上が最初に出る
  await expect(page).toHaveURL(/\/admin\/sales$/);
  const tiles = page.locator('.stat-tiles');
  await expect(tiles).toContainText(yen(report.summary.netSales));
  await expect(tiles).toContainText(`${report.summary.customerCount}人`);
  await expect(tiles).toContainText(yen(report.summary.averagePerCustomer));
  await expect(tiles).toContainText(yen(report.summary.discountTotal));
  for (const p of report.products.filter((x) => x.amount !== 0)) {
    await expect(page.locator('.card', { hasText: '商品別' })).toContainText(p.name);
  }
  // 時間帯別のグラフ（1系列）と、同じ内容の表
  await expect(page.locator('.hourly-chart svg')).toBeVisible();
  const firstBar = page.locator('.hourly-chart rect[tabindex="0"]').first();
  await firstBar.hover();
  await expect(page.locator('.hourly-chart__tooltip')).toBeVisible();
  await snap(page, 'reports-1-sales');
  await page.getByRole('button', { name: '表で表示' }).click();
  await expect(page.locator('.card', { hasText: '時間帯別の売上' }).locator('table')).toBeVisible();

  // CSV（BOM 付き・店舗コード入り）
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.card', { hasText: '商品別' }).getByRole('button', { name: 'CSV' }).click()]);
  const csv = await fs.readFile(await download.path(), 'utf8');
  expect(csv.startsWith('﻿店舗コード,開始日,終了日,商品ID')).toBe(true);

  // レジ点検・精算
  await page.getByRole('link', { name: 'レジ点検・精算' }).click();
  await expect(page.getByRole('heading', { name: 'レジ点検・精算' })).toBeVisible();
  await expect(page.locator('table')).toContainText('開設中');
  await expect(page.getByText('PayPay の管理画面の売上と照合')).toBeVisible();
  await snap(page, 'reports-2-settlements');

  // 操作ログ: 返金の分類で絞り込み、詳細を開く
  await page.getByRole('link', { name: '操作ログ' }).click();
  await page.getByRole('button', { name: '返金・変更', exact: true }).click();
  await expect(page.locator('tbody tr').first()).toContainText('返金');
  await page.getByRole('button', { name: '詳細' }).first().click();
  await expect(page.locator('.audit-detail')).toContainText('reason');
  await snap(page, 'reports-3-audit');

  // 営業日・バックアップ: 開設中のレジがあるうちは閉店できない。手動バックアップは取れる
  await page.getByRole('link', { name: '閉店・バックアップ' }).click();
  await expect(page.getByRole('button', { name: '閉店する' })).toBeDisabled();
  await expect(page.getByText('閉店する前に、次のレジを閉設してください')).toBeVisible();
  await page.getByRole('button', { name: '今すぐバックアップ' }).click();
  await expect(page.locator('.notice')).toContainText(/バックアップ pos-.+\.sqlite を作成しました/);
  await expect(page.locator('.card', { hasText: '保存先' }).locator('tbody tr')).toHaveCount(1);
  await snap(page, 'reports-4-operations');
});
