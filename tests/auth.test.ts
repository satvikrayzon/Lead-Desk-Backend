import request from 'supertest';
import { createApp } from '../src/app';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { User, AuditLog } from '../src/models';
import bcrypt from 'bcrypt';

const app = createApp();

describe('Auth', () => {
  let agentUserId: string;

  beforeAll(async () => {
    await connectDatabase();
    const passwordHash = await bcrypt.hash('Agent@123', 12);
    const user = await User.findOneAndUpdate(
      { email: 'test-agent@company.com' },
      {
        name: 'Test Agent',
        email: 'test-agent@company.com',
        username: 'testagent',
        passwordHash,
        role: 'agent',
        isActive: true,
      },
      { upsert: true, new: true }
    );
    agentUserId = user!._id.toString();
  });

  afterAll(async () => {
    await AuditLog.deleteMany({ userId: agentUserId });
    await User.deleteMany({ email: 'test-agent@company.com' });
    await disconnectDatabase();
  });

  it('returns 401 for invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'test-agent@company.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid username or password.');
  });

  it('returns token and user on valid login', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'test-agent@company.com', password: 'Agent@123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toMatchObject({
      email: 'test-agent@company.com',
      role: 'agent',
    });
  });

  it('supports login with username field', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'testagent', password: 'Agent@123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });
});
