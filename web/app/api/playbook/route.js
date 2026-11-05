import { NextResponse } from 'next/server';
import { SEED, GROUP_LABEL, detectGroup } from '@/lib/playbooks';

export const dynamic = 'force-dynamic';
const FIELDS = ['channel', 'channel_url', 'registration', 'tips'];

function pool() {
    const { Pool } = require('pg');
    globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
    return globalThis.__radarPool;
}
async function ensure(p) {
    await p.query(`create table if not exists playbooks (
        key text primary key, channel text, channel_url text, registration text, tips text,
        updated_by text, updated_at timestamptz not null default now())`);
}
async function merged(p, key) {
    const seed = SEED[key] ?? SEED.general;
    let row = null;
    try { await ensure(p); row = (await p.query('select * from playbooks where key = $1', [key])).rows[0] ?? null; } catch { row = null; }
    const out = { key, label: GROUP_LABEL[key] ?? key, verify: !!seed.verify, edited: !!row };
    for (const f of FIELDS) out[f] = row?.[f] ?? seed[f] ?? '';
    if (row) { out.updated_by = row.updated_by; out.updated_at = row.updated_at; out.verify = false; }
    return out;
}

/** GET /api/playbook?company=…&group=…  또는 ?key=… */
export async function GET(req) {
    const sp = req.nextUrl.searchParams;
    const key = sp.get('key') || detectGroup(sp.get('company') ?? '', sp.get('group') ?? '');
    if (!process.env.DATABASE_URL) { const s = SEED[key] ?? SEED.general; return NextResponse.json({ key, label: GROUP_LABEL[key] ?? key, verify: !!s.verify, edited: false, ...s }); }
    return NextResponse.json(await merged(pool(), key));
}

/** POST { key, actor, channel?, channel_url?, registration?, tips? } — 팀이 고친 내용 저장 */
export async function POST(req) {
    if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 500 });
    const b = await req.json().catch(() => ({}));
    const key = String(b.key ?? '').trim();
    if (!key || !(key in SEED) && !/^[a-z0-9_-]{1,40}$/.test(key)) return NextResponse.json({ error: 'key 오류' }, { status: 400 });
    const actor = String(b.actor ?? '').trim().slice(0, 40) || null;
    const p = pool();
    try {
        await ensure(p);
        const cur = await merged(p, key);
        const vals = FIELDS.map((f) => (b[f] !== undefined ? String(b[f]).slice(0, 2000) : cur[f]));
        await p.query(`insert into playbooks (key, channel, channel_url, registration, tips, updated_by, updated_at) values ($1,$2,$3,$4,$5,$6,now())
                       on conflict (key) do update set channel = excluded.channel, channel_url = excluded.channel_url, registration = excluded.registration, tips = excluded.tips, updated_by = excluded.updated_by, updated_at = now()`,
            [key, ...vals, actor]);
        return NextResponse.json(await merged(p, key));
    } catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}
