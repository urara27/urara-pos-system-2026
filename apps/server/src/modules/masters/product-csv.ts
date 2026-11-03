import { parseCsv, productInput, toCsv, type CsvImportResult, type Product, type Station } from '@pos/shared';
import { immediateTransaction, type Db } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';
import type { Actor, MasterService } from './service.js';

/**
 * 商品マスタの CSV。カテゴリ・オプショングループは名前で指定する（ID より人が編集しやすい）。
 * id 列が空の行は新規、値がある行はその商品を更新する。1行でも誤りがあれば何も取り込まない。
 */
export const PRODUCT_CSV_HEADER = [
  'id',
  '商品名',
  'キッチン略称',
  '店内価格',
  '持ち帰り価格',
  '軽減税率',
  'カテゴリ',
  'ステーション',
  'オプショングループ',
  '表示順',
  'ボタン色',
  '売切',
  '有効',
] as const;

const STATION_LABELS: Record<Station, string> = { food: 'フード', drink: 'ドリンク' };
const GROUP_SEPARATOR = '|';

export function exportProductsCsv(masters: MasterService): string {
  const categoryName = new Map(masters.listCategories().map((c) => [c.id, c.name]));
  const groupName = new Map(masters.listOptionGroups().map((g) => [g.id, g.name]));
  const flag = (b: boolean) => (b ? 1 : 0);
  const rows = masters.listProducts().map((p) => [
    p.id,
    p.name,
    p.kitchenName,
    p.priceEatIn,
    p.priceTakeOut,
    flag(p.reducedTaxEligible),
    categoryName.get(p.categoryId),
    STATION_LABELS[p.station],
    p.optionGroupIds.map((id) => groupName.get(id)).join(GROUP_SEPARATOR),
    p.sortOrder,
    p.buttonColor,
    flag(p.soldOut),
    flag(p.enabled),
  ]);
  return toCsv([[...PRODUCT_CSV_HEADER], ...rows]);
}

export class CsvImportError extends AppError {
  constructor(rows: { row: number; message: string }[]) {
    super(400, 'csv_invalid', `CSV に誤りがあります（${rows.length}件）。何も取り込んでいません`, { rows });
  }
}

function parseInteger(value: string, label: string): number {
  const v = value.trim().replaceAll(',', '');
  if (!/^-?\d+$/.test(v)) throw new Error(`${label}は整数で入力してください`);
  return Number(v);
}

function parseFlag(value: string, label: string, fallback: boolean): boolean {
  const v = value.trim();
  if (v === '') return fallback;
  if (['1', 'true', 'TRUE', 'はい', '○'].includes(v)) return true;
  if (['0', 'false', 'FALSE', 'いいえ', '×'].includes(v)) return false;
  throw new Error(`${label}は 1 か 0 で入力してください`);
}

function parseStation(value: string): Station {
  const v = value.trim();
  if (v === 'food' || v === 'フード') return 'food';
  if (v === 'drink' || v === 'ドリンク') return 'drink';
  throw new Error('ステーションは「フード」か「ドリンク」で入力してください');
}

export function importProductsCsv(db: Db, masters: MasterService, text: string, actor: Actor): CsvImportResult {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (err) {
    throw new CsvImportError([{ row: 0, message: (err as Error).message }]);
  }
  const [header, ...body] = table;
  if (!header || header.map((h) => h.trim()).join(',') !== PRODUCT_CSV_HEADER.join(',')) {
    throw new CsvImportError([
      { row: 1, message: `1行目は見出し行（${PRODUCT_CSV_HEADER.join(',')}）にしてください` },
    ]);
  }
  if (body.length === 0) throw new CsvImportError([{ row: 2, message: '取り込む行がありません' }]);

  return immediateTransaction(db, (tx) => {
    const { cats, groups } = masters.lookupTables(tx);
    const categoryByName = new Map(cats.map((c) => [c.name, c.id]));
    const groupByName = new Map(groups.map((g) => [g.name, g.id]));
    const errors: { row: number; message: string }[] = [];
    const parsed: { row: number; id: number | null; data: ReturnType<typeof productInput.parse> }[] = [];
    const seenIds = new Set<number>();

    body.forEach((cols, i) => {
      const row = i + 2; // 見出し行が1行目
      try {
        if (cols.length !== PRODUCT_CSV_HEADER.length) {
          throw new Error(`列の数が${PRODUCT_CSV_HEADER.length}ではありません（${cols.length}列）`);
        }
        const c = (k: (typeof PRODUCT_CSV_HEADER)[number]) => cols[PRODUCT_CSV_HEADER.indexOf(k)]!.trim();

        const id = c('id') === '' ? null : parseInteger(c('id'), 'id');
        if (id !== null) {
          if (seenIds.has(id)) throw new Error(`id ${id} が複数行にあります`);
          seenIds.add(id);
          if (!masters.productExists(tx, id)) throw new Error(`id ${id} の商品はありません（新規なら id を空にしてください）`);
        }
        const categoryId = categoryByName.get(c('カテゴリ'));
        if (categoryId === undefined) throw new Error(`カテゴリ「${c('カテゴリ')}」が登録されていません`);
        const optionGroupIds = c('オプショングループ')
          .split(GROUP_SEPARATOR)
          .map((s) => s.trim())
          .filter((s) => s !== '')
          .map((name) => {
            const gid = groupByName.get(name);
            if (gid === undefined) throw new Error(`オプショングループ「${name}」が登録されていません`);
            return gid;
          });

        const result = productInput.safeParse({
          name: c('商品名'),
          kitchenName: c('キッチン略称'),
          priceEatIn: parseInteger(c('店内価格'), '店内価格'),
          priceTakeOut: c('持ち帰り価格') === '' ? null : parseInteger(c('持ち帰り価格'), '持ち帰り価格'),
          reducedTaxEligible: parseFlag(c('軽減税率'), '軽減税率', true),
          categoryId,
          station: parseStation(c('ステーション')),
          optionGroupIds,
          sortOrder: c('表示順') === '' ? 0 : parseInteger(c('表示順'), '表示順'),
          buttonColor: c('ボタン色'),
          soldOut: parseFlag(c('売切'), '売切', false),
          enabled: parseFlag(c('有効'), '有効', true),
        });
        if (!result.success) throw new Error(result.error.issues[0]?.message ?? '入力が不正です');
        parsed.push({ row, id, data: result.data });
      } catch (err) {
        errors.push({ row, message: (err as Error).message });
      }
    });

    if (errors.length > 0) throw new CsvImportError(errors);

    let created = 0;
    let updated = 0;
    for (const { id, data } of parsed) {
      if (id === null) {
        masters.createProductIn(tx, data, actor);
        created++;
      } else {
        // 変更のない行は更新しない（操作ログを汚さない）
        const before: Product = masters.getProduct(id);
        const keys = Object.keys(data) as (keyof typeof data)[];
        if (keys.some((k) => JSON.stringify(before[k]) !== JSON.stringify(data[k]))) {
          masters.updateProductIn(tx, id, data, actor);
          updated++;
        }
      }
    }
    return { created, updated };
  });
}
