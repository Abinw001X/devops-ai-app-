'use client';

import { Bell, CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { NOTIFICATION_API_URL } from '@/lib/booking-api';
import { useAuthStore } from '@/lib/auth-store';

type Notification = {
  id: string;
  event_type: string;
  title: string;
  body: string;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
  read_at: string | null;
};

async function notificationRequest<T>(endpoint: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${NOTIFICATION_API_URL}${endpoint}`, {
    credentials: 'include',
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error ?? 'The request could not be completed.');
  return body as T;
}

export function NotificationBell() {
  const token = useAuthStore((state) => state.accessToken);
  const [inbox, setInbox] = useState<{ token: string | null; items: Notification[] }>({ token: null, items: [] });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const load = () => notificationRequest<Notification[]>('/notifications', token).then((notifications) => {
      if (active) setInbox({ token, items: notifications });
    }).catch(() => undefined);
    void load();
    const socketUrl = NOTIFICATION_API_URL.replace(/\/api\/?$/, '');
    const socket = io(socketUrl, { auth: { token }, transports: ['websocket', 'polling'] });
    socket.on('notification', (notification: Notification) => {
      setInbox((current) => ({ token, items: [notification, ...(current.token === token ? current.items : []).filter((item) => item.id !== notification.id)].slice(0, 50) }));
    });
    return () => {
      active = false;
      socket.disconnect();
    };
  }, [token]);

  if (!token) return null;
  const items = inbox.token === token ? inbox.items : [];
  const unread = items.filter((item) => !item.read_at).length;

  async function markRead(item: Notification) {
    if (item.read_at || !token) return;
    setInbox((current) => ({ token, items: (current.token === token ? current.items : []).map((entry) => entry.id === item.id ? { ...entry, read_at: new Date().toISOString() } : entry) }));
    await notificationRequest(`/notifications/${item.id}/read`, token, { method: 'PATCH' }).catch(() => undefined);
  }

  async function markAllRead() {
    if (!token) return;
    setInbox((current) => ({ token, items: (current.token === token ? current.items : []).map((entry) => ({ ...entry, read_at: entry.read_at ?? new Date().toISOString() })) }));
    await notificationRequest('/notifications/read-all', token, { method: 'PATCH' }).catch(() => undefined);
  }

  return <div className="notification-wrap">
    <button className="notification-trigger" type="button" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <Bell aria-hidden="true" />{unread > 0 && <span className="notification-count">{unread > 9 ? '9+' : unread}</span>}
    </button>
    {open && <section className="notification-menu" aria-label="Notifications">
      <div className="notification-menu-head"><strong>Notifications</strong><button type="button" disabled={!unread} onClick={() => void markAllRead()}><CheckCheck />Mark all read</button></div>
      {items.length ? <ul>{items.map((item) => {
        const href = item.reference_type === 'booking' && item.reference_id ? `/bookings/${item.reference_id}` : item.reference_type === 'provider' ? '/admin' : '/bookings';
        return <li className={item.read_at ? '' : 'unread'} key={item.id}>
          <Link href={href} onClick={() => { void markRead(item); setOpen(false); }}><span className="notification-item-title">{item.title}</span><span className="notification-item-body">{item.body}</span><time>{new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.created_at))}</time></Link>
        </li>;
      })}</ul> : <p className="notification-empty">You’re all caught up.</p>}
    </section>}
  </div>;
}