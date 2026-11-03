import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config';

export type AdminPost = <T>(url: string, data: object, method?: 'post' | 'put') => Promise<T>;

/** 管理 API を管理者ログインで呼ぶ */
export async function adminApi(request: APIRequestContext): Promise<AdminPost & { get: <T>(url: string) => Promise<T> }> {
  const login = await request.post('/api/admin/login', { data: { code: E2E_ADMIN.code, password: E2E_ADMIN.password } });
  expect(login.ok()).toBeTruthy();
  const { token } = (await login.json()) as { token: string };
  const headers = { 'x-staff-session': token };
  const post = async <T>(url: string, data: object, method: 'post' | 'put' = 'post'): Promise<T> => {
    const res = await request[method](url, { headers, data });
    expect(res.ok(), `${url}: ${await res.text()}`).toBeTruthy();
    return (await res.json()) as T;
  };
  const get = async <T>(url: string): Promise<T> => (await (await request.get(url, { headers })).json()) as T;
  return Object.assign(post, { get });
}

/** 管理画面で発行したコードを、その端末の /pairing 画面で入力して登録する */
export async function pairDevice(browser: Browser, post: AdminPost, role: string, name: string) {
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
export async function typeKeypad(page: Page, digits: string) {
  const keypad = page.locator('.keypad').first();
  for (const d of digits) await keypad.getByRole('button', { name: d, exact: true }).click();
}

/** レジでレジ番号を選び、管理者でログインして開設する */
export async function openRegister(page: Page, registerName: string) {
  await page.getByRole('button', { name: new RegExp(registerName) }).click();
  await typeKeypad(page, E2E_ADMIN.code);
  await page.getByRole('button', { name: '次へ' }).click();
  await typeKeypad(page, E2E_ADMIN.pin);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await expect(page.getByRole('heading', { name: `${registerName}を開設` })).toBeVisible();
  await typeKeypad(page, '10000');
  await page.getByRole('button', { name: '開設する' }).click();
}

/** E2E_SCREENSHOT_DIR を指定したときだけ画面を保存する（見た目の確認用） */
export async function snap(page: Page, name: string) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}
