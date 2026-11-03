import { eq } from 'drizzle-orm';
import { buildReceiptLayout, renderReceiptText, type ReceiptDocument, type ReceiptRow } from '@pos/shared';
import type { Db } from '../../db/client.js';
import { registers, transactions } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { writeAudit } from '../audit/service.js';
import type { PrinterRegistry, PrintResult } from './driver.js';
import { renderReceiptPdf } from './pdf.js';
import { buildReceiptDocument } from './receipt-document.js';

export interface ReceiptView {
  document: ReceiptDocument;
  rows: ReceiptRow[];
  /** 等幅テキスト（80mm・48桁）。ESC/POS 実装時の確認用 */
  text: string;
}

/** レシートの組み立て・プレビュー・PDF・印刷（ドライバー経由）とドロアの開放 */
export class PrintingService {
  constructor(
    private readonly db: Db,
    private readonly printers: PrinterRegistry,
  ) {}

  receipt(transactionId: number, reprint: boolean): ReceiptView {
    const document = buildReceiptDocument(this.db, transactionId, { reprint });
    const rows = buildReceiptLayout(document);
    return { document, rows, text: renderReceiptText(rows) };
  }

  async pdf(transactionId: number, reprint: boolean) {
    const { document, rows } = this.receipt(transactionId, reprint);
    const title = `${reprint ? '【再発行】' : ''}レシート ${document.receiptNumber}`;
    return { buffer: await renderReceiptPdf(rows, title), receiptNumber: document.receiptNumber };
  }

  private driverForTransaction(transactionId: number) {
    const row = this.db
      .select({ printerId: registers.printerId })
      .from(transactions)
      .innerJoin(registers, eq(registers.id, transactions.registerId))
      .where(eq(transactions.id, transactionId))
      .get();
    if (!row) throw notFound('取引が見つかりません');
    return this.printers.driverFor(row.printerId);
  }

  /** 会計直後のレシート印刷 */
  async printReceipt(transactionId: number): Promise<PrintResult> {
    const view = this.receipt(transactionId, false);
    return this.driverForTransaction(transactionId).print(view);
  }

  /** 再発行。「再発行」と明記したレシートを出し、操作ログに残す */
  async reprint(transactionId: number, actor: { employeeId: number; deviceId: number | null }) {
    const view = this.receipt(transactionId, true);
    writeAudit(this.db, {
      action: 'receipt.reprinted',
      employeeId: actor.employeeId,
      deviceId: actor.deviceId,
      targetType: 'transaction',
      targetId: transactionId,
      after: { receiptNumber: view.document.receiptNumber },
    });
    const result = await this.driverForTransaction(transactionId).print(view);
    return { ...view, result };
  }

  /** 現金会計のときにドロアを開く */
  async openDrawer(transactionId: number) {
    await this.driverForTransaction(transactionId).openDrawer();
  }
}
