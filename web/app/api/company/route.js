import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** GET /api/company?corp_code=00155276 → companies 행 (없으면 404). 조회 시에만 DB 접속. */
export async function GET(req) {
    const code = req.nextUrl.searchParams.get('corp_code');
    if (!code || !process.env.DATABASE_URL) return NextResponse.json({ error: 'no' }, { status: 404 });
    const { Pool } = await import('pg');
    globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
    try {
        const { rows } = await globalThis.__radarPool.query('select * from companies where corp_code = $1', [code]);
        if (!rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 });
        const r = rows[0];
        // 다른 투자 건(같은 회사)도 같이
        const { rows: others } = await globalThis.__radarPool.query(
            'select id, company_name, sido, sigungu, event_type, stage, amount_krw, relevance_score, grade from signals where corp_code = $1 and not archived order by relevance_score desc', [code]);
        const norm = (x) => String(x ?? '').replace(/\(주\)|㈜|주식회사|유한회사|\s+|·|ㆍ/g, '').toLowerCase();
        const norms = [...new Set([norm(r.corp_name), ...others.map((s) => norm(s.company_name))].filter(Boolean))];
        const { rows: factories } = await globalThis.__radarPool.query(
            'select id, company_raw, complex, products, address, sido, sigungu, lat, lng from factories where company_norm = any($1) order by sido, sigungu limit 60', [norms]).catch(() => ({ rows: [] }));
        return NextResponse.json({ ...r, signals: others.map((s) => ({ ...s, amount_krw: s.amount_krw == null ? null : Number(s.amount_krw) })), factories });
    } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
