import { UserRole } from '../types/enums';

/** Maps DB roles to the names used by the Flutter app. */
export function toApiRole(role: string): string {
  switch (role) {
    case 'agent':
      return 'telecaller';
    case 'manager':
      return 'team_leader';
    case 'admin':
      return 'admin';
    case 'telecaller':
    case 'team_leader':
      return role;
    default:
      return role;
  }
}

/** Maps Flutter/API role names to DB storage. */
export function fromApiRole(role: string): UserRole {
  switch (role) {
    case 'telecaller':
    case 'agent':
      return 'agent';
    case 'team_leader':
    case 'manager':
      return 'manager';
    case 'admin':
      return 'admin';
    default:
      return 'agent';
  }
}
