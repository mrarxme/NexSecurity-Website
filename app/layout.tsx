import type { Metadata } from 'next';
import { Manrope, JetBrains_Mono } from 'next/font/google';
import { RegisterServiceWorker } from '@/components/RegisterServiceWorker';
import { SitePopup } from '@/components/SitePopup';
import { NotificationPrompt } from '@/components/NotificationPrompt';
import { DeviceSignalCollector } from '@/components/DeviceSignalCollector';
import './globals.css';

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'NexSecurity — Private Learning Space',
  description: 'Authorized members only.',
  robots: { index: false, follow: false },
  icons: { icon: '/logo.png', shortcut: '/logo.png', apple: '/logo.png' },
  verification: { google: '7VfuwzozReuUwaodd5kmJAMF9HbifQWHX0aU-EUfpYg' },
  manifest: '/manifest.json',
  themeColor: '#3D6EFF',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-vault-950 font-body text-ink antialiased">
        <RegisterServiceWorker />
        <SitePopup />
        <NotificationPrompt />
        <DeviceSignalCollector />
        {children}
      </body>
    </html>
  );
}
