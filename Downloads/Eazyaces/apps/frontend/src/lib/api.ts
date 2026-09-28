export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

export type ProviderProfile = {
  id: string;
  name: string;
  business_name?: string | null;
  category: string;
  city: string;
  service_area: string;
  description: string;
  photo_url?: string | null;
  base_price_paise?: number | null;
  verification_status: 'pending_verification' | 'verified' | 'rejected';
  subscription_status?: 'inactive' | 'active' | 'payment_failed' | 'expired' | 'cancelled';
  is_live?: boolean;
  is_featured?: boolean;
  rating?: number | null;
  review_count: number;
  completed_jobs: number;
  preview?: boolean;
};

export type ProfilePage = { items: ProviderProfile[]; page: number; limit: number; total: number; totalPages: number };

export async function apiRequest<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, { credentials: 'include', ...init });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error ?? 'The request could not be completed.');
  return body as T;
}