import { Resend } from 'resend';
import { AsyncLocalStorage } from 'node:async_hooks';
import { errorResponse, HttpError } from './http';

export type AccountMail = { to: string; url: string; kind: 'verification' | 'reset' };
export type MailTransport = (message: AccountMail) => Promise<void>;

function mailUnavailable() {
  return new HttpError(503, 'MAIL_DELIVERY_UNAVAILABLE', '账户邮件暂时发送失败，请稍后重试；未完成验证的账户可重新发送验证邮件。');
}

export function requireAccountMailConfiguration(): void {
  if (!process.env.RESEND_API_KEY?.trim()) {
    throw new HttpError(503, 'MAIL_NOT_CONFIGURED', '账户邮件服务尚未配置，请联系管理员。');
  }
}

// Better Auth 1.7.18 swallows errors in runInBackgroundOrAwait. Keep delivery
// outcomes in the originating request, rather than a shared last-error flag.
export function accountMailDelivery(transport: MailTransport, checkConfiguration: () => void = () => {}) {
  type DeliveryState = { failure?: HttpError; pending: Set<Promise<void>> };
  const requests = new AsyncLocalStorage<DeliveryState>();
  const deliver: MailTransport = message => {
    const state = requests.getStore();
    const task = (async () => {
      try { await transport(message); }
      catch (error) {
        const safe = error instanceof HttpError && error.code === 'MAIL_NOT_CONFIGURED'
          ? new HttpError(503, 'MAIL_NOT_CONFIGURED', '账户邮件服务尚未配置，请联系管理员。') : mailUnavailable();
        if (state) state.failure ??= safe;
        throw safe;
      }
    })();
    state?.pending.add(task);
    // Leave settled tasks in this short-lived request state so even a future
    // background-task configuration cannot return before delivery finishes.
    return task;
  };
  const beforeWrite = new Set(['/api/auth/sign-up/email', '/api/auth/request-password-reset', '/api/auth/send-verification-email']);
  const wrapHandler = (handler: (request: Request) => Promise<Response>) => (request: Request): Promise<Response> => {
    const state: DeliveryState = { pending: new Set() };
    return requests.run(state, async () => {
      try {
        if (request.method === 'POST' && beforeWrite.has(new URL(request.url).pathname)) checkConfiguration();
        const response = await handler(request);
        await Promise.allSettled(state.pending);
        return state.failure ? errorResponse(state.failure) : response;
      } catch (error) {
        if (state.failure) return errorResponse(state.failure);
        if (error instanceof HttpError && error.code === 'MAIL_NOT_CONFIGURED') {
          return errorResponse(new HttpError(503, 'MAIL_NOT_CONFIGURED', '账户邮件服务尚未配置，请联系管理员。'));
        }
        throw error;
      }
    });
  };
  return { deliver, wrapHandler };
}

export const deliverAccountMail: MailTransport = async ({ to, url, kind }) => {
  requireAccountMailConfiguration();
  const sender = process.env.AUTH_EMAIL_FROM || 'CCAGENT <account@notify.cjai.pro>';
  const subject = kind === 'verification' ? '验证你的 CCAGENT 邮箱' : '重置你的 CCAGENT 密码';
  const purpose = kind === 'verification' ? '完成邮箱验证' : '设置新密码';
  try {
    const result = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: sender, to: [to], subject,
      text: `请打开以下链接${purpose}：\n\n${url}\n\n链接有效期为一小时。如非你本人操作，请忽略此邮件。\nCCAGENT` });
    if (result.error || !result.data?.id) throw mailUnavailable();
  } catch { throw mailUnavailable(); }
};
