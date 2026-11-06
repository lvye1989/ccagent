import Link from 'next/link';

export function Brand() {
  return <Link href="/" className="brand" aria-label="CCAGENT 账户中心"><span className="brand-icon" aria-hidden="true">CC</span><span>CCAGENT<small>ACCOUNT CENTER</small></span></Link>;
}
