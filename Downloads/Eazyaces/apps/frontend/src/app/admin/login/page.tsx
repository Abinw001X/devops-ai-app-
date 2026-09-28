'use client';

import { ArrowLeft, ShieldCheck, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiRequest } from '@/lib/api';
import { useAuthStore, type User } from '@/lib/auth-store';

type Session = { accessToken: string; user: User };

export default function AdminLoginPage() {
  const router = useRouter();
  const setSession = useAuthStore((state) => state.setSession);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const data = new FormData(event.currentTarget);
    try {
      const session = await apiRequest<Session>('/auth/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: data.get('email'), password: data.get('password') }),
      });
      if (session.user.role !== 'admin') throw new Error('An administrator account is required.');
      setSession(session.accessToken, session.user);
      router.replace('/admin');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <header className="site-header"><div className="header-inner"><Link className="brand" href="/"><span className="brand-mark"><Wrench /></span>KaamSetu</Link><Link className="button button-quiet" href="/"><ArrowLeft />Back to marketplace</Link></div></header>
    <main className="admin-login-page">
      <section className="admin-login-panel"><div className="admin-login-symbol"><ShieldCheck /></div><span className="eyebrow">Operations access</span><h1>Administrator sign in</h1><p>This sign-in is reserved for KaamSetu administrators.</p>
        <form onSubmit={submit}>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-field"><label htmlFor="admin-email">Admin email</label><input id="admin-email" name="email" type="email" autoComplete="username" required placeholder="admin@company.com" /></div><div className="form-field"><label htmlFor="admin-password">Password</label><input id="admin-password" name="password" type="password" autoComplete="current-password" required minLength={8} placeholder="Your password" /></div><button className="button button-primary form-submit" disabled={busy}>{busy ? 'Signing in…' : 'Enter admin panel'}</button></form>
      </section>
    </main>
  </>;
}