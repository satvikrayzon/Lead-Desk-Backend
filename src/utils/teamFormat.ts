import { ITeam } from '../models/Team';
import { IUser } from '../models/User';
import { toApiRole } from './roleMapping';

export function formatTeam(team: ITeam, members: IUser[], leader: IUser | null) {
  return {
    id: team._id.toString(),
    name: team.name,
    team_leader_id: team.teamLeaderId?.toString() ?? null,
    team_leader: leader
      ? { id: leader._id.toString(), name: leader.name, email: leader.email }
      : null,
    members: members.map((m) => ({
      id: m._id.toString(),
      name: m.name,
      email: m.email,
      role: toApiRole(m.role),
    })),
  };
}
