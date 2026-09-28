'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, BadgeCheck, BriefcaseBusiness, ChevronDown, CircleCheck, Clock3, Hammer, MapPin, Search, ShieldCheck, Sparkles, Star, Wrench } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { API_URL, type ProfilePage, type ProviderProfile } from '@/lib/api';
import { demoProfiles } from '@/lib/demo-profiles';
import { useAuthStore } from '@/lib/auth-store';
import { NotificationBell } from '@/components/notification-bell';

const categories = [
  { value: '', label: 'All services', icon: Sparkles },
  { value: 'electrician', label: 'Electricians', icon: Wrench },
  { value: 'plumber', label: 'Plumbers', icon: Wrench },
  { value: 'painter', label: 'Painters', icon: Hammer },
  { value: 'caterer', label: 'Catering', icon: BriefcaseBusiness },
  { value: 'technician', label: 'Technicians', icon: Wrench },
  { value: 'supplier', label: 'Materials', icon: BriefcaseBusiness },
];

function SkeletonCard() {
  return <div className="skeleton-card" aria-hidden="true"><div className="skeleton skeleton-photo" /><div className="skeleton-lines"><div className="skeleton skeleton-line medium" /><div className="skeleton skeleton-line short" /><div className="skeleton skeleton-line" /></div></div>;
}

function ProfileCard({ profile }: { profile: ProviderProfile }) {
  const category = categories.find((item) => item.value === profile.category)?.label ?? profile.category;
  return (
    <article className="provider-card">
      <div className="provider-photo">
        {profile.photo_url && <Image src={profile.photo_url} alt={`${profile.name}, ${category}`} fill sizes="(max-width: 680px) 50vw, (max-width: 960px) 50vw, 25vw" className="provider-photo-image" unoptimized loading="lazy" />}
        <span className="photo-category"><Wrench aria-hidden="true" />{category}</span>
      </div>
      <div className="provider-body">
        <div className="provider-title-line"><h3 title={profile.business_name || profile.name}>{profile.business_name || profile.name}</h3>{profile.is_featured ? <span className="featured-mark"><Sparkles aria-hidden="true" />Featured</span> : profile.verification_status === 'verified' ? <span className="verified-mark"><BadgeCheck aria-hidden="true" />Verified</span> : null}</div>
        <div className="provider-location"><MapPin aria-hidden="true" />{profile.service_area || profile.city}</div>
        <p className="provider-description">{profile.description || 'Local service professional ready to help with your next project.'}</p>
        <div className="provider-stats"><span className="rating"><Star fill="currentColor" aria-hidden="true" />{profile.rating ?? 'New'} {profile.rating ? `(${profile.review_count})` : 'rating'}</span><span><CircleCheck aria-hidden="true" />{profile.completed_jobs} jobs</span><span><Clock3 aria-hidden="true" />Replies quickly</span></div>
        <Link className="profile-link" href={`/profiles/${profile.id}`}>View profile <ArrowRight aria-hidden="true" /></Link>
      </div>
    </article>
  );
}

