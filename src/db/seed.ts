import bcrypt from 'bcrypt';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { User, Lead, LeadAssignment } from '../models';

const BCRYPT_ROUNDS = 12;

const sampleLeads = [
  { name: 'John Doe', phoneNumber: '+919876543210', company: 'Acme Corp', status: 'new' as const },
  { name: 'Jane Smith', phoneNumber: '+919876543211', company: 'Beta Ltd', status: 'interested' as const },
  { name: 'Raj Patel', phoneNumber: '+919876543212', company: 'Gamma Inc', status: 'follow_up' as const },
  { name: 'Priya Sharma', phoneNumber: '+919876543213', company: 'Delta Co', status: 'not_reachable' as const },
  { name: 'Amit Kumar', phoneNumber: '+919876543214', company: 'Epsilon LLC', status: 'new' as const },
  { name: 'Sneha Reddy', phoneNumber: '+919876543215', company: 'Zeta Systems', status: 'interested' as const },
  { name: 'Vikram Singh', phoneNumber: '+919876543216', company: 'Eta Solutions', status: 'new' as const },
  { name: 'Anita Desai', phoneNumber: '+919876543217', company: 'Theta Group', status: 'not_interested' as const },
  { name: 'Rahul Mehta', phoneNumber: '+919876543218', company: 'Iota Tech', status: 'converted' as const },
  { name: 'Kavita Nair', phoneNumber: '+919876543219', company: 'Kappa Services', status: 'new' as const },
];

async function upsertUser(data: {
  name: string;
  email: string;
  username: string;
  passwordHash: string;
  role: 'agent' | 'manager' | 'admin';
  teamName?: string;
}) {
  return User.findOneAndUpdate(
    { email: data.email },
    { $set: data },
    { upsert: true, new: true }
  );
}

async function main() {
  await connectDatabase();
  console.log('Seeding database...');

  const adminPassword = await bcrypt.hash('Admin@123', BCRYPT_ROUNDS);
  const agentPassword = await bcrypt.hash('Agent@123', BCRYPT_ROUNDS);

  const admin = await upsertUser({
    name: 'System Admin',
    email: 'admin@company.com',
    username: 'admin',
    passwordHash: adminPassword,
    role: 'admin',
  });

  const manager = await upsertUser({
    name: 'Sales Manager',
    email: 'manager@company.com',
    username: 'manager',
    passwordHash: agentPassword,
    role: 'manager',
  });

  const agent1 = await upsertUser({
    name: 'Nistha Lakhani',
    email: 'agent1@company.com',
    username: 'agent1',
    passwordHash: agentPassword,
    role: 'agent',
    teamName: 'TL 1',
  });

  const agent2 = await upsertUser({
    name: 'Agent Two',
    email: 'agent2@company.com',
    username: 'agent2',
    passwordHash: agentPassword,
    role: 'agent',
    teamName: 'TL 2',
  });

  const leads = [];
  for (const leadData of sampleLeads) {
    let lead = await Lead.findOne({ phoneNumber: leadData.phoneNumber });
    if (!lead) {
      lead = await Lead.create(leadData);
    }
    leads.push(lead);
  }

  for (let i = 0; i < leads.length; i++) {
    const agentId = i < 5 ? agent1!._id : agent2!._id;
    const existing = await LeadAssignment.findOne({
      leadId: leads[i]._id,
      agentId,
      isActive: true,
    });
    if (!existing) {
      await LeadAssignment.create({
        leadId: leads[i]._id,
        agentId,
        assignedBy: manager!._id,
        isActive: true,
      });
    }
  }

  console.log('Seed completed.');
  console.log('');
  console.log('Dev credentials:');
  console.log('  Admin:   admin@company.com / Admin@123');
  console.log('  Manager: manager@company.com / Agent@123');
  console.log('  Agent 1: agent1@company.com / Agent@123');
  console.log('  Agent 2: agent2@company.com / Agent@123');

  await disconnectDatabase();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectDatabase();
  process.exit(1);
});
