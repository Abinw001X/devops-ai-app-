'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarDays, CircleAlert, Wrench } from 'lucide-react';
import Link from 'next/link';
import { NotificationBell } from '@/components/notification-bell';
import { bookingDateLabel, bookingRequest, customerBookingsKey, providerBookingsKey, rupees, type BookingPage } from '@/lib/booking-api';
import { useAuthStore } from '@/lib/auth-store';

export default function BookingsPage() {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.accessToken);
  const ready = useAuthStore((state) => state.ready);
  const providerView = user?.role === 'technician' || user?.role === 'company';
  const bookings = useQuery({
    queryKey: providerView ? providerBookingsKey : customerBookingsKey,
    queryFn: () => bookingRequest<BookingPage>(providerView ? '/bookings/provider' : '/bookings/customer', token as string),
    enabled: Boolean(ready && token && user && user.role !== 'admin'),
  });

  if (!ready) return <main className="main-shell admin-loading" aria-label="Loading bookings" />;
  if (!user || !token) return <main className="main-shell booking-center"><h1>Sign in to view your bookings</h1><Link className="button button-primary" href="/login">Sign in</Link></main>;
  if (user.role === 'admin') return <main className="main-shell booking-center"><h1>Booking oversight is in the admin panel</h1><Link className="button button-primary" href="/admin">Open admin panel</Link></main>;

  const items = bookings.data?.items ?? [];
  return <>
    <header className="site-header"><div className="header-inner"><Link className="brand" href="/"><span className="brand-mark"><Wrench /></span>KaamSetu</Link><div className="header-actions"><NotificationBell /><Link className="button button-quiet" href="/">Marketplace</Link></div></div></header>
    <main className="main-shell booking-center">
      <div className="admin-heading"><div><span className="eyebrow"><CalendarDays />{providerView ? 'Provider workspace' : 'Customer account'}</span><h1>{providerView ? 'Incoming bookings' : 'My bookings'}</h1><p>{providerView ? 'Track requests, payments, and any open disputes.' : 'Your service requests, payment status, and support cases.'}</p></div></div>
      {bookings.isError && <p className="form-error" role="alert">{bookings.error.message}</p>}
      {bookings.isPending ? <div className="booking-list-skeleton" /> : items.length ? <div className="booking-list">
        {items.map((booking) => <article className="booking-list-row" key={booking.id}>
          <div className="booking-list-date"><strong>{bookingDateLabel(booking.scheduled_at)}</strong><span>{booking.service_category}</span></div>
          <div className="booking-list-provider"><strong>{providerView ? booking.customer_name : booking.business_name || booking.provider_name}</strong><span>{providerView ? 'Customer' : booking.provider_city}</span></div>
          <div className="booking-list-state"><span className={`status-pill status-${booking.status}`}>{booking.status.replaceAll('_', ' ')}</span><span className={`status-pill status-${booking.payment_status}`}>{booking.payment_status.replaceAll('_', ' ')}</span>{booking.dispute_status && <span className={`status-pill status-${booking.dispute_status}`}><CircleAlert />Dispute {booking.dispute_status}</span>}</div>
          <div className="booking-list-total"><strong>{rupees(booking.amount_paise)}</strong><Link className="button button-outline" href={`/bookings/${booking.id}`}>Details<ArrowRight /></Link></div>
        </article>)}
      </div> : <div className="booking-empty"><CalendarDays /><h2>No bookings yet</h2><p>{providerView ? 'New customer requests will appear here.' : 'Your confirmed service requests will appear here.'}</p>{!providerView && <Link className="button button-primary" href="/">Find a professional</Link>}</div>}
      {bookings.isError && <div className="verification-note"><CircleAlert />We couldn’t load your bookings right now.</div>}
    </main>
  </>;
}