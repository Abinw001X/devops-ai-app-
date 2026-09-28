'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, BadgeCheck, CalendarDays, Check, Clock3, CreditCard, MapPin, ShieldCheck, WalletCards, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { bookingRequest, fetchAvailability, rupees, todayInIndia, type Availability, type Booking } from '@/lib/booking-api';
import { useAuthStore } from '@/lib/auth-store';
import { openRazorpayCheckout } from '@/lib/razorpay-checkout';

const times = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

function BookingSkeleton() {
  return <div className="booking-skeleton" aria-label="Loading availability"><div className="booking-skeleton-line wide" /><div className="booking-skeleton-line" /><div className="booking-slot-skeleton">{times.slice(0, 6).map((time) => <span className="booking-skeleton-line" key={time} />)}</div><div className="booking-skeleton-line wide" /></div>;
}

export default function BookingPage() {
  const params = useParams<{ providerId: string }>();
  const providerId = params.providerId;
  const today = todayInIndia();
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const ready = useAuthStore((state) => state.ready);
  const accessToken = useAuthStore((state) => state.accessToken);
  const [date, setDate] = useState(today);
  const [selectedTime, setSelectedTime] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [step, setStep] = useState(1);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState('');
  const [paymentMessage, setPaymentMessage] = useState('');

  const availability = useQuery<Availability>({
    queryKey: ['availability', providerId, date],
    queryFn: ({ signal }) => fetchAvailability(providerId, date, signal),
    enabled: Boolean(providerId && date),
    staleTime: 15_000,
    retry: 1,
  });

  const createBooking = useMutation({
    mutationFn: () => bookingRequest<Booking>('/bookings', accessToken as string, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, date, time: selectedTime, address, notes }),
    }),
    onSuccess: (created) => {
      setBooking(created);
      queryClient.setQueryData(['bookings', 'detail', created.id], { booking: created, transactions: [] });
      setStep(3);
      setError('');
    },
    onError: (reason) => {
      setError(reason instanceof Error ? reason.message : 'This slot is no longer available. Choose another time.');
      void queryClient.invalidateQueries({ queryKey: ['availability', providerId, date] });
    },
  });

  async function startPayment() {
    if (!booking || !accessToken || !user) return;
    setError('');
    setPaymentMessage('');
    try {
      const order = await bookingRequest<import('@/lib/razorpay-checkout').RazorpayOrder>('/payments/orders', accessToken, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: booking.id }),
      });
      await openRazorpayCheckout({
        order,
        description: `${availability.data?.provider.business_name || availability.data?.provider.name || 'Local service'} booking`,
        prefill: { name: user.name, email: user.email ?? '', contact: user.phone ?? '' },
        onSuccess: async (checkoutResponse) => {
          try {
            const verification = await bookingRequest<{ status: string; bookingId: string; message?: string }>('/payments/verify', accessToken, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ bookingId: booking.id, ...checkoutResponse }),
            });
            if (verification.status === 'paid') {
              setPaymentMessage('Payment received. Your request is now with the service professional.');
              router.push(`/bookings/${booking.id}`);
            } else setPaymentMessage(verification.message ?? 'Payment is processing. This page will keep checking for confirmation.');
            void queryClient.invalidateQueries({ queryKey: ['bookings'] });
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Payment verification is taking longer than expected. Check your booking status before retrying.');
          }
        },
        onDismiss: () => setPaymentMessage('Checkout closed. Your booking is saved, but payment is not complete. You can retry without creating another booking.'),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Payment could not start. Try again.');
    }
  }

  const provider = availability.data?.provider;
  const amount = booking ? Number(booking.amount_paise) : Number(provider?.base_price_paise ?? 0);
  const fee = booking ? Number(booking.platform_fee_paise) : availability.data?.platformFeePaise ?? 0;
  const total = amount + fee;

  if (!ready) return <BookingSkeleton />;
  if (!user) return <main className="main-shell booking-shell"><Link className="button button-quiet" href={`/profiles/${providerId}`}><ArrowLeft />Back to profile</Link><div className="booking-alert"><ShieldCheck /><div><h1>Sign in to request a service</h1><p>Your booking details will be attached to your KaamSetu account.</p><Link className="button button-primary" href={`/login?next=/book/${providerId}`}>Sign in</Link></div></div></main>;
  if (user.role !== 'customer') return <main className="main-shell booking-shell"><div className="booking-alert"><ShieldCheck /><div><h1>Customer account required</h1><p>Sign in with a customer account to request this service.</p><Link className="button button-outline" href="/">Back to marketplace</Link></div></div></main>;

  return <>
    <header className="site-header"><div className="header-inner"><Link className="brand" href="/"><span className="brand-mark"><Wrench /></span>KaamSetu</Link><Link className="button button-quiet" href={`/profiles/${providerId}`}><ArrowLeft />Back to profile</Link></div></header>
    <main className="main-shell booking-shell">
      <div className="booking-heading"><div className="eyebrow"><CalendarDays />Service booking</div><h1>Book a local professional</h1><p>Choose a time, review the full price, then pay securely online.</p></div>
      <nav className="stepper" aria-label="Booking steps">{['Service details', 'Review', 'Payment'].map((label, index) => <div className={`stepper-step${step === index + 1 ? ' current' : ''}${step > index + 1 ? ' done' : ''}`} key={label}><span className="stepper-number">{step > index + 1 ? <Check /> : index + 1}</span><span>{label}</span></div>)}</nav>
      {error && <div className="booking-error" role="alert">{error}</div>}
      {paymentMessage && <div className="booking-info" role="status">{paymentMessage}</div>}

      <div className="booking-layout"><section className="booking-form-panel">
        {step === 1 && <>
          <h2>When should they visit?</h2>
          <div className="booking-field"><label htmlFor="booking-date">Choose a date</label><input id="booking-date" type="date" min={today} value={date} onChange={(event) => { setDate(event.target.value); setSelectedTime(''); }} /></div>
          <div className="booking-field"><label>Select a time <span>9:00 am – 5:00 pm · India time</span></label>
            {availability.isPending ? <BookingSkeleton /> : availability.isError ? <div className="booking-error">{availability.error.message} <button type="button" onClick={() => void availability.refetch()}>Try again</button></div> : availability.data?.slots.length ? <div className="slot-grid">{times.map((time) => <button key={time} type="button" className={`slot-button${selectedTime === time ? ' selected' : ''}`} disabled={!availability.data?.slots.includes(time)} aria-pressed={selectedTime === time} onClick={() => setSelectedTime(time)}>{time}</button>)}</div> : <div className="booking-empty">No times are available on this date. Pick another day.</div>}
          </div>
          <div className="booking-field"><label htmlFor="booking-address">Service address</label><textarea id="booking-address" value={address} onChange={(event) => setAddress(event.target.value)} minLength={8} maxLength={500} placeholder="Flat or house number, street, neighbourhood, city" /></div>
          <div className="booking-field"><label htmlFor="booking-notes">Notes for the professional <span>Optional</span></label><textarea id="booking-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} placeholder="Share access details or what you need help with." /></div>
          <button className="button button-primary booking-next" type="button" disabled={!selectedTime || address.trim().length < 8 || availability.isPending} onClick={() => { setError(''); setStep(2); }}>Review booking <ArrowRight /></button>
        </>}

        {step === 2 && <>
          <h2>Review your request</h2><p className="booking-subtitle">Check the details and price before creating your booking.</p>
          <dl className="booking-summary"><div><dt>Service professional</dt><dd>{provider?.business_name || provider?.name}<span>{provider?.category} · {provider?.city}</span></dd></div><div><dt>Date & time</dt><dd>{new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeZone: 'Asia/Kolkata' }).format(new Date(`${date}T12:00:00+05:30`))}<span>{selectedTime} IST</span></dd></div><div><dt>Service address</dt><dd>{address}</dd></div>{notes && <div><dt>Notes</dt><dd>{notes}</dd></div>}</dl>
          <div className="price-breakdown"><div><span>Service amount</span><strong>{rupees(amount)}</strong></div><div><span>Platform fee</span><strong>{fee ? rupees(fee) : '₹0.00'}</strong></div><div className="price-total"><span>Total to pay</span><strong>{rupees(total)}</strong></div><p>No hidden charges. This is the amount you will pay online.</p></div>
          <div className="booking-actions"><button className="button button-outline" type="button" onClick={() => setStep(1)}><ArrowLeft />Edit details</button><button className="button button-primary" type="button" disabled={createBooking.isPending || !availability.data} onClick={() => createBooking.mutate()}>{createBooking.isPending ? 'Checking slot…' : 'Confirm and continue'}<ArrowRight /></button></div>
        </>}

        {step === 3 && booking && <>
          <h2>Pay securely</h2><p className="booking-subtitle">Your request is saved. Complete payment to send it to the professional.</p>
          <div className="payment-choice"><div className="payment-choice-icon"><WalletCards /></div><div><strong>UPI is ready</strong><span>PhonePe, Google Pay, Paytm and other UPI apps</span></div><BadgeCheck /></div>
          <div className="payment-secondary"><CreditCard /><span>Cards and netbanking are also available in secure checkout.</span></div>
          <div className="price-breakdown"><div><span>Service amount</span><strong>{rupees(amount)}</strong></div><div><span>Platform fee</span><strong>{fee ? rupees(fee) : '₹0.00'}</strong></div><div className="price-total"><span>Total payable</span><strong>{rupees(total)}</strong></div><p>Paid only after Razorpay confirms the transaction.</p></div>
          <button className="button button-primary booking-next" type="button" onClick={() => void startPayment()}><ShieldCheck />Pay {rupees(total)} securely</button>
          <p className="secure-note"><ShieldCheck />Protected by Razorpay · Test mode is safe for trying the flow.</p>
          <Link className="booking-secondary-link" href={`/bookings/${booking.id}`}>Check payment and booking status</Link>
        </>}
      </section>
      <aside className="booking-aside"><span className="booking-aside-icon"><MapPin /></span><h2>Clear before you confirm</h2><p>We show the provider’s starting price and any platform fee before payment. The total above is what Razorpay will charge.</p><div className="booking-trust"><span><ShieldCheck />Secure online payment</span><span><Clock3 />Times shown in India time</span></div></aside></div>
    </main>
  </>;
}