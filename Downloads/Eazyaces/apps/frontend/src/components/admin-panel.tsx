'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, BadgeCheck, Banknote, CalendarDays, ChartNoAxesCombined, CircleAlert, FileText, LayoutDashboard, LogOut, Search, ShieldCheck, Users, WalletCards, X, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NotificationBell } from '@/components/notification-bell';
import { API_URL, apiRequest } from '@/lib/api';
import { BOOKING_API_URL, bookingDateLabel, rupees } from '@/lib/booking-api';
import { useAuthStore } from '@/lib/auth-store';

type Tab = 'overview' | 'verification' | 'users' | 'bookings' | 'disputes' | 'payouts';
type Overview = { commission_revenue_paise: string; subscription_run_rate_paise: string; total_revenue_paise: string; active_listings: number; bookings_this_month: number; pending_verifications: number };
type AdminPage<T> = { items: T[]; page: number; limit: number; total: number; totalPages: number };
type VerificationItem = { id: string; user_id: string; display_name: string; business_name: string | null; category: string; service_area: string; city: string; description: string; verification_status: string; subscription_status: string; is_live: boolean; created_at: string; owner_name: string; email: string; phone: string; has_kyc_document: boolean };
type UserItem = { id: string; name: string; email: string | null; phone: string | null; role: string; created_at: string; provider_id: string | null; verification_status: string | null; subscription_status: string | null; is_live: boolean | null; bookings_count: number; earnings_paise: string };
type AdminBooking = { id: string; service_category: string; scheduled_at: string; status: string; payment_status: string; amount_paise: string; created_at: string; customer_name: string; customer_email: string | null; provider_name: string; business_name: string; dispute_status: string | null };
type AdminDispute = { id: string; booking_id: string; reason: string; status: string; created_at: string; service_category: string; scheduled_at: string; booking_status: string; payment_status: string; amount_paise: string; service_address: string; booking_notes: string; customer_name: string; customer_email: string | null; provider_name: string; business_name: string; razorpay_payment_id: string | null; razorpay_order_id: string | null; payment_amount_paise: string | null; transaction_status: string | null };
type AdminPayout = { id: string; provider_id: string; amount_paise: string; commission_paise: string; status: string; payout_method: string; requested_at: string; notes: string | null; display_name: string; business_name: string; payout_kyc_verified: boolean; bank_account_holder_name: string | null; bank_account_number: string | null; bank_ifsc_code: string | null; upi_id: string | null; owner_name: string; email: string | null; phone: string | null };

const tabs: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'verification', label: 'Verification queue', icon: BadgeCheck },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'bookings', label: 'Bookings', icon: CalendarDays },
  { id: 'disputes', label: 'Disputes', icon: CircleAlert },
  { id: 'payouts', label: 'Payout approvals', icon: WalletCards },
];

async function adminRequest<T>(baseUrl: string, endpoint: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    credentials: 'include',
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error ?? 'The request could not be completed.');
  return body as T;
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value));
}

