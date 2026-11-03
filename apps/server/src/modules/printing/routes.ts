import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/errors.js';
import type { Guards } from '../auth/guards.js';
import type { PrintingService } from './service.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const reprintQuery = z.object({ reprint: z.enum(['0', '1']).default('0') });

/** レシートのプレビュー・PDF・再発行。レジのスタッフと管理者が使う */
export function printingRoutes(app: FastifyInstance, printing: PrintingService, guards: Guards) {
  const opts = { preHandler: guards.requireStaffOrAdmin };

  app.get('/api/transactions/:id/receipt', opts, async (req) => {
    const { id } = parse(idParams, req.params);
    const { reprint } = parse(reprintQuery, req.query);
    return printing.receipt(id, reprint === '1');
  });

  app.get('/api/transactions/:id/receipt.pdf', opts, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { reprint } = parse(reprintQuery, req.query);
    const { buffer, receiptNumber } = await printing.pdf(id, reprint === '1');
    const name = `receipt-${receiptNumber}${reprint === '1' ? '-reprint' : ''}.pdf`;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${name}"`)
      .send(buffer);
  });

  app.post('/api/transactions/:id/reprint', opts, async (req) => {
    const { id } = parse(idParams, req.params);
    return printing.reprint(id, { employeeId: req.session!.employee.id, deviceId: req.device?.id ?? null });
  });
}
