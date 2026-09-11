import { Response } from 'express';
import { randomUUID } from 'crypto';

export interface ActiveCallSession {
  id: string;
  agentId: string;
  leadId: string;
  leadName: string;
  phoneNumber: string;
  startedAt: string;
  /** `incoming` = lead called the telecaller; desktop should open the form. */
  direction: 'incoming' | 'outgoing';
}

/** In-memory active call per agent + SSE subscribers for desktop sync. */
const activeByAgent = new Map<string, ActiveCallSession>();
const subscribersByAgent = new Map<string, Set<Response>>();

function subscriberSet(agentId: string): Set<Response> {
  let set = subscribersByAgent.get(agentId);
  if (!set) {
    set = new Set();
    subscribersByAgent.set(agentId, set);
  }
  return set;
}

export function startCallSession(params: {
  agentId: string;
  leadId: string;
  leadName: string;
  phoneNumber: string;
  direction?: 'incoming' | 'outgoing';
}): ActiveCallSession {
  const session: ActiveCallSession = {
    id: randomUUID(),
    agentId: params.agentId,
    leadId: params.leadId,
    leadName: params.leadName,
    phoneNumber: params.phoneNumber,
    startedAt: new Date().toISOString(),
    direction: params.direction === 'incoming' ? 'incoming' : 'outgoing',
  };
  activeByAgent.set(params.agentId, session);
  broadcast(params.agentId, 'call_started', {
    id: session.id,
    agent_id: session.agentId,
    lead_id: session.leadId,
    lead_name: session.leadName,
    phone_number: session.phoneNumber,
    started_at: session.startedAt,
    direction: session.direction,
  });
  return session;
}

export function endCallSession(agentId: string): ActiveCallSession | null {
  const session = activeByAgent.get(agentId) ?? null;
  if (!session) return null;
  activeByAgent.delete(agentId);
  broadcast(agentId, 'call_ended', { session_id: session.id, lead_id: session.leadId });
  return session;
}

export function getActiveCallSession(agentId: string): ActiveCallSession | null {
  return activeByAgent.get(agentId) ?? null;
}

export function subscribe(agentId: string, res: Response): void {
  const set = subscriberSet(agentId);
  set.add(res);

  res.on('close', () => {
    set.delete(res);
    if (set.size === 0) subscribersByAgent.delete(agentId);
  });

  // Tell the desktop client we're connected.
  writeEvent(res, 'connected', { agent_id: agentId });

  const active = activeByAgent.get(agentId);
  if (active) {
    writeEvent(res, 'call_started', {
      id: active.id,
      agent_id: active.agentId,
      lead_id: active.leadId,
      lead_name: active.leadName,
      phone_number: active.phoneNumber,
      started_at: active.startedAt,
      direction: active.direction,
    });
  }
}

export function broadcastToAgent(agentId: string, event: string, data: unknown): void {
  broadcast(agentId, event, data);
}

function broadcast(agentId: string, event: string, data: unknown): void {
  const set = subscribersByAgent.get(agentId);
  if (!set) return;
  for (const res of set) {
    writeEvent(res, event, data);
  }
}

function writeEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