function StatusPill({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="admin-muted">—</span>;
  return <span className={`status-pill status-${value}`}>{value.replaceAll('_', ' ')}</span>;
}

export function AdminPanel() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.accessToken);
  const ready = useAuthStore((state) => state.ready);
  const clearSession = useAuthStore((state) => state.clearSession);
  const [tab, setTab] = useState<Tab>('overview');
  const [search, setSearch] = useState('');
  const [stableSearch, setStableSearch] = useState('');
  const [userPage, setUserPage] = useState(1);
  const [bookingStatus, setBookingStatus] = useState('');
  const [bookingFrom, setBookingFrom] = useState('');
  const [bookingTo, setBookingTo] = useState('');
  const [bookingCategory, setBookingCategory] = useState('');
  const [bookingPage, setBookingPage] = useState(1);
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});
  const [payoutReasons, setPayoutReasons] = useState<Record<string, string>>({});
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [refundAmounts, setRefundAmounts] = useState<Record<string, string>>({});
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});
  const [kycUrl, setKycUrl] = useState('');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    if (ready && (!user || user.role !== 'admin')) router.replace('/admin/login');
  }, [ready, router, user]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setStableSearch(search.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [search]);
  useEffect(() => () => { if (kycUrl) URL.revokeObjectURL(kycUrl); }, [kycUrl]);

  const overview = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => adminRequest<Overview>(BOOKING_API_URL, '/admin/overview', token as string), enabled: Boolean(token && user?.role === 'admin') });
  const verifications = useQuery({ queryKey: ['admin', 'verifications'], queryFn: () => adminRequest<VerificationItem[]>(API_URL, '/admin/providers?status=pending_verification', token as string), enabled: Boolean(token && tab === 'verification') });
  const users = useQuery({ queryKey: ['admin', 'users', stableSearch, userPage], queryFn: () => adminRequest<AdminPage<UserItem>>(BOOKING_API_URL, `/admin/users?search=${encodeURIComponent(stableSearch)}&page=${userPage}`, token as string), enabled: Boolean(token && tab === 'users') });
  const bookingQuery = new URLSearchParams();
  if (bookingStatus) bookingQuery.set('status', bookingStatus);
  if (bookingFrom) bookingQuery.set('from', bookingFrom);
  if (bookingTo) bookingQuery.set('to', bookingTo);
  if (bookingCategory) bookingQuery.set('category', bookingCategory);
  bookingQuery.set('page', String(bookingPage));
  const bookings = useQuery({ queryKey: ['admin', 'bookings', bookingStatus, bookingFrom, bookingTo, bookingCategory, bookingPage], queryFn: () => adminRequest<AdminPage<AdminBooking>>(BOOKING_API_URL, `/admin/bookings?${bookingQuery}`, token as string), enabled: Boolean(token && tab === 'bookings') });
  const disputes = useQuery({ queryKey: ['admin', 'disputes'], queryFn: () => adminRequest<AdminDispute[]>(BOOKING_API_URL, '/admin/disputes?status=open', token as string), enabled: Boolean(token && tab === 'disputes') });
  const payouts = useQuery({ queryKey: ['admin', 'payouts'], queryFn: () => adminRequest<AdminPayout[]>(BOOKING_API_URL, '/admin/payouts', token as string), enabled: Boolean(token && tab === 'payouts') });

  async function refresh(...keys: unknown[][]) {
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }

  async function reviewProvider(item: VerificationItem, decision: 'approve' | 'reject') {
    const reason = rejectionReasons[item.id]?.trim();
    if (decision === 'reject' && !reason) {
      setError(`Add a rejection reason for ${item.business_name || item.display_name}.`);
      return;
    }
    setBusyId(item.id);
    setError('');
    try {
      await adminRequest(API_URL, `/admin/providers/${item.id}/verification`, token as string, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, reason }) });
      await refresh(['admin', 'verifications'], ['admin', 'overview']);
    } catch (reasonError) {
      setError(reasonError instanceof Error ? reasonError.message : 'The verification decision failed.');
    } finally {
      setBusyId('');
    }
  }

  async function showKyc(item: VerificationItem) {
    setBusyId(item.id);
    setError('');
    try {
      const response = await fetch(`${API_URL}/admin/providers/${item.id}/kyc`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('KYC document could not be loaded.');
      const url = URL.createObjectURL(await response.blob());
      setKycUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return url; });
    } catch (reasonError) {
      setError(reasonError instanceof Error ? reasonError.message : 'KYC document could not be loaded.');
    } finally {
      setBusyId('');
    }
  }

  async function decidePayout(item: AdminPayout, action: 'approve' | 'reject') {
    const reason = payoutReasons[item.id]?.trim();
    if (action === 'reject' && !reason) { setError('Add a reason before rejecting the payout.'); return; }
    setBusyId(item.id);
    setError('');
    try {
      await adminRequest(BOOKING_API_URL, `/admin/payouts/${item.id}`, token as string, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, reason }) });
      await refresh(['admin', 'payouts']);
    } catch (reasonError) {
      setError(reasonError instanceof Error ? reasonError.message : 'Payout decision failed.');
    } finally {
      setBusyId('');
    }
  }

  async function resolveDispute(item: AdminDispute) {
    const outcome = resolution[item.id] || 'refund_customer';
    const refundAmountPaise = Number(refundAmounts[item.id]);
    if (outcome === 'partial' && (!refundAmountPaise || refundAmountPaise >= Number(item.payment_amount_paise))) {
      setError('Enter a partial refund smaller than the captured payment.');
      return;
    }
    setBusyId(item.id);
    setError('');
    try {
      await adminRequest(BOOKING_API_URL, `/admin/disputes/${item.id}/resolve`, token as string, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome, refundAmountPaise: outcome === 'partial' ? refundAmountPaise : undefined, resolutionNote: resolutionNotes[item.id] }) });
      await refresh(['admin', 'disputes'], ['admin', 'bookings']);
    } catch (reasonError) {
      setError(reasonError instanceof Error ? reasonError.message : 'Dispute resolution failed.');
    } finally {
      setBusyId('');
    }
  }

  async function signOut() {
    await apiRequest('/auth/logout', { method: 'POST' }).catch(() => undefined);
    clearSession();
    router.replace('/admin/login');
  }

  if (!ready || user?.role !== 'admin' || !token) return <main className="admin-loading" aria-label="Checking administrator access" />;

  return <div className="admin-shell">
    <header className="admin-topbar"><Link className="brand" href="/"><span className="brand-mark"><Wrench /></span>KaamSetu <span className="admin-wordmark">OPERATIONS</span></Link><div className="header-actions"><NotificationBell /><span className="admin-user-name">{user.name}</span><button className="notification-trigger" type="button" onClick={() => void signOut()} aria-label="Sign out"><LogOut /></button></div></header>
    <div className="admin-layout">
      <aside className="admin-sidebar"><div className="admin-sidebar-label">WORKSPACE</div><nav aria-label="Admin sections">{tabs.map(({ id, label, icon: Icon }) => <button type="button" key={id} className={`admin-nav-item${tab === id ? ' active' : ''}`} onClick={() => { setTab(id); setError(''); }}><Icon />{label}{id === 'verification' && overview.data?.pending_verifications ? <span className="admin-nav-count">{overview.data.pending_verifications}</span> : null}</button>)}</nav><div className="admin-sidebar-bottom"><ShieldCheck /><span>Admin access<br /><strong>{user.email}</strong></span></div></aside>
      <main className="admin-content">
        <div className="admin-page-heading"><div><span className="eyebrow"><Activity />KaamSetu operations</span><h1>{tabs.find((item) => item.id === tab)?.label}</h1></div><div className="admin-today">{shortDate(new Date().toISOString())}</div></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {overview.isError && <p className="form-error" role="alert">{overview.error.message}</p>}
        {tab === 'overview' && <section className="admin-view">
          {overview.data ? <>
            <div className="admin-metric-grid">
              <article className="admin-metric admin-metric-revenue"><span><Banknote />Revenue run-rate</span><strong>{rupees(overview.data.total_revenue_paise)}</strong><small>Commission + active subscription value per month</small></article>
              <article className="admin-metric"><span><BadgeCheck />Active listings</span><strong>{overview.data.active_listings.toLocaleString('en-IN')}</strong><small>Verified and subscribed profiles</small></article>
              <article className="admin-metric"><span><CalendarDays />Bookings this month</span><strong>{overview.data.bookings_this_month.toLocaleString('en-IN')}</strong><small>Across all service categories</small></article>
              <article className="admin-metric"><span><FileText />Pending verification</span><strong>{overview.data.pending_verifications.toLocaleString('en-IN')}</strong><small>Applications awaiting review</small></article>
            </div>
            <section className="admin-revenue-panel"><div><div className="eyebrow"><ChartNoAxesCombined />Revenue composition</div><h2>Monthly run-rate</h2><p>Subscription value is based on active plans; commission is calculated from completed, paid bookings.</p></div><div className="revenue-breakdown"><div className="revenue-breakdown-row"><span><i className="revenue-dot commission" />Booking commission</span><strong>{rupees(overview.data.commission_revenue_paise)}</strong></div><div className="revenue-breakdown-row"><span><i className="revenue-dot subscription" />Active subscriptions</span><strong>{rupees(overview.data.subscription_run_rate_paise)}</strong></div><div className="revenue-meter"><span style={{ width: `${Number(overview.data.total_revenue_paise) ? Math.max(8, Number(overview.data.commission_revenue_paise) / Number(overview.data.total_revenue_paise) * 100) : 0}%` }} /></div></div></section>
          </> : <div className="admin-loading" />}
          <div className="admin-quick-grid"><button onClick={() => setTab('verification')}><BadgeCheck /><span>Review provider applications</span><strong>{overview.data?.pending_verifications ?? '—'} waiting</strong></button><button onClick={() => setTab('disputes')}><CircleAlert /><span>Resolve customer disputes</span><strong>Open queue</strong></button><button onClick={() => setTab('payouts')}><WalletCards /><span>Approve provider payouts</span><strong>Review requests</strong></button></div>
        </section>}

        {tab === 'verification' && <section className="admin-view">{verifications.isPending ? <div className="admin-loading" /> : verifications.data?.length ? <div className="verification-queue">{verifications.data.map((item) => <article className="verification-card" key={item.id}>
          <div className="verification-card-head"><div><span className="eyebrow"><BadgeCheck />{item.category}</span><h2>{item.business_name || item.display_name}</h2><p>{item.owner_name} · {item.email} · {item.phone}</p></div><StatusPill value={item.verification_status} /></div>
          <div className="verification-facts"><span><strong>Business</strong>{item.business_name || item.display_name}</span><span><strong>Service area</strong>{item.service_area}, {item.city}</span><span><strong>Submitted</strong>{shortDate(item.created_at)}</span><span><strong>Subscription</strong>{item.subscription_status}</span></div>
          {item.description && <p className="verification-description">{item.description}</p>}
          <div className="verification-actions"><button className="button button-outline" type="button" disabled={!item.has_kyc_document || busyId === item.id} onClick={() => void showKyc(item)}><FileText />{busyId === item.id ? 'Loading…' : 'View KYC document'}</button><div className="verification-decision"><input aria-label={`Rejection reason for ${item.business_name || item.display_name}`} value={rejectionReasons[item.id] ?? ''} onChange={(event) => setRejectionReasons((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Reason required to reject" /><button className="button button-outline reject-button" disabled={busyId === item.id} onClick={() => void reviewProvider(item, 'reject')}>Reject</button><button className="button button-primary" disabled={busyId === item.id} onClick={() => void reviewProvider(item, 'approve')}>Approve</button></div></div>
        </article>)}</div> : <div className="admin-empty"><BadgeCheck /><h2>Verification queue is clear</h2><p>New provider applications will appear here.</p></div>}{verifications.isError && <p className="form-error">{verifications.error.message}</p>}</section>}

        {tab === 'users' && <section className="admin-view"><label className="admin-search"><Search /><input value={search} onChange={(event) => { setSearch(event.target.value); setUserPage(1); }} placeholder="Search name, email, phone, or business" /></label>{users.isPending ? <div className="admin-loading" /> : <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Joined</th><th>Bookings</th><th>Provider earnings</th></tr></thead><tbody>{users.data?.items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><span>{item.email || item.phone || '—'}</span></td><td>{item.role}</td><td><StatusPill value={item.role === 'technician' || item.role === 'company' ? item.verification_status : 'active'} />{item.is_live && <span className="admin-live-mark">Live</span>}</td><td>{shortDate(item.created_at)}</td><td>{item.bookings_count}</td><td>{item.provider_id ? rupees(item.earnings_paise) : '—'}</td></tr>)}</tbody></table>{!users.data?.items.length && <div className="admin-empty"><Users /><p>No accounts match that search.</p></div>}</div><div className="admin-pagination"><span>{users.data?.total ?? 0} accounts</span><button className="button button-outline" disabled={(users.data?.page ?? 1) <= 1} onClick={() => setUserPage((page) => page - 1)}>Previous</button><span>Page {users.data?.page ?? 1} of {users.data?.totalPages ?? 1}</span><button className="button button-outline" disabled={(users.data?.page ?? 1) >= (users.data?.totalPages ?? 1)} onClick={() => setUserPage((page) => page + 1)}>Next</button></div></>}{users.isError && <p className="form-error">{users.error.message}</p>}</section>}

        {tab === 'bookings' && <section className="admin-view"><div className="admin-filter-row"><select aria-label="Booking status" value={bookingStatus} onChange={(event) => { setBookingStatus(event.target.value); setBookingPage(1); }}><option value="">All statuses</option>{['pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'rejected'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select><input type="date" aria-label="From date" value={bookingFrom} onChange={(event) => { setBookingFrom(event.target.value); setBookingPage(1); }} /><input type="date" aria-label="To date" value={bookingTo} onChange={(event) => { setBookingTo(event.target.value); setBookingPage(1); }} /><input aria-label="Service category" value={bookingCategory} onChange={(event) => { setBookingCategory(event.target.value); setBookingPage(1); }} placeholder="Category" /></div>{bookings.isPending ? <div className="admin-loading" /> : <><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Booking</th><th>Customer</th><th>Provider</th><th>Scheduled</th><th>Status</th><th>Payment</th><th>Amount</th></tr></thead><tbody>{bookings.data?.items.map((item) => <tr key={item.id}><td><strong>{item.service_category}</strong><span>{item.id.slice(0, 8)}</span></td><td>{item.customer_name}<span>{item.customer_email}</span></td><td>{item.business_name || item.provider_name}</td><td>{bookingDateLabel(item.scheduled_at)}</td><td><StatusPill value={item.dispute_status ? `dispute_${item.dispute_status}` : item.status} /></td><td><StatusPill value={item.payment_status} /></td><td>{rupees(item.amount_paise)}</td></tr>)}</tbody></table>{!bookings.data?.items.length && <div className="admin-empty"><CalendarDays /><p>No bookings match these filters.</p></div>}</div><div className="admin-pagination"><span>{bookings.data?.total ?? 0} bookings</span><button className="button button-outline" disabled={(bookings.data?.page ?? 1) <= 1} onClick={() => setBookingPage((page) => page - 1)}>Previous</button><span>Page {bookings.data?.page ?? 1} of {bookings.data?.totalPages ?? 1}</span><button className="button button-outline" disabled={(bookings.data?.page ?? 1) >= (bookings.data?.totalPages ?? 1)} onClick={() => setBookingPage((page) => page + 1)}>Next</button></div></>}{bookings.isError && <p className="form-error">{bookings.error.message}</p>}</section>}

        {tab === 'disputes' && <section className="admin-view">{disputes.isPending ? <div className="admin-loading" /> : disputes.data?.length ? <div className="dispute-queue">{disputes.data.map((item) => <article className="dispute-admin-card" key={item.id}>
          <div className="dispute-admin-head"><div><span className="eyebrow"><CircleAlert />{item.service_category} · {shortDate(item.created_at)}</span><h2>{item.business_name || item.provider_name} <span>and</span> {item.customer_name}</h2><p>{item.reason}</p></div><StatusPill value="open" /></div>
          <div className="dispute-facts"><span><strong>Booking</strong><Link href={`/bookings/${item.booking_id}`}>{item.booking_id.slice(0, 8)} · {item.booking_status}</Link></span><span><strong>Service time</strong>{bookingDateLabel(item.scheduled_at)}</span><span><strong>Payment</strong>{item.transaction_status ?? item.payment_status} · {rupees(item.payment_amount_paise ?? item.amount_paise)}</span><span><strong>Razorpay payment</strong>{item.razorpay_payment_id ?? 'No captured payment'}</span><span><strong>Address</strong>{item.service_address}</span></div>
          <div className="dispute-resolution-form"><label><span>Outcome</span><select value={resolution[item.id] ?? 'refund_customer'} onChange={(event) => setResolution((current) => ({ ...current, [item.id]: event.target.value }))}><option value="refund_customer">Refund Customer</option><option value="release_provider">Release Payment to Provider</option><option value="partial">Partial</option><option value="dismissed">Dismissed</option></select></label>{(resolution[item.id] ?? 'refund_customer') === 'partial' && <label><span>Refund amount (paise)</span><input type="number" min="1" max={Math.max(1, Number(item.payment_amount_paise ?? item.amount_paise) - 1)} value={refundAmounts[item.id] ?? ''} onChange={(event) => setRefundAmounts((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="For example: 50000" /></label>}<label className="resolution-note-field"><span>Resolution note</span><input value={resolutionNotes[item.id] ?? ''} onChange={(event) => setResolutionNotes((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Optional context for both parties" /></label><button className="button button-primary" disabled={busyId === item.id} onClick={() => void resolveDispute(item)}>{busyId === item.id ? 'Processing…' : 'Resolve dispute'}</button></div>
        </article>)}</div> : <div className="admin-empty"><ShieldCheck /><h2>No open disputes</h2><p>New customer or provider tickets will be queued here.</p></div>}{disputes.isError && <p className="form-error">{disputes.error.message}</p>}</section>}

        {tab === 'payouts' && <section className="admin-view">{payouts.isPending ? <div className="admin-loading" /> : payouts.data?.length ? <div className="payout-queue">{payouts.data.map((item) => <article className="payout-admin-card" key={item.id}>
          <div className="payout-admin-head"><div><span className="eyebrow"><WalletCards />Requested {shortDate(item.requested_at)}</span><h2>{item.business_name || item.display_name}</h2><p>{item.owner_name} · {item.email || item.phone}</p></div><div className="payout-state"><StatusPill value={item.status} /><strong className="payout-amount">{rupees(item.amount_paise)}</strong></div></div>
          <div className="payout-facts"><span><strong>Account holder</strong>{item.bank_account_holder_name || '—'}</span><span><strong>Bank account</strong>{item.bank_account_number ? `•••• ${item.bank_account_number.slice(-4)} · ${item.bank_ifsc_code}` : '—'}</span><span><strong>UPI</strong>{item.upi_id || '—'}</span><span><strong>Payout KYC</strong><StatusPill value={item.payout_kyc_verified ? 'verified' : 'pending_verification'} /></span><span><strong>Commission retained</strong>{rupees(item.commission_paise)}</span></div>
          {item.status === 'requested' ? <div className="payout-actions"><input value={payoutReasons[item.id] ?? ''} onChange={(event) => setPayoutReasons((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Reason required to reject" aria-label={`Rejection reason for payout to ${item.business_name || item.display_name}`} /><button className="button button-outline reject-button" disabled={busyId === item.id} onClick={() => void decidePayout(item, 'reject')}>Reject</button><button className="button button-primary" disabled={busyId === item.id || !item.payout_kyc_verified} onClick={() => void decidePayout(item, 'approve')}><WalletCards />{busyId === item.id ? 'Sending…' : 'Approve & send payout'}</button></div> : <p className="payout-in-progress">Submitted to RazorpayX. Waiting for payout status confirmation.</p>}
        </article>)}</div> : <div className="admin-empty"><WalletCards /><h2>No payout requests</h2><p>Provider payout requests will appear here before any transfer is initiated.</p></div>}{payouts.isError && <p className="form-error">{payouts.error.message}</p>}</section>}
      </main>
    </div>
    {kycUrl && <div className="kyc-modal-backdrop" role="presentation" onClick={() => setKycUrl('')}><section className="kyc-modal" role="dialog" aria-modal="true" aria-label="KYC document" onClick={(event) => event.stopPropagation()}><header><strong>Submitted KYC document</strong><button className="notification-trigger" onClick={() => setKycUrl('')} aria-label="Close document"><X /></button></header>{kycUrl.startsWith('blob:') && <iframe src={kycUrl} title="KYC document preview" />}</section></div>}
  </div>;
}