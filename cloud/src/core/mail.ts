import { Resend } from 'resend';

export type AccountMail = { to: string; url: string; kind: 'verification' | 'reset' };
export type MailTransport = (message: AccountMail) => Promise<void>;

export const deliverAccountMail: MailTransport = async ({ to, url, kind }) => {
  if (!process.env.RESEND_API_KEY) throw new Error('MAIL_NOT_CONFIGURED');
  const sender = process.env.AUTH_EMAIL_FROM || 'CCAGENT <account@notify.cjai.pro>';
  const subject = kind === 'verification' ? '验证你的 CCAGENT 邮箱' : '重置你的 CCAGENT 密码';
  const purpose = kind === 'verification' ? '完成邮箱验证' : '设置新密码';
  const result = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: sender, to: [to], subject,
    text: `请打开以下链接${purpose}：\n\n${url}\n\n链接有效期为一小时。如非你本人操作，请忽略此邮件。\nCCAGENT` });
  if (result.error || !result.data?.id) throw new Error('MAIL_DELIVERY_UNAVAILABLE');
};
