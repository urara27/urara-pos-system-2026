import type { FastifyBaseLogger } from 'fastify';
import type { ReceiptDocument, ReceiptRow } from '@pos/shared';

/**
 * 印刷とキャッシュドロアの開放を、差し替え可能なドライバーとして扱う（要件3.7・4.4）。
 * プリンター導入までは DummyPrinterDriver（画面プレビュー・PDF のみ）で動かす。
 * 実機は LAN 接続のレシートプリンターへ ESC/POS で直接送るドライバーを追加する想定
 * （行は renderReceiptText と同じ考え方で倍角コマンドに変換できる）。
 */

export interface PrintJob {
  document: ReceiptDocument;
  rows: ReceiptRow[];
}

export interface PrintResult {
  driver: string;
  /** 紙に印刷したか（ダミーは常に false。画面プレビュー・PDF で確認する） */
  printed: boolean;
  message: string;
}

export interface PrinterDriver {
  readonly id: string;
  print(job: PrintJob): Promise<PrintResult>;
  /** キャッシュドロアを開く（一般にプリンター経由で開くので、ドライバーの機能に含める） */
  openDrawer(): Promise<void>;
}

export class DummyPrinterDriver implements PrinterDriver {
  readonly id = 'dummy';

  constructor(private readonly log: FastifyBaseLogger) {}

  async print(job: PrintJob): Promise<PrintResult> {
    this.log.info(
      { receiptNumber: job.document.receiptNumber, reprint: job.document.reprint },
      'ダミープリンター: レシートを受け付けました（印刷はしません）',
    );
    return { driver: this.id, printed: false, message: 'プリンター未導入のため、画面プレビューと PDF で確認してください' };
  }

  async openDrawer(): Promise<void> {
    this.log.info('ダミープリンター: キャッシュドロアを開く指示を受け付けました（ドロア未導入）');
  }
}

/**
 * レジごとに使うドライバーを決める。registers.printer_id に将来プリンターを割り当てる。
 * 今はどのレジもダミー。
 */
export class PrinterRegistry {
  private readonly dummy: DummyPrinterDriver;

  constructor(log: FastifyBaseLogger) {
    this.dummy = new DummyPrinterDriver(log);
  }

  driverFor(_printerId: string | null): PrinterDriver {
    return this.dummy;
  }
}
