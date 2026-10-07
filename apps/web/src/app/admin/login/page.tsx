import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'เข้าสู่ระบบหลังบ้าน', robots: { index: false, follow: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="mb-6 text-center text-xl font-bold">🧭 หลังบ้าน</h1>
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <LoginForm forbidden={error === 'forbidden'} />
      </div>
    </main>
  );
}
