import bcrypt from 'bcrypt';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { User } from '../models';

const BCRYPT_ROUNDS = 12;

async function main() {
  await connectDatabase();
  console.log('Seeding database...');

  const adminPassword = await bcrypt.hash('Rayzon@#2026', BCRYPT_ROUNDS);

  await User.findOneAndUpdate(
    { email: 'admin@rayzon.com' },
    {
      $set: {
        name: 'System Admin',
        email: 'admin@rayzon.com',
        username: 'admin',
        passwordHash: adminPassword,
        role: 'admin',
      },
    },
    { upsert: true, new: true }
  );

  console.log('Seed completed.');
  console.log('');
  console.log('Dev credentials:');
  console.log('  Admin: admin@rayzon.com / Rayzon@#2026');

  await disconnectDatabase();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectDatabase();
  process.exit(1);
});
