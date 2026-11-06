import './load-env';
import { Resend } from 'resend';

const key = process.env.RESEND_API_KEY;
if (!key) throw new Error('EMAIL_NOT_CONFIGURED');
const resend = new Resend(key);
try {
  const list = await resend.domains.list();
  if (list.error) { console.error(JSON.stringify({ checked: false, code: list.error.name })); process.exitCode = 1; }
  else {
    const domain = list.data?.data.find(item => item.name === 'notify.cjai.pro');
    if (!domain) throw new Error('EMAIL_DOMAIN_NOT_FOUND');
    if (process.argv.includes('--verify')) {
      const check = await resend.domains.verify(domain.id);
      if (check.error) throw new Error('EMAIL_DOMAIN_VERIFICATION_FAILED');
    }
    const detail = await resend.domains.get(domain.id);
    if (detail.error) { console.error(JSON.stringify({ checked: false, code: detail.error.name })); process.exitCode = 1; }
    else console.log(JSON.stringify({ checked: true, name: detail.data.name, status: detail.data.status, records: detail.data.records }, null, 2));
  }
} catch { console.error(JSON.stringify({ checked: false, code: 'EMAIL_DOMAIN_CHECK_FAILED' })); process.exitCode = 1; }
