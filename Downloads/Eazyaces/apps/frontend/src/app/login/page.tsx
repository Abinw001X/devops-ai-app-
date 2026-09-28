'use client';

import { ArrowLeft, BadgeCheck, ShieldCheck, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GoogleSignIn } from '@/components/google-sign-in';
import { apiRequest } from '@/lib/api';
import { useAuthStore, type User } from '@/lib/auth-store';

type Session = { accessToken: string; user: User };

export default function LoginPage() {
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
      const session = await apiRequest<Session>('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: data.get('identifier'), password: data.get('password') }) });
      setSession(session.accessToken, session.user);
      router.push('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <header className="site-header"><div className="header-inner"><Link className="brand" href="/"><span className="brand-mark"><Wrench /></span>KaamSetu</Link><Link className="button button-quiet" href="/"><ArrowLeft />Back to search</Link></div></header>
    <main className="auth-page"><aside className="auth-aside"><div className="eyebrow"><BadgeCheck />Local people. Trusted work.</div><div><h1>Good work is closer than you think.</h1><p>Find a dependable professional for your home, or grow your local service business with KaamSetu.</p><div className="auth-benefits"><span><ShieldCheck />Identity checks built into onboarding</span><span><BadgeCheck />Transparent professional profiles</span></div></div><span className="auth-note">KaamSetu · Your neighbourhood, sorted</span></aside>
      <section className="auth-panel-wrap"><div className="auth-panel"><h2>Welcome back</h2><p>Sign in to your KaamSetu account.</p>
        <form onSubmit={submit}>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-field"><label htmlFor="identifier">Email or phone number</label><input id="identifier" name="identifier" autoComplete="username" required placeholder="you@example.com" /></div><div className="form-field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required minLength={8} placeholder="At least 8 characters" /></div><button className="button button-primary form-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form>
        <div className="form-divider">or continue with</div><GoogleSignIn onError={setError} /><div className="auth-bottom">New to KaamSetu? <Link href="/register">Create a customer account</Link><br /><Link href="/join">Register as a service professional</Link></div>
      </div></section>
    </main>
  </>;
}