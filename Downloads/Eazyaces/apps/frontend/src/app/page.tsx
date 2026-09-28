import type { Metadata } from 'next';
import { Marketplace } from '@/components/marketplace';

export const metadata: Metadata = {
  title: 'Home services in Ahmedabad | KaamSetu',
  description: 'Explore electricians, plumbers, painters, caterers and local service companies in Ahmedabad.',
};

export default function Home() {
  return <Marketplace />;
}
