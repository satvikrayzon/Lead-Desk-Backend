import request from 'supertest';
import { createApp } from '../src/app';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { User, Lead, LeadAssignment, CallRecording, AuditLog } from '../src/models';
import bcrypt from 'bcrypt';

const app = createApp();

describe('Lead access control', () => {
  let agent1Token: string;
  let agent2Token: string;
  let agent1Id: string;
  let agent2Id: string;
  let leadId: string;
  let assignmentId: string;

  beforeAll(async () => {
    await connectDatabase();
    const passwordHash = await bcrypt.hash('Agent@123', 12);

    const agent1 = await User.findOneAndUpdate(
      { email: 'lead-test-agent1@company.com' },
      {
        name: 'Lead Test Agent 1',
        email: 'lead-test-agent1@company.com',
        username: 'leadtestagent1',
        passwordHash,
        role: 'agent',
        isActive: true,
      },
      { upsert: true, new: true }
    );
    agent1Id = agent1!._id.toString();

    const agent2 = await User.findOneAndUpdate(
      { email: 'lead-test-agent2@company.com' },
      {
        name: 'Lead Test Agent 2',
        email: 'lead-test-agent2@company.com',
        username: 'leadtestagent2',
        passwordHash,
        role: 'agent',
        isActive: true,
      },
      { upsert: true, new: true }
    );
    agent2Id = agent2!._id.toString();

    const lead = await Lead.create({
      name: 'Test Lead',
      phoneNumber: '+919990000001',
      company: 'Test Co',
      status: 'new',
    });
    leadId = lead._id.toString();

    const assignment = await LeadAssignment.create({
      leadId: lead._id,
      agentId: agent1!._id,
      isActive: true,
    });
    assignmentId = assignment._id.toString();

    const login1 = await request(app)
      .post('/api/auth/login')
      .send({ username: 'lead-test-agent1@company.com', password: 'Agent@123' });
    agent1Token = login1.body.token;

    const login2 = await request(app)
      .post('/api/auth/login')
      .send({ username: 'lead-test-agent2@company.com', password: 'Agent@123' });
    agent2Token = login2.body.token;
  });

  afterAll(async () => {
    await CallRecording.deleteMany({ leadId });
    await AuditLog.deleteMany({
      entityId: { $in: [leadId, agent1Id, agent2Id] },
    });
    await LeadAssignment.deleteOne({ _id: assignmentId });
    await Lead.deleteOne({ _id: leadId });
    await User.deleteMany({
      email: { $in: ['lead-test-agent1@company.com', 'lead-test-agent2@company.com'] },
    });
    await disconnectDatabase();
  });

  it('agent sees only assigned leads', async () => {
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${agent1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    const ids = res.body.data.map((l: { id: string }) => l.id);
    expect(ids).toContain(leadId);
  });

  it('agent2 cannot see agent1 assigned lead in their list', async () => {
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${agent2Token}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((l: { id: string }) => l.id);
    expect(ids).not.toContain(leadId);
  });

  it('agent can update assigned lead', async () => {
    const res = await request(app)
      .patch(`/api/leads/${leadId}`)
      .set('Authorization', `Bearer ${agent1Token}`)
      .send({ status: 'interested', notes: 'Test note' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('interested');
    expect(res.body.notes).toBe('Test note');
  });

  it('agent2 cannot update lead assigned to agent1', async () => {
    const res = await request(app)
      .patch(`/api/leads/${leadId}`)
      .set('Authorization', `Bearer ${agent2Token}`)
      .send({ status: 'not_interested' });

    expect(res.status).toBe(403);
    expect(res.body.message).toBeDefined();
  });

  it('returns 400 for invalid status', async () => {
    const res = await request(app)
      .patch(`/api/leads/${leadId}`)
      .set('Authorization', `Bearer ${agent1Token}`)
      .send({ status: 'invalid_status' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid status value.');
  });
});
