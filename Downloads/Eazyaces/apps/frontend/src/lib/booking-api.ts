export const BOOKING_API_URL = process.env.NEXT_PUBLIC_BOOKING_API_URL ?? 'http://localhost:4001/api';
export const NOTIFICATION_API_URL = process.env.NEXT_PUBLIC_NOTIFICATION_API_URL ?? BOOKING_API_URL;

export type BookingStatus = 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'rejected';
export type PaymentStatus = 'pending' | 'created' | 'paid' | 'failed' | 'refund_pending' | 'refunded' | 'partially_refunded';

export type Availability = {
  provider: {
    id: string;
    name: string;
    business_name: string | null;
    category: string;
    city: string;
    service_area: string;
    base_price_paise: number | string;
  };
  date: string;
  slots: string[];
  currency: 'INR';
  platformFeePaise: number;
};

export type Booking = {
  id: string;
  customer_id: string;
  provider_id: string;
  service_category: string;
  scheduled_at: string;
  service_address: string;
  notes: string;
  status: BookingStatus;
  amount_paise: number | string;
  platform_fee_paise: number | string;
  payment_status: PaymentStatus;
  provider_name?: string;
  business_name?: string;
  provider_city?: string;
  customer_name?: string;
  created_at: string;
  updated_at: string;
  dispute_status?: 'open' | 'resolved' | null;
  dispute_outcome?: 'refund_customer' | 'release_provider' | 'partial' | 'dismissed' | null;
};

export type BookingPage = { items: Booking[]; page: number; limit: number; total: number; totalPages: number };
export type Dispute = { id: string; raised_by: string; reason: string; status: 'open' | 'resolved'; outcome: 'refund_customer' | 'release_provider' | 'partial' | 'dismissed' | null; resolution_note?: string | null; refund_amount_paise?: number | string | null; created_at: string; resolved_at?: string | null };
export type BookingDetail = { booking: Booking; transactions: PaymentTransaction[]; dispute: Dispute | null };
export type PaymentTransaction = {
  id?: string;
  razorpay_order_id: string;
  razorpay_payment_id?: string | null;
  amount_paise: number | string;
  status: PaymentStatus;
  failure_reason?: string | null;
  created_at: string;
  updated_at?: string;
};

export async function bookingRequest<T>(endpoint: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BOOKING_API_URL}${endpoint}`, {
    credentials: 'include',
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(body?.error ?? 'The request could not be completed.') as Error & { code?: string; status?: number };
    error.code = body?.code;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

export async function fetchAvailability(providerId: string, date: string, signal?: AbortSignal): Promise<Availability> {
  const response = await fetch(`${BOOKING_API_URL}/providers/${providerId}/availability?date=${encodeURIComponent(date)}`, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? 'Availability could not be loaded.');
  return body as Availability;
}

export function rupees(amountPaise: number | string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(amountPaise) / 100);
}

export function bookingDateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value));
}

export function todayInIndia(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export const customerBookingsKey = ['bookings', 'customer'] as const;
export const providerBookingsKey = ['bookings', 'provider'] as const;