export function Marketplace() {
  const user = useAuthStore((state) => state.user);
  const [category, setCategory] = useState('');
  const [locationInput, setLocationInput] = useState('Ahmedabad');
  const [location, setLocation] = useState('Ahmedabad');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timeout = window.setTimeout(() => { setLocation(locationInput.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timeout);
  }, [locationInput]);

  const profilesQuery = useQuery({
    queryKey: ['profiles', category, location, page],
    queryFn: async (): Promise<ProfilePage> => {
      const params = new URLSearchParams({ page: String(page), limit: '8' });
      if (category) params.set('category', category);
      if (location) params.set('location', location);
      try {
        const response = await fetch(`${API_URL}/profiles?${params}`);
        if (!response.ok) throw new Error('Profile search unavailable');
        const live = await response.json() as ProfilePage;
        if (live.total > 0) return live;
      } catch {
        // Preview listings keep the search useful before local services are connected.
      }
      const matching = demoProfiles.filter((profile) => (!category || profile.category === category) && (!location || `${profile.city} ${profile.service_area}`.toLowerCase().includes(location.toLowerCase())));
      return { items: matching.slice((page - 1) * 8, page * 8), page, limit: 8, total: matching.length, totalPages: Math.max(1, Math.ceil(matching.length / 8)) };
    },
    placeholderData: (previous) => previous,
  });

  const profiles = profilesQuery.data?.items ?? [];
  const isPreview = profiles.some((profile) => profile.preview);
  const totalPages = profilesQuery.data?.totalPages ?? 1;
  const changeCategory = (value: string) => { setCategory(value); setPage(1); };
  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); setLocation(locationInput.trim()); setPage(1); };

  return <>
    <header className="site-header"><div className="header-inner"><Link className="brand" href="/" aria-label="KaamSetu home"><span className="brand-mark"><Wrench aria-hidden="true" /></span>KaamSetu</Link><nav className="header-nav" aria-label="Main navigation"><a href="#services">Explore services</a><a href="#pros">Local professionals</a></nav><div className="header-actions">{user ? <><NotificationBell /><Link className="button button-quiet mobile-bookings-link" href="/bookings">My bookings</Link>{user.role === 'admin' && <Link className="button button-quiet" href="/admin">Admin</Link>}</> : <Link className="button button-quiet" href="/login">Sign in</Link>}<Link className="button button-outline" href="/join">List your business <ChevronDown aria-hidden="true" /></Link></div></div></header>
    <main className="main-shell">
      <section className="market-hero" aria-labelledby="hero-title"><div className="hero-copy"><div className="eyebrow"><Sparkles aria-hidden="true" />Your neighbourhood, sorted</div><h1 id="hero-title">Good work starts with the right person.</h1><p>Find local professionals for the jobs that make a house feel like home.</p>
        <form className="search-panel" onSubmit={submitSearch}><label className="search-field"><Wrench aria-hidden="true" /><select aria-label="Service category" value={category} onChange={(event) => changeCategory(event.target.value)}>{categories.map((item) => <option key={item.value || 'all'} value={item.value}>{item.label}</option>)}</select></label><label className="search-field"><MapPin aria-hidden="true" /><input aria-label="City or neighbourhood" value={locationInput} onChange={(event) => setLocationInput(event.target.value)} placeholder="City or neighbourhood" /></label><button className="button button-amber search-submit" type="submit"><Search aria-hidden="true" />Find a pro</button></form>
        <div className="trust-line"><span><ShieldCheck aria-hidden="true" />KYC-checked professionals</span><span><Star fill="currentColor" aria-hidden="true" />Customer ratings</span><span><Clock3 aria-hidden="true" />Local, responsive help</span></div>
      </div></section>
      <section id="services" className="category-row" aria-label="Popular service categories">{categories.map(({ value, label, icon: Icon }) => <button type="button" key={value || 'all'} className={`category-chip${category === value ? ' active' : ''}`} aria-pressed={category === value} onClick={() => changeCategory(value)}><Icon aria-hidden="true" />{label}</button>)}</section>
      <section id="pros" aria-labelledby="results-title"><div className="listing-heading"><div><h2 id="results-title">Professionals near {location || 'you'}</h2><p>{profilesQuery.data?.total ?? 0} local profiles to explore</p></div><div className="listing-meta">{isPreview && <span className="preview-label"><Sparkles aria-hidden="true" />Preview listings</span>}</div></div>
        <div className="provider-grid" aria-live="polite">{profilesQuery.isPending ? Array.from({ length: 4 }, (_, index) => <SkeletonCard key={index} />) : profiles.length ? profiles.map((profile) => <ProfileCard key={profile.id} profile={profile} />) : <div className="empty-state"><Search aria-hidden="true" /><h3>No professionals found here yet</h3><p>Try another category or nearby city.</p></div>}</div>
        <nav className="pagination" aria-label="Profile pages"><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}><ArrowLeft aria-hidden="true" />Previous</button><span>Page {page} of {totalPages}</span><button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages}>Next<ArrowRight aria-hidden="true" /></button></nav>
      </section>
    </main>
    <footer className="site-footer"><div className="main-shell footer-inner"><span><strong>KaamSetu</strong> · Better local work, together.</span><span>For providers: <Link className="text-link" href="/join">Create a profile</Link></span></div></footer>
  </>;
}