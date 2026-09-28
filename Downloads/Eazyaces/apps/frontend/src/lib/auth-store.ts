import { create } from 'zustand';

export type User = { id: string; name: string; email: string | null; phone: string | null; role: 'customer' | 'technician' | 'company' | 'admin' };
type AuthState = { accessToken: string | null; user: User | null; ready: boolean; setReady: () => void; setSession: (accessToken: string, user: User) => void; clearSession: () => void };

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  ready: false,
  setReady: () => set({ ready: true }),
  setSession: (accessToken, user) => set({ accessToken, user, ready: true }),
  clearSession: () => set({ accessToken: null, user: null, ready: true }),
}));