import { Router, Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import {
  buildDailySalesReport,
  buildDailySalesReportWorkbook,
  formatDailySalesReportText,
  parseReportRange,
} from '../../services/dailySalesReportService';
import { buildTelecallerPerformanceDashboard, listAgentCallHistory, buildPeerBenchmarks } from '../../services/telecallerPerformanceService';

export const meDashboardRouter = Router();

/** Logged-in agent's call history (server dials — required on Windows with no local DB). */
meDashboardRouter.get('/calls', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new AppError(401, 'Authentication required.');
    const parsed = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Math.min(500, Math.max(1, Number.isFinite(parsed) ? parsed : 150));
    const data = await listAgentCallHistory(userId, limit);
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

/** Logged-in telecaller / team leader personal performance dashboard. */
meDashboardRouter.get('/dashboard', async (req: AuthRequest, res: Response, next: NextFunction) => {
  const startedAt = Date.now();
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new AppError(401, 'Authentication required.');
    }

    const data = await buildTelecallerPerformanceDashboard(userId);
    console.log('[me/dashboard] ok', {
      userId,
      callsToday: data.summary.calls_today,
      ms: Date.now() - startedAt,
    });
    res.json({ data });
  } catch (err) {
    console.error('[me/dashboard] failed', {
      userId: req.user?.id,
      email: req.user?.email,
      err: err instanceof Error ? err.message : err,
      ms: Date.now() - startedAt,
    });
    if (err instanceof Error && err.message === 'Telecaller not found') {
      return next(new AppError(404, err.message));
    }
    next(err);
  }
});

/** Anonymized peer benchmarks (own vs team/company avg — no other names). */
meDashboardRouter.get('/dashboard/peer-benchmarks', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new AppError(401, 'Authentication required.');
    const data = await buildPeerBenchmarks(userId);
    res.json({ data });
  } catch (err) {
    if (err instanceof Error && err.message === 'Telecaller not found') {
      return next(new AppError(404, err.message));
    }
    next(err);
  }
});

/** Own Daily Sales Telecalling Report for a selected day. */
meDashboardRouter.get('/dashboard/sales-report', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new AppError(401, 'Authentication required.');
    const { rangeStart, rangeEndExclusive } = parseReportRange(req.query);
    const report = await buildDailySalesReport(userId, rangeStart, rangeEndExclusive);
    res.json({ data: report });
  } catch (err) {
    if (err instanceof Error && err.message === 'Telecaller not found') {
      return next(new AppError(404, err.message));
    }
    next(err);
  }
});

meDashboardRouter.get('/dashboard/sales-report/text', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new AppError(401, 'Authentication required.');
    const { rangeStart, rangeEndExclusive } = parseReportRange(req.query);
    const report = await buildDailySalesReport(userId, rangeStart, rangeEndExclusive);
    res.type('text/plain; charset=utf-8').send(formatDailySalesReportText(report));
  } catch (err) {
    if (err instanceof Error && err.message === 'Telecaller not found') {
      return next(new AppError(404, err.message));
    }
    next(err);
  }
});

meDashboardRouter.get('/dashboard/sales-report/export', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new AppError(401, 'Authentication required.');
    const { rangeStart, rangeEndExclusive, fromKey, toKey } = parseReportRange(req.query);
    const report = await buildDailySalesReport(userId, rangeStart, rangeEndExclusive);
    const buffer = await buildDailySalesReportWorkbook([report]);
    const stamp =
      fromKey === toKey
        ? fromKey.replace(/-/g, '')
        : `${fromKey.replace(/-/g, '')}_${toKey.replace(/-/g, '')}`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Daily_Sales_Report_${stamp}.xlsx"`
    );
    res.send(buffer);
  } catch (err) {
    if (err instanceof Error && err.message === 'Telecaller not found') {
      return next(new AppError(404, err.message));
    }
    next(err);
  }
});
