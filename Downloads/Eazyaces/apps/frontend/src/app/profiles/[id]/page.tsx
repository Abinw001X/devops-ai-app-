import { ArrowLeft, BadgeCheck, MapPin, ShieldCheck, Star, Wrench } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { API_URL, type ProviderProfile } from '@/lib/api';
import { demoProfiles } from '@/lib/demo-profiles';

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let profile: ProviderProfile | undefined;
  if (id.startsWith('sample-')) profile = demoProfiles.find((item) => item.id === id);
  else {
    try {
      const serverApiUrl = process.env.INTERNAL_API_URL ?? API_URL;
      const response = await fetch(`${serverApiUrl}/profiles/${id}`, { next: { revalidate: 60 } });
      if (response.ok) profile = await response.json() as ProviderProfile;
    } catch {
      profile = undefined;
    }
  }
  if (!profile) notFound();
  const category = profile.category.charAt(0).toUpperCase() + profile.category.slice(1);
  return <>
    <header className="site-header"><div className="header-inner"><Link className="brand" href="/"><span className="brand-mark"><Wrench /></span>KaamSetu</Link><Link className="button button-quiet" href="/"><ArrowLeft />Back to search</Link></div></header>
    <main className="main-shell profile-detail"><p className="eyebrow">{category} · {profile.city}</p><h1>{profile.business_name || profile.name}</h1><p className="provider-location"><MapPin />{profile.service_area}</p><div className="profile-detail-photo">{profile.photo_url && <Image src={profile.photo_url} alt={`${profile.name} profile`} fill sizes="(max-width: 900px) 100vw, 900px" unoptimized priority />}</div><div className="profile-detail-summary"><span className="verified-mark"><BadgeCheck />{profile.verification_status === 'verified' ? 'Verified' : 'Verification pending'}</span><span className="rating"><Star fill="currentColor" />{profile.rating ?? 'New'} {profile.rating ? `(${profile.review_count} reviews)` : 'rating'}</span><span><ShieldCheck />{profile.completed_jobs} completed jobs</span>{profile.base_price_paise && <span>From ₹{(profile.base_price_paise / 100).toLocaleString('en-IN')}</span>}</div><h2>About this service</h2><p className="profile-detail-description">{profile.description}</p>{profile.preview && <div className="verification-note"><ShieldCheck />This is a sample profile shown in preview mode. Live profiles come from the connected service.</div>}{!profile.preview && <Link className="button button-amber" href={`/book/${profile.id}`}>Book service</Link>}</main>
  </>;
}