/**
 * Wipe a test telecaller's activity + assignments so they no longer affect
 * live admin dashboards. Deactivates the user account.
 *
 * Usage (on the server that has production Mongo):
 *   npx tsx scripts/wipeTestUser.ts --id=6a9ba1dd9cee711b431a8d28 --delete-leads
 *   npx tsx scripts/wipeTestUser.ts --email=satvik.rayzon@gmail.com --delete-leads
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { User } from '../src/models';
import { wipeTelecallerTestData } from '../src/services/wipeTelecallerService';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const email = (arg('email') || 'satvik.rayzon@gmail.com').trim().toLowerCase();
  const idArg = arg('id') || '6a9ba1dd9cee711b431a8d28';
  const deleteLeads = hasFlag('delete-leads') || !hasFlag('keep-leads');

  await mongoose.connect(env.MONGODB_URI);
  console.log('Connected:', env.MONGODB_URI.replace(/\/\/.*@/, '//***@'));

  let userId = idArg;
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    const byEmail = await User.findOne({
      email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    });
    if (!byEmail) {
      console.error('User not found for', { id: idArg, email });
      process.exitCode = 1;
      return;
    }
    userId = byEmail._id.toString();
  } else {
    const exists = await User.findById(userId);
    if (!exists) {
      const byEmail = await User.findOne({
        email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (!byEmail) {
        console.error('User not found for', { id: idArg, email });
        process.exitCode = 1;
        return;
      }
      userId = byEmail._id.toString();
    }
  }

  const result = await wipeTelecallerTestData({
    userId,
    deleteOrphanLeads: deleteLeads,
  });
  console.log(JSON.stringify(result, null, 2));
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
