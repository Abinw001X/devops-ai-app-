'use client';

import { useEffect } from 'react';
import { QueryProvider } from '@/components/query-provider';
import { apiRequest } from '@/lib/api';
import { useAuthStore, type User } from '@/lib/auth-store';

type Session = { accessToken: string; user: User };
let refreshRequest: Promise<Session | null> | undefined;

function restoreSession() {
  refreshRequest ??= apiRequest<Session>('/auth/refresh', { method: 'POST' }).catch(() => null);
  return refreshRequest;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const setSession = useAuthStore((state) => state.setSession);
  const setReady = useAuthStore((state) => state.setReady);
  useEffect(() => {
    let active = true;
    restoreSession().then((session) => {
      if (!active) return;
      if (session) setSession(session.accessToken, session.user);
      setReady();
    });
    return () => { active = false; };
  }, [setReady, setSession]);
  return <QueryProvider>{children}</QueryProvider>;
}