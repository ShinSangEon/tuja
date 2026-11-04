import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const STATUSES = ['none', 'planned', 'contacted', 'meeting', 'quoted', 'won', 'lost'];
const KINDS = ['note', 'call', 'visit', 'quote', 'status_change'];

function pool() {
    const { Pool } = require('pg');
    globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
    return globalThis.__radarPool;
}

async function current(p, id) {
    const [s, a] = await Promise.all([
        p.query('select owner, contact_status, network_note from signals where id = $1', [id]),
        p.query('select id, actor, kind, content, created_at from signal_activities where signal_id = $1 order by created_at desc limit 50', [id]),
    ]);
    return { ...(s.rows[0] ?? {}), activities: a.rows };
}

/** GET /api/activity?signal_id=… → 담당·상태·메모 + 활동 기록 */
export async function GET(req) {
    const id = req.nextUrl.searchParams.get('signal_id');
    if (!id || !process.env.DATABASE_URL) return NextResponse.json({ activities: [] });
    try { return NextResponse.json(await current(pool(), id)); }
    catch (e) { return NextResponse.json({ activities: [], error: e.message }, { status: 500 }); }
}

/** POST { signal_id, actor, kind?, content?, status?, owner?, network_note? }
 *  상태·담당·메모 변경은 signals 에 쓰고, 변경 내용은 활동 기록으로도 남긴다. */
export async function POST(req) {
    if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 500 });
    const b = await req.json().catch(() => ({}));
    const id = b.signal_id;
    const actor = String(b.actor ?? '').trim().slice(0, 40) || null;
    if (!id) return NextResponse.json({ error: 'signal_id 필요' }, { status: 400 });
    const p = pool();
    try {
        const sets = [], vals = [], notes = [];
        if (b.status !== undefined) {
            if (!STATUSES.includes(b.status)) return NextResponse.json({ error: '상태 값 오류' }, { status: 400 });
            sets.push(`contact_status = $${vals.push(b.status)}`); notes.push(`상태 → ${b.status}`);
        }
        if (b.owner !== undefined) { const o = String(b.owner).trim().slice(0, 40) || null; sets.push(`owner = $${vals.push(o)}`); notes.push(`담당 → ${o ?? '미배정'}`); }
        if (b.network_note !== undefined) { const n = String(b.network_note).trim().slice(0, 300) || null; sets.push(`network_note = $${vals.push(n)}`); notes.push('인맥 메모 수정'); }
        if (sets.length) {
            vals.push(id);
            await p.query(`update signals set ${sets.join(', ')} where id = $${vals.length}`, vals);
        }
        const content = String(b.content ?? '').trim().slice(0, 1000);
        const kind = KINDS.includes(b.kind) ? b.kind : (sets.length ? 'status_change' : 'note');
        const text = content || (sets.length ? notes.join(' · ') : '');
        if (text) await p.query('insert into signal_activities (signal_id, actor, kind, content) values ($1,$2,$3,$4)', [id, actor, kind, text]);
        return NextResponse.json(await current(p, id));
    } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
