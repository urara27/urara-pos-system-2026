import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditLogQuery, REPORT_CSV_KINDS, reportQuery } from '@pos/shared';
import { parse } from '../../lib/errors.js';
import type { Guards } from '../auth/guards.js';
import { buildReportCsv, csvFileName } from './csv.js';
import type { ReportService } from './service.js';

const csvParams = z.object({ kind: z.enum(REPORT_CSV_KINDS) });

/** 売上確認・レジ精算・操作ログ（管理者ログイン必須） */
export function reportRoutes(app: FastifyInstance, reports: ReportService, guards: Guards) {
  app.addHook('preHandler', guards.requireAdmin);

  app.get('/api/admin/reports/sales', async (req) => {
    const { from, to } = parse(reportQuery, req.query);
    return reports.salesReport(from, to);
  });

  app.get('/api/admin/reports/settlements', async (req) => {
    const { from, to } = parse(reportQuery, req.query);
    return { settlements: reports.settlements(from, to) };
  });

  app.get('/api/admin/reports/:kind.csv', async (req, reply) => {
    const { kind } = parse(csvParams, req.params);
    const { from, to } = parse(reportQuery, req.query);
    const csv = buildReportCsv(reports, kind, from, to);
    const storeCode = reports.salesReport(from, from).storeCode;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${csvFileName(storeCode, kind, from, to)}"`)
      .send(csv);
  });

  app.get('/api/admin/audit-logs', async (req) => reports.auditLogs(parse(auditLogQuery, req.query)));
}
