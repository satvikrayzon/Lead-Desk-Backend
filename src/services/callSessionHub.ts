import { Response } from 'express';
import { randomUUID } from 'crypto';

export interface ActiveCallSession {
  id: string;
  agentId: string;
  leadId: string;
  leadName: string;
  phoneNumber: string;
  startedAt: string;
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
}): ActiveCallSession {
  const session: ActiveCallSession = {
    id: randomUUID(),
    agentId: params.agentId,
    leadId: params.leadId,
    leadName: params.leadName,
    phoneNumber: params.phoneNumber,
    startedAt: new Date().toISOString(),
  };
  activeByAgent.set(params.agentId, session);
  broadcast(params.agentId, 'call_started', session);
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
    writeEvent(res, 'call_started', active);
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
