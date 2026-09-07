import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthRequest, requireRoles } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { getCompanySettings } from '../../models/CompanySettings';
import { createAuditLog } from '../../utils/helpers';

export const companySettingsRouter = Router();

const patchSchema = z.object({
  auto_next_call_delay_seconds: z.number().int().min(0).max(300),
});

function formatSettings(doc: { autoNextCallDelaySeconds: number }) {
  return {
    auto_next_call_delay_seconds: doc.autoNextCallDelaySeconds,
  };
}

/** Any authenticated user can read company calling settings. */
companySettingsRouter.get('/', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const doc = await getCompanySettings();
    res.json({ data: formatSettings(doc) });
  } catch (err) {
    next(err);
  }
});

/** Admin/manager can update settings. */
companySettingsRouter.patch(
  '/',
  requireRoles('admin', 'manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
      }

      const doc = await getCompanySettings();
      doc.autoNextCallDelaySeconds = parsed.data.auto_next_call_delay_seconds;
      await doc.save();

      await createAuditLog({
        userId: req.user!.id,
        action: 'company_settings.updated',
        entityType: 'company_settings',
        entityId: doc._id.toString(),
        metadata: { autoNextCallDelaySeconds: doc.autoNextCallDelaySeconds },
        ipAddress: req.ip,
      });

      res.json({ data: formatSettings(doc) });
    } catch (err) {
      next(err);
    }
  }
);
