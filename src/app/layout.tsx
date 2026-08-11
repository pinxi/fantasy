import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { sourceHealthStrip } from '@/services/leagues';

export const metadata: Metadata = {
  title: 'fantasy terminal',
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const health = sourceHealthStrip();
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="no-print flex items-center gap-4 border-b border-zinc-800 px-4 py-2">
          <Link href="/" className="font-bold tracking-wider text-zinc-100">
            FNTSY<span className="text-emerald-400">▮</span>
          </Link>
          <span className="text-xs text-zinc-500">league-conditional value terminal</span>
          <div className="ml-auto flex items-center gap-2">
            {health.map((h) => (
              <span key={h.source} title={`${h.source}${h.message ? ` — ${h.message}` : ''}`} className="flex items-center gap-1 text-[10px] text-zinc-500">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    !h.ok ? 'bg-red-500' : h.stale ? 'bg-amber-400' : h.message ? 'bg-amber-400' : 'bg-emerald-500'
                  }`}
                />
                {h.source.replace('sleeper_stats', 'stats').replace('fantasycalc', 'fc').replace('fantasypros', 'fp')}
              </span>
            ))}
          </div>
        </header>
        <main className="px-4 py-4">{children}</main>
      </body>
    </html>
  );
}
