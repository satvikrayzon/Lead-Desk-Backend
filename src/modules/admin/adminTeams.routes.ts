import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Team, User } from '../../models';
import { AuthRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { createAuditLog } from '../../utils/helpers';
import { formatTeam } from '../../utils/teamFormat';

export const adminTeamsRouter = Router();

const createTeamSchema = z.object({
  name: z.string().min(1),
  team_leader_id: z.string().nullable().optional(),
});

const updateTeamSchema = z.object({
  name: z.string().min(1).optional(),
  team_leader_id: z.string().nullable().optional(),
});

const membersSchema = z.object({
  user_ids: z.array(z.string().min(1)).min(1),
});

async function loadTeamPayload(teamId: string) {
  const team = await Team.findById(teamId);
  if (!team) throw new AppError(404, 'Team not found.');

  const [members, leader] = await Promise.all([
    User.find({ teamId: team._id, isActive: true }).sort({ name: 1 }),
    team.teamLeaderId ? User.findById(team.teamLeaderId) : null,
  ]);

  return formatTeam(team, members, leader);
}

adminTeamsRouter.get('/', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const teams = await Team.find().sort({ name: 1 });
    const data = await Promise.all(teams.map((t) => loadTeamPayload(t._id.toString())));
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

adminTeamsRouter.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = createTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
    }

    const body = parsed.data;
    if (body.team_leader_id) {
      const leader = await User.findById(body.team_leader_id);
      if (!leader) throw new AppError(400, 'Team leader not found.');
    }

    const team = await Team.create({
      name: body.name.trim(),
      teamLeaderId: body.team_leader_id || undefined,
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'admin.team.created',
      entityType: 'team',
      entityId: team._id.toString(),
      ipAddress: req.ip,
    });

    res.status(201).json({ data: await loadTeamPayload(team._id.toString()) });
  } catch (err) {
    next(err);
  }
});

adminTeamsRouter.patch('/:teamId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = updateTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
    }

    const team = await Team.findById(req.params.teamId);
    if (!team) throw new AppError(404, 'Team not found.');

    const body = parsed.data;
    if (body.name !== undefined) team.name = body.name.trim();

    if (body.team_leader_id !== undefined) {
      if (!body.team_leader_id) {
        team.teamLeaderId = undefined;
      } else {
        const leader = await User.findById(body.team_leader_id);
        if (!leader) throw new AppError(400, 'Team leader not found.');
        team.teamLeaderId = leader._id;
      }
    }

    await team.save();

    if (body.name !== undefined) {
      await User.updateMany({ teamId: team._id }, { $set: { teamName: team.name } });
    }

    await createAuditLog({
      userId: req.user!.id,
      action: 'admin.team.updated',
      entityType: 'team',
      entityId: team._id.toString(),
      ipAddress: req.ip,
    });

    res.json({ data: await loadTeamPayload(team._id.toString()) });
  } catch (err) {
    next(err);
  }
});

adminTeamsRouter.post('/:teamId/members', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = membersSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((i) => i.message).join('; '));
    }

    const team = await Team.findById(req.params.teamId);
    if (!team) throw new AppError(404, 'Team not found.');

    const users = await User.find({ _id: { $in: parsed.data.user_ids } });
    if (users.length !== parsed.data.user_ids.length) {
      throw new AppError(400, 'One or more users were not found.');
    }

    await User.updateMany(
      { _id: { $in: parsed.data.user_ids } },
      { $set: { teamId: team._id, teamName: team.name } }
    );

    await createAuditLog({
      userId: req.user!.id,
      action: 'admin.team.members_added',
      entityType: 'team',
      entityId: team._id.toString(),
      metadata: { userIds: parsed.data.user_ids },
      ipAddress: req.ip,
    });

    res.json({ data: await loadTeamPayload(team._id.toString()) });
  } catch (err) {
    next(err);
  }
});

adminTeamsRouter.delete(
  '/:teamId/members/:userId',
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const team = await Team.findById(req.params.teamId);
      if (!team) throw new AppError(404, 'Team not found.');

      const user = await User.findById(req.params.userId);
      if (!user || user.teamId?.toString() !== team._id.toString()) {
        throw new AppError(404, 'User is not a member of this team.');
      }

      user.teamId = undefined;
      user.teamName = undefined;
      await user.save();

      if (team.teamLeaderId?.toString() === user._id.toString()) {
        team.teamLeaderId = undefined;
        await team.save();
      }

      await createAuditLog({
        userId: req.user!.id,
        action: 'admin.team.member_removed',
        entityType: 'team',
        entityId: team._id.toString(),
        metadata: { userId: user._id.toString() },
        ipAddress: req.ip,
      });

      res.json({ data: await loadTeamPayload(team._id.toString()) });
    } catch (err) {
      next(err);
    }
  }
);
