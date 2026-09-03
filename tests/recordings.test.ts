import request from 'supertest';
import { createApp } from '../src/app';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { User, Lead, LeadAssignment, CallRecording, AuditLog } from '../src/models';
import bcrypt from 'bcrypt';

jest.mock('../src/config/s3', () => ({
  s3Client: {},
  uploadToS3: jest.fn().mockResolvedValue(undefined),
  deleteFromS3: jest.fn().mockResolvedValue(undefined),
  getPresignedUrl: jest.fn().mockResolvedValue({
    url: 'https://example.com/presigned',
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  }),
  checkS3Connection: jest.fn().mockResolvedValue(true),
}));

const app = createApp();

describe('Recording upload', () => {
  let agent1Token: string;
  let agent2Token: string;
  let agent1Id: string;
  let leadId: string;
  let assignmentId: string;
  const callStartTime = '2026-09-01T10:30:00.000Z';

  beforeAll(async () => {
    await connectDatabase();
    const passwordHash = await bcrypt.hash('Agent@123', 12);

    const agent1 = await User.findOneAndUpdate(
      { email: 'rec-test-agent1@company.com' },
      {
        name: 'Rec Test Agent 1',
        email: 'rec-test-agent1@company.com',
        username: 'rectestagent1',
        passwordHash,
        role: 'agent',
        isActive: true,
      },
      { upsert: true, new: true }
    );
    agent1Id = agent1!._id.toString();

    await User.findOneAndUpdate(
      { email: 'rec-test-agent2@company.com' },
      {
        name: 'Rec Test Agent 2',
        email: 'rec-test-agent2@company.com',
        username: 'rectestagent2',
        passwordHash,
        role: 'agent',
        isActive: true,
      },
      { upsert: true, new: true }
    );

    const lead = await Lead.create({
      name: 'Recording Test Lead',
      phoneNumber: '+919990000099',
      company: 'Rec Co',
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
      .send({ username: 'rec-test-agent1@company.com', password: 'Agent@123' });
    agent1Token = login1.body.token;

    const login2 = await request(app)
      .post('/api/auth/login')
      .send({ username: 'rec-test-agent2@company.com', password: 'Agent@123' });
    agent2Token = login2.body.token;
  });

  afterAll(async () => {
    await CallRecording.deleteMany({ leadId });
    await AuditLog.deleteMany({ entityId: leadId });
    await LeadAssignment.deleteOne({ _id: assignmentId });
    await Lead.deleteOne({ _id: leadId });
    await User.deleteMany({
      email: { $in: ['rec-test-agent1@company.com', 'rec-test-agent2@company.com'] },
    });
    await disconnectDatabase();
  });

  const uploadPayload = () => ({
    lead_id: leadId,
    phone_number: '+919990000099',
    call_start_time: callStartTime,
    call_end_time: '2026-09-01T10:35:22.000Z',
    duration_seconds: '322',
    source: 'miuiNative',
  });

  it('uploads recording successfully', async () => {
    const res = await request(app)
      .post('/api/recordings')
      .set('Authorization', `Bearer ${agent1Token}`)
      .field(uploadPayload())
      .attach('recording', Buffer.from('fake audio content'), {
        filename: 'test.m4a',
        contentType: 'audio/mp4',
      });

    expect(res.status).toBe(200);
    expect(res.body.recording_id).toBeDefined();
    expect(res.body.id).toBe(res.body.recording_id);
  });

  it('deduplicates retry uploads', async () => {
    const res = await request(app)
      .post('/api/recordings')
      .set('Authorization', `Bearer ${agent1Token}`)
      .field(uploadPayload())
      .attach('recording', Buffer.from('fake audio content'), {
        filename: 'test.m4a',
        contentType: 'audio/mp4',
      });

    expect(res.status).toBe(200);

    const count = await CallRecording.countDocuments({
      agentId: agent1Id,
      leadId,
      phoneNumber: '+919990000099',
    });
    expect(count).toBe(1);
  });

  it('rejects upload for unassigned lead', async () => {
    const res = await request(app)
      .post('/api/recordings')
      .set('Authorization', `Bearer ${agent2Token}`)
      .field(uploadPayload())
      .attach('recording', Buffer.from('fake audio content'), {
        filename: 'test.m4a',
        contentType: 'audio/mp4',
      });

    expect(res.status).toBe(403);
    expect(res.body.message).toBeDefined();
  });

  it('returns presigned URL for recording', async () => {
    const recording = await CallRecording.findOne({ leadId, agentId: agent1Id });

    const res = await request(app)
      .get(`/api/recordings/${recording!._id.toString()}`)
      .set('Authorization', `Bearer ${agent1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.url).toBeDefined();
    expect(res.body.expires_at).toBeDefined();
  });
});
