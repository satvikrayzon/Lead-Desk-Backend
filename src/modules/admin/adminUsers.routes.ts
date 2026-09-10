import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Team, User } from '../../models';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { createAuditLog } from '../../utils/helpers';
import { hashPassword } from '../../utils/password';
import { fromApiRole } from '../../utils/roleMapping';
import { formatUser } from '../../utils/userFormat';
import { wipeTelecallerTestData } from '../../services/wipeTelecallerService';

export const adminUsersRouter = Router();

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
  role: z.string().optional(),
  team_id: z.string().nullable().optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  role: z.string().optional(),
  team_id: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  password: z.string().min(6).optional(),
});

async function resolveTeamAssignment(teamId?: string | null) {
  if (!teamId) return { teamId: undefined, teamName: undefined };
  const team = await Team.findById(teamId);
  if (!team) throw new AppError(400, 'Team not found.');
  return { teamId: team._id, teamName: team.name };
}

adminUsersRouter.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.role && typeof req.query.role === 'string') {
      filter.role = fromApiRole(req.query.role);
    }

    const users = await User.find(filter).sort({ name: 1 });
    res.json({ data: users.map(formatUser) });
  } catch (err) {
    next(err);
  }
});

adminUsersRouter.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
    }

    const body = parsed.data;
    const email = body.email.toLowerCase().trim();
    const existing = await User.findOne({ email });
    if (existing) throw new AppError(409, 'A user with this email already exists.');

    const teamAssignment = await resolveTeamAssignment(body.team_id);
    const user = await User.create({
      name: body.name.trim(),
      email,
      passwordHash: await hashPassword(body.password),
      phone: body.phone?.trim() || undefined,
      role: fromApiRole(body.role ?? 'telecaller'),
      teamId: teamAssignment.teamId,
      teamName: teamAssignment.teamName,
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'admin.user.created',
      entityType: 'user',
      entityId: user._id.toString(),
      metadata: { email: user.email, role: user.role },
      ipAddress: req.ip,
    });

    res.status(201).json({ data: formatUser(user) });
  } catch (err) {
    next(err);
  }
});

adminUsersRouter.patch('/:userId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
    }

    const user = await User.findById(req.params.userId);
    if (!user) throw new AppError(404, 'User not found.');

    const body = parsed.data;
    if (body.name !== undefined) user.name = body.name.trim();
    if (body.phone !== undefined) user.phone = body.phone.trim() || undefined;
    if (body.role !== undefined) user.role = fromApiRole(body.role);
    if (body.is_active !== undefined) user.isActive = body.is_active;
    if (body.password) user.passwordHash = await hashPassword(body.password);

    if (body.team_id !== undefined) {
      if (!body.team_id) {
        user.teamId = undefined;
        user.teamName = undefined;
      } else {
        const teamAssignment = await resolveTeamAssignment(body.team_id);
        user.teamId = teamAssignment.teamId;
        user.teamName = teamAssignment.teamName;
      }
    }

    await user.save();

    await createAuditLog({
      userId: req.user!.id,
      action: 'admin.user.updated',
      entityType: 'user',
      entityId: user._id.toString(),
      ipAddress: req.ip,
    });

    res.json({ data: formatUser(user) });
  } catch (err) {
    next(err);
  }
});

adminUsersRouter.delete('/:userId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) throw new AppError(404, 'User not found.');

    if (user._id.toString() === req.user!.id) {
      throw new AppError(400, 'You cannot deactivate your own account.');
    }

    user.isActive = false;
    await user.save();

    await createAuditLog({
      userId: req.user!.id,
      action: 'admin.user.deactivated',
      entityType: 'user',
      entityId: user._id.toString(),
      ipAddress: req.ip,
    });

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

/**
 * Wipe test telecaller data: activity + assignments (+ orphan leads), then deactivate.
 * Body: { confirm: true, delete_orphan_leads?: boolean }
 */
adminUsersRouter.post('/:userId/wipe-test-data', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = String(req.params.userId || '');
    if (userId === req.user!.id) {
      throw new AppError(400, 'You cannot wipe your own account.');
    }
    const confirm = req.body?.confirm === true;
    if (!confirm) {
      throw new AppError(400, 'Pass { "confirm": true } to wipe this user.');
    }
    const deleteOrphanLeads = req.body?.delete_orphan_leads !== false;

    const result = await wipeTelecallerTestData({ userId, deleteOrphanLeads });

    await createAuditLog({
      userId: req.user!.id,
      action: 'admin.user.wipe_test_data',
      entityType: 'user',
      entityId: userId,
      metadata: result as unknown as Record<string, unknown>,
      ipAddress: req.ip,
    });

    res.json({ data: result });
  } catch (err) {
    if (err instanceof Error && err.message === 'User not found') {
      return next(new AppError(404, err.message));
    }
    if (err instanceof Error && err.message === 'Invalid user id') {
      return next(new AppError(400, err.message));
    }
    next(err);
  }
});
