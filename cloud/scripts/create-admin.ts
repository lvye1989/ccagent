import './load-env';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { database, closeDatabase } from '../src/core/db';
import { audit, user, userRoles } from '../src/core/db/schema';

// Run by an operator with server environment access; never exposed as an HTTP endpoint.
const email = process.argv[2]?.trim().toLowerCase();
try {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Usage: npm run admin:create -- <verified-email>');
  const db = database().db;
  await db.transaction(async tx => {
    const [target] = await tx.select().from(user).where(eq(user.email, email)).for('update');
    if (!target || !target.emailVerified || target.banned) throw new Error('Administrator must be an existing, verified, active email account');
    await tx.insert(userRoles).values({ userId: target.id, roleId: 'admin' }).onConflictDoNothing();
    await tx.update(user).set({ role: 'admin', updatedAt: new Date() }).where(eq(user.id, target.id));
    await tx.insert(audit).values({ id: randomUUID(), actorId: target.id, action: 'admin.bootstrap', objectId: target.id, result: 'success', metadata: { mechanism: 'server-command' } });
  });
  console.log('Administrator permission granted to the specified verified account.');
} catch (error) {
  console.error(error instanceof Error && !(error as { cause?: unknown }).cause ? error.message : 'ADMIN_BOOTSTRAP_FAILED');
  process.exitCode = 1;
} finally { await closeDatabase(); }
