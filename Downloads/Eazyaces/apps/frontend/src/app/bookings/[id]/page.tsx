'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CircleAlert, Clock3, CreditCard, MapPin, ShieldCheck, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { NotificationBell } from '@/components/notification-bell';
import { bookingDateLabel, bookingRequest, rupees, type BookingDetail } from '@/lib/booking-api';
import { useAuthStore } from '@/lib/auth-store';

const outcomeLabel: Record<string, string> = {
  refund_customer: 'Refund Customer',
  release_provider: 'Release Payment to Provider',
  partial: 'Partial resolution',
  dismissed: 'Dismissed',
};

export default function BookingDetailPage() {
  const params = useParams<{ id: string }>();
  const token = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);
  const ready = useAuthStore((state) => state.ready);
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState('');
  const queryKey = ['bookings', 'detail', params.id];
  const detail = useQuery({
    queryKey,
    queryFn: () => bookingRequest<BookingDetail>(`/bookings/${params.id}`, token as string),
    enabled: Boolean(ready && token && params.id && user?.role !== 'admin'),
  });
  const raiseDispute = useMutation({
    mutationFn: () => bookingRequest<{ dispute: NonNullable<BookingDetail['dispute']> }>(`/bookings/${params.id}/disputes`, token as string, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    }),
    onSuccess: () => {
      setReason('');
      setFormError('');
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : 'Dispute could not be submitted.'),
  });

  if (!ready) return <main className="main-shell admin-loading" aria-label="Loading booking" />;
  if (!user || !token) return <main className="main-shell booking-center"><h1>Sign in to view this booking</h1><Link className="button button-primary" href="/login">Sign in</Link></main>;
  if (user.role === 'admin') return <main className="main-shell booking-center"><Link className="button button-primary" href="/admin">Open admin panel</Link></main>;
  const booking = detail.data?.booking;
  if (detail.isPending) return <main className="main-shell admin-loading" aria-label="Loading booking" />;
  if (!booking) return <main className="main-shell booking-center"><p className="form-error">{detail.error?.message ?? 'Booking not found.'}</p><Link className="button button-outline" href="/bookings">Back to bookings</Link></main>;
  const dispute = detail.data?.dispute;
  const canRaise = !dispute && !['cancelled', 'rejected'].includes(booking.status);

  return <>
    <header className="site-header"><div className="header-inner"><Link className="brand" href="/"><span className="brand-mark"><Wrench /></span>KaamSetu</Link><div className="header-actions"><NotificationBell /><Link className="button button-quiet" href="/bookings"><ArrowLeft />My bookings</Link></div></div></header>
    <main className="main-shell booking-detail-page">
      <span className="eyebrow"><Clock3 />Booking details</span><h1>{booking.business_name || booking.provider_name || booking.service_category}</h1>
      <div className="booking-detail-grid"><section className="booking-detail-main">
        <div className="booking-detail-status"><span className={`status-pill status-${booking.status}`}>{booking.status.replaceAll('_', ' ')}</span><span className={`status-pill status-${booking.payment_status}`}>{booking.payment_status.replaceAll('_', ' ')}</span>{dispute && <span className={`status-pill status-${dispute.status}`}><CircleAlert />Dispute {dispute.status}</span>}</div>
        <dl className="booking-summary"><div><dt>Service date</dt><dd>{bookingDateLabel(booking.scheduled_at)}</dd></div><div><dt>Service</dt><dd>{booking.service_category}</dd></div><div><dt>{user.role === 'customer' ? 'Professional' : 'Customer'}</dt><dd>{user.role === 'customer' ? booking.business_name || booking.provider_name : booking.customer_name}</dd></div><div><dt>Address</dt><dd><MapPin />{booking.service_address}</dd></div>{booking.notes && <div><dt>Notes</dt><dd>{booking.notes}</dd></div>}<div><dt>Total</dt><dd>{rupees(booking.amount_paise)}</dd></div></dl>
        <section className="booking-payment-panel"><h2><CreditCard />Payment activity</h2>{detail.data?.transactions.length ? detail.data.transactions.map((transaction) => <div className="booking-payment-row" key={transaction.id ?? transaction.razorpay_order_id}><span>{transaction.razorpay_order_id}</span><span className={`status-pill status-${transaction.status}`}>{transaction.status.replaceAll('_', ' ')}</span><strong>{rupees(transaction.amount_paise)}</strong></div>) : <p>No payment attempt is recorded yet.</p>}</section>
      </section>
      <aside className="booking-detail-aside">
        {dispute ? <section className="dispute-panel"><div className="eyebrow"><ShieldCheck />Dispute ticket</div><h2>{dispute.status === 'open' ? 'Under admin review' : outcomeLabel[dispute.outcome ?? 'dismissed']}</h2><p>{dispute.reason}</p><time>Raised {bookingDateLabel(dispute.created_at)}</time>{dispute.resolution_note && <div className="dispute-resolution-note"><strong>Resolution note</strong><span>{dispute.resolution_note}</span></div>}{dispute.refund_amount_paise && <div className="dispute-resolution-note"><strong>Refund</strong><span>{rupees(dispute.refund_amount_paise)}</span></div>}</section> : canRaise ? <section className="dispute-panel"><div className="eyebrow"><CircleAlert />Need help?</div><h2>Raise a dispute</h2><p>Tell us what went wrong with this booking. An admin will review the booking and payment details.</p>{formError && <p className="form-error" role="alert">{formError}</p>}<form onSubmit={(event) => { event.preventDefault(); raiseDispute.mutate(); }}><label className="form-field"><span>What happened?</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={20} maxLength={2000} required placeholder="Describe the issue in at least 20 characters." /></label><button className="button button-primary form-submit" disabled={raiseDispute.isPending || reason.trim().length < 20}>{raiseDispute.isPending ? 'Submitting…' : 'Submit dispute'}</button></form></section> : <div className="verification-note"><ShieldCheck />A dispute can’t be raised for a cancelled booking.</div>}
        <div className="booking-trust"><span><ShieldCheck />Only booking participants can view these details</span></div>
      </aside></div>
    </main>
  </>;
}