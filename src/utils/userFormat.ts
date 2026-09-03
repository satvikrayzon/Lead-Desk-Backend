import { IUser } from '../models/User';
import { toApiRole } from './roleMapping';

export function formatUser(user: IUser) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    role: toApiRole(user.role),
    team_id: user.teamId?.toString() ?? null,
    team_name: user.teamName ?? null,
    is_active: user.isActive,
  };
}
