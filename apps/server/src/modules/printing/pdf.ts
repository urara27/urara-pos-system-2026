import fs from 'node:fs';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import type { ReceiptRow, ReceiptSize } from '@pos/shared';

/**
 * レシートの PDF（80mm ロール紙と同じ幅）。フォントは Noto Sans JP（OFL）を同梱し、
 * 使った文字だけを埋め込む。外部のフォント配信には頼らない。
 */

const require = createRequire(import.meta.url);
let fonts: { regular: Buffer; bold: Buffer } | null = null;
function loadFonts() {
  fonts ??= {
    regular: fs.readFileSync(require.resolve('@expo-google-fonts/noto-sans-jp/400Regular/NotoSansJP_400Regular.ttf')),
    bold: fs.readFileSync(require.resolve('@expo-google-fonts/noto-sans-jp/700Bold/NotoSansJP_700Bold.ttf')),
  };
  return fonts;
}

const MM = 72 / 25.4;
const PAGE_WIDTH = 80 * MM;
const MARGIN = 4 * MM;
const FONT_SIZE: Record<ReceiptSize, number> = { normal: 8.5, large: 13, xlarge: 30 };
const LINE_GAP = 2;
const INDENT = 8;
const SPACE_HEIGHT = 6;
const RULE_HEIGHT = 7;

type Doc = InstanceType<typeof PDFDocument>;

/** 1行を描く（draw=false なら高さだけ測る） */
function layoutRow(doc: Doc, row: ReceiptRow, y: number, draw: boolean): number {
  if (row.type === 'space') return SPACE_HEIGHT;
  if (row.type === 'rule') {
    if (draw) {
      const mid = y + RULE_HEIGHT / 2;
      doc.lineWidth(0.6).moveTo(MARGIN, mid).lineTo(PAGE_WIDTH - MARGIN, mid).stroke();
      if (row.style === 'double') doc.moveTo(MARGIN, mid + 2).lineTo(PAGE_WIDTH - MARGIN, mid + 2).stroke();
    }
    return RULE_HEIGHT;
  }
  const size = FONT_SIZE[row.size ?? 'normal'];
  doc.font(row.bold ? 'bold' : 'regular').fontSize(size);
  const x = MARGIN + (row.indent ?? 0) * INDENT;
  const width = PAGE_WIDTH - MARGIN - x;

  if (row.type === 'pair') {
    const rightWidth = doc.widthOfString(row.right);
    const leftWidth = Math.max(10, width - rightWidth - 6);
    const height = Math.max(doc.heightOfString(row.left, { width: leftWidth }), size * 1.2);
    if (draw) {
      doc.text(row.left, x, y, { width: leftWidth, lineGap: 0 });
      doc.text(row.right, PAGE_WIDTH - MARGIN - rightWidth, y, { lineBreak: false });
    }
    return height + LINE_GAP;
  }

  const height = doc.heightOfString(row.text, { width });
  if (draw) doc.text(row.text, x, y, { width, align: row.align ?? 'left' });
  return height + LINE_GAP;
}

function newDoc(height: number) {
  const { regular, bold } = loadFonts();
  const doc = new PDFDocument({ size: [PAGE_WIDTH, height], margin: 0, autoFirstPage: true, info: { Title: 'レシート' } });
  doc.registerFont('regular', regular);
  doc.registerFont('bold', bold);
  return doc;
}

export function renderReceiptPdf(rows: ReceiptRow[], title: string): Promise<Buffer> {
  // 1回目で高さを測り、ちょうどの長さの紙にしてから描く
  const measure = newDoc(1000);
  const height = rows.reduce((h, row) => h + layoutRow(measure, row, h, false), MARGIN) + MARGIN;
  measure.end();

  const doc = newDoc(Math.max(height, 100));
  doc.info.Title = title;
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  let y = MARGIN;
  for (const row of rows) y += layoutRow(doc, row, y, true);
  doc.end();
  return done;
}
