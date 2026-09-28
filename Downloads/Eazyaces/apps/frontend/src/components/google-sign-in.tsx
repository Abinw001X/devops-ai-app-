'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { useAuthStore, type User } from '@/lib/auth-store';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => void;
          renderButton: (element: HTMLElement, options: { theme: string; size: string; shape: string; width: number }) => void;
        };
      };
    };
  }
}

type Session = { accessToken: string; user: User };

export function GoogleSignIn({ onError }: { onError: (message: string) => void }) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const setSession = useAuthStore((state) => state.setSession);
  const router = useRouter();
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!clientId || !buttonRef.current) return;
    let script = document.querySelector<HTMLScriptElement>('script[data-google-identity]');
    const initialize = () => {
      if (!window.google || !buttonRef.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async ({ credential }) => {
          try {
            const response = await fetch(`${API_URL}/auth/google`, {
              method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ credential }),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error ?? 'Google sign-in failed.');
            const session = body as Session;
            setSession(session.accessToken, session.user);
            router.push('/');
          } catch (error) {
            onError(error instanceof Error ? error.message : 'Google sign-in failed.');
          }
        },
      });
      window.google.accounts.id.renderButton(buttonRef.current, { theme: 'outline', size: 'large', shape: 'rectangular', width: 320 });
    };
    if (window.google) {
      initialize();
      return;
    }
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.googleIdentity = 'true';
      script.onload = initialize;
      document.head.append(script);
    } else script.addEventListener('load', initialize, { once: true });
  }, [clientId, onError, router, setSession]);

  if (!clientId) return <p className="auth-note">Google sign-in is available when configured by the site owner.</p>;
  return <div className="google-button" ref={buttonRef} aria-label="Continue with Google" />;
}