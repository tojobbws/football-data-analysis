import type { Compass } from '@/lib/queries';
import { MARKET, ROUND, odds, pct, selectionLabel } from '@/lib/labels';
import { dateTimeTH } from '@/lib/time';
import { StatusBadge } from './ui';

/** 🧭 เข็มทิศเกม — the most prominent block on the match page. */
export function CompassCard({ c, home, away }: { c: Compass; home: string; away: string }) {
  if (c.kind === 'NO_CLEAR_SIGNAL') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-500">🧭 เข็มทิศเกม</p>
            <p className="mt-1 text-2xl font-bold">🌫️ หมอกข้อมูล</p>
            <p className="mt-1 text-sm text-slate-600">ไม่มีตลาดใดมี Data Support เพียงพอ — เราไม่บังคับเลือกทุกคู่</p>
          </div>
          <StatusBadge status="NO_SIGNAL" />
        </div>
        {c.reason ? <p className="mt-4 whitespace-pre-line rounded-xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-700">{c.reason}</p> : null}
        <Footer c={c} />
      </div>
    );
  }
  const label = selectionLabel(c.market!, c.selection!, c.line == null ? null : Number(c.line), home, away);
  return (
    <div className="rounded-2xl border-2 border-[var(--color-compass)]/30 bg-gradient-to-br from-[var(--color-compass-soft)] to-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--color-compass)]">🧭 เข็มทิศเกม · {MARKET[c.market!] ?? c.market}</p>
          <p className="mt-1 text-3xl font-bold tracking-tight">{label}</p>
        </div>
        <StatusBadge status={c.status} />
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat k="Signal" v={c.signal_strength ?? '–'} />
        <Stat k="Model Probability" v={pct(c.model_probability, 1)} />
        <Stat k="Market Probability" v={pct(c.market_probability, 1)} />
        <Stat k="ราคาอ้างอิง" v={odds(c.odds_at_publish)} />
      </dl>
      {c.reason ? <p className="mt-4 whitespace-pre-line rounded-xl bg-white/70 p-3 text-sm leading-relaxed text-slate-700">{c.reason}</p> : null}
      {c.result_score ? <p className="mt-3 text-sm text-slate-600">ผล 90 นาที: <b>{c.result_score}</b></p> : null}
      <Footer c={c} />
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl bg-white/80 px-3 py-2 ring-1 ring-slate-200/70">
      <dt className="text-[11px] text-slate-500">{k}</dt>
      <dd className="text-lg font-semibold tabular-nums">{v}</dd>
    </div>
  );
}

function Footer({ c }: { c: Compass }) {
  return (
    <p className="mt-4 text-xs text-slate-500">
      วิเคราะห์เมื่อ {dateTimeTH(c.published_at)} · {ROUND[c.publish_round] ?? c.publish_round} · {c.public_id} ·{' '}
      <span title={c.record_hash} className="font-mono">
        hash {c.record_hash.slice(0, 12)}…
      </span>
      {c.settled_at ? <> · ตัดสินผล {dateTimeTH(c.settled_at)}</> : null}
    </p>
  );
}
