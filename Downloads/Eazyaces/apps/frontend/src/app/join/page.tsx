'use client';

import { ArrowLeft, BadgeCheck, FileCheck2, ShieldCheck, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { apiRequest } from '@/lib/api';
import { useAuthStore, type User } from '@/lib/auth-store';

type Session = { accessToken: string; user: User };

export default function JoinPage() {
  const setSession = useAuthStore((state) => state.setSession);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const session = await apiRequest<Session>('/auth/register/provider', { method: 'POST', body: new FormData(event.currentTarget) });
      setSession(session.accessToken, session.user);
      setSubmitted(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to submit your profile.');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <header className="site-header"><div className="header-inner"><Link className="brand" href="/"><span className="brand-mark"><Wrench /></span>KaamSetu</Link><Link className="button button-quiet" href="/"><ArrowLeft />Back to search</Link></div></header>
    <main className="auth-page"><aside className="auth-aside"><div className="eyebrow"><FileCheck2 />For local professionals</div><div><h1>Put your good work in front of more people.</h1><p>Build a profile for your service, tell customers where you work, and submit your details for verification.</p><div className="auth-benefits"><span><ShieldCheck />KYC review before going live</span><span><BadgeCheck />A profile customers can discover</span></div></div><span className="auth-note">Provider verification is currently manual.</span></aside>
      <section className="auth-panel-wrap"><div className="auth-panel"><h2>{submitted ? 'Profile submitted' : 'Create a professional profile'}</h2><p>{submitted ? 'Your details are saved. We will review your document before the profile goes live.' : 'Start with your service details and identity document.'}</p>
        {submitted ? <><div className="form-success" role="status"><strong>Pending Verification</strong><br />Your profile is private until its identity or business proof has been reviewed.</div><Link className="button button-primary form-submit" href="/">Explore the marketplace</Link></> : <>
        <div className="auth-switch"><span>Technician or company</span></div>
        <form onSubmit={submit} encType="multipart/form-data">{error && <p className="form-error" role="alert">{error}</p>}<div className="form-grid">
          <div className="form-field"><label htmlFor="role">Profile type</label><select id="role" name="role" defaultValue="technician"><option value="technician">Individual technician</option><option value="company">Service company</option></select></div>
          <div className="form-field"><label htmlFor="category">Service category</label><select id="category" name="category" defaultValue="electrician"><option value="electrician">Electrician</option><option value="plumber">Plumber</option><option value="painter">Painter</option><option value="caterer">Catering</option><option value="supplier">Materials supplier</option><option value="technician">Other technician</option></select></div>
          <div className="form-field"><label htmlFor="name">Contact name</label><input id="name" name="name" autoComplete="name" required minLength={2} /></div>
          <div className="form-field"><label htmlFor="businessName">Business name <span className="auth-note">(optional)</span></label><input id="businessName" name="businessName" autoComplete="organization" /></div>
          <div className="form-field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="email" required /></div>
          <div className="form-field"><label htmlFor="phone">Phone</label><input id="phone" name="phone" type="tel" autoComplete="tel" required placeholder="+91 98765 43210" /></div>
          <div className="form-field"><label htmlFor="city">City</label><input id="city" name="city" required placeholder="Ahmedabad" /></div>
          <div className="form-field"><label htmlFor="serviceArea">Service area</label><input id="serviceArea" name="serviceArea" required placeholder="Neighbourhoods or radius" /></div>
          <div className="form-field full"><label htmlFor="basePrice">Starting service price (INR)</label><input id="basePrice" name="basePrice" type="number" min="1" max="1000000" step="1" required placeholder="e.g. 799" /><small>Shown before customers confirm. Final totals will be shown clearly.</small></div>
          <div className="form-field full"><label htmlFor="description">About your services</label><textarea id="description" name="description" maxLength={500} placeholder="Describe the work you do and the areas you cover." /></div>
          <div className="form-field full"><label htmlFor="profilePhoto">Profile photo <span className="auth-note">(optional)</span></label><input id="profilePhoto" name="profilePhoto" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" /><small>JPG or PNG · up to 5 MB · visible on your public profile after verification</small></div>
          <div className="form-field full"><label htmlFor="kycDocument">ID or business proof</label><input id="kycDocument" name="kycDocument" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" required /><small>PDF, JPG or PNG · up to 5 MB · stored privately for verification</small></div>
          <div className="form-field full"><label htmlFor="password">Create password</label><input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required placeholder="At least 8 characters" /></div>
        </div><div className="verification-note"><ShieldCheck aria-hidden="true" />Your profile starts pending until the submitted document is reviewed. It will not be shown as verified.</div><button className="button button-primary form-submit" disabled={busy}>{busy ? 'Submitting profile…' : 'Submit for verification'}</button></form>
        <div className="auth-bottom">Already have a profile? <Link href="/login">Sign in</Link></div>
        </>}
      </div></section>
    </main>
  </>;
}