import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins';
import { and, eq, gt } from 'drizzle-orm';
import { database } from './db';
import * as schema from './db/schema';
import { authEnvironment } from './env';
import { accountMailDelivery, deliverAccountMail, requireAccountMailConfiguration, type MailTransport } from './mail';
import { HttpError } from './http';

export function createAuthentication(options: { db: ReturnType<typeof database>['db']; origin: string; secret: string; deliverMail: MailTransport }) {
  const mail = accountMailDelivery(options.deliverMail,
    options.deliverMail === deliverAccountMail ? requireAccountMailConfiguration : undefined);
  const auth = betterAuth({ appName: 'CCAGENT', baseURL: options.origin, secret: options.secret,
    trustedOrigins: [options.origin], database: drizzleAdapter(options.db, { provider: 'pg', schema, transaction: true }),
    emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128, requireEmailVerification: true, autoSignIn: false,
      revokeSessionsOnPasswordReset: true, resetPasswordTokenExpiresIn: 3600,
      sendResetPassword: async ({ user, url }) => mail.deliver({ to: user.email, url, kind: 'reset' }) },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: false, expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => mail.deliver({ to: user.email, url, kind: 'verification' }) },
    session: { expiresIn: 7 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 10 }, '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 5 }, '/send-verification-email': { window: 60, max: 5 } } },
    advanced: { cookiePrefix: 'ccagent', useSecureCookies: options.origin.startsWith('https://'),
      ipAddress: { ipAddressHeaders: ['x-vercel-forwarded-for'] } },
    plugins: [admin({ defaultRole: 'user', bannedUserMessage: '账户已被禁用，请联系管理员。' })],
    // Query errors may contain password hashes or session tokens; never log raw adapter errors.
    logger: { log: level => { if (level === 'error') console.error('AUTH_REQUEST_FAILED'); } },
  });
  const handler = mail.wrapHandler(auth.handler);
  return { ...auth, handler, fetch: handler };
}
type Authentication = ReturnType<typeof createAuthentication>;
let instance: Authentication | undefined;
export function authentication(): Authentication {
  const { secret, origin } = authEnvironment();
  return instance ??= createAuthentication({ db: database().db, secret, origin, deliverMail: deliverAccountMail });
}

export async function requireSession(headers: Headers) {
  const current = await authentication().api.getSession({ headers, query: { disableCookieCache: true } });
  if (!current) throw new HttpError(401, 'LOGIN_REQUIRED', '请先使用邮箱和密码登录。');
  // Re-read the live database user and session, including revocation and account disablement.
  const [live] = await database().db.select({ id: schema.user.id, email: schema.user.email, name: schema.user.name,
    banned: schema.user.banned, emailVerified: schema.user.emailVerified, expiresAt: schema.session.expiresAt })
    .from(schema.session).innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
    .where(and(eq(schema.session.id, current.session.id), eq(schema.session.userId, current.user.id), gt(schema.session.expiresAt, new Date()))).limit(1);
  if (!live || !live.emailVerified) throw new HttpError(401, 'SESSION_EXPIRED', '登录已失效，请重新登录。');
  if (live.banned) throw new HttpError(403, 'ACCOUNT_DISABLED', '账户已被禁用，请联系管理员。');
  return { user: { id: live.id, email: live.email, name: live.name }, session: { id: current.session.id, expiresAt: live.expiresAt } };
}

export async function permissionsFor(userId: string): Promise<string[]> {
  const rows = await database().db.selectDistinct({ id: schema.permissions.id }).from(schema.userRoles)
    .innerJoin(schema.rolePermissions, eq(schema.userRoles.roleId, schema.rolePermissions.roleId))
    .innerJoin(schema.permissions, eq(schema.rolePermissions.permissionId, schema.permissions.id))
    .where(eq(schema.userRoles.userId, userId));
  return rows.map(row => row.id).sort();
}
export async function requirePermission(headers: Headers, permission: string) {
  const current = await requireSession(headers);
  if (!(await permissionsFor(current.user.id)).includes(permission)) throw new HttpError(403, 'PERMISSION_DENIED', '没有执行此操作的权限。');
  return current;
}
