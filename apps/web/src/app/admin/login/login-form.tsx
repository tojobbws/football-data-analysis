'use client';

import { useActionState } from 'react';
import { login } from '../actions';

export function LoginForm({ forbidden }: { forbidden: boolean }) {
  const [state, action, pending] = useActionState(login, undefined);
  const error = state?.error ?? (forbidden ? 'บัญชีนี้ไม่มีสิทธิ์เข้าหลังบ้าน' : undefined);
  return (
    <form action={action} className="space-y-3">
      <label className="block text-sm">
        อีเมล
        <input name="email" type="email" autoComplete="username" required className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
      </label>
      <label className="block text-sm">
        รหัสผ่าน
        <input name="password" type="password" autoComplete="current-password" required className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
      </label>
      {error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
      <button disabled={pending} className="w-full rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {pending ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
      </button>
    </form>
  );
}
