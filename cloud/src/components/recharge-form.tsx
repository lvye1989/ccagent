'use client';
import { useState, type FormEvent } from 'react';

export function RechargeForm({ enabled, minFen, maxFen }: { enabled: boolean; minFen: number; maxFen: number }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const display = (fen: number) => `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, '0')}`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/account/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: String(data.get('amount') || '').trim() }) });
      const result = await response.json() as { message?: string; checkoutUrl?: string };
      if (!response.ok || !result.checkoutUrl?.startsWith('/checkout/')) throw new Error(result.message || '暂时无法创建充值订单。');
      window.location.assign(result.checkoutUrl);
    } catch (error) { setError(error instanceof Error ? error.message : '网络连接失败，请重试。'); setBusy(false); }
  }
  if (!enabled) return <div className="notice neutral">充值服务尚未开放。开放后可使用支付宝为账户充值。</div>;
  return <form onSubmit={submit} className="form-stack"><div className="form-row"><label className="field">充值金额（元）<input name="amount" required inputMode="decimal" placeholder={`最低 ${display(minFen)} 元`} maxLength={16} /><small>单笔 {display(minFen)} 至 {display(maxFen)} 元，余额不设到期时间。</small></label><div style={{ alignSelf: 'center' }}><button className="button" disabled={busy}>{busy ? '正在创建订单…' : '使用支付宝充值 →'}</button></div></div>{error && <div className="notice error" role="alert">{error}</div>}</form>;
}
