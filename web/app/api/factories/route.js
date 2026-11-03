import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** GET /api/factories?name=회사명 → 등록공장 목록 (비상장 포함). 좌표 없는 건 lat null. */
export async function GET(req) {
    const name = req.nextUrl.searchParams.get('name') ?? '';
    if (name.length < 2 || !process.env.DATABASE_URL) return NextResponse.json({ factories: [] });
    const { Pool } = await import('pg');
    globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
    const norm = name.replace(/\(주\)|㈜|주식회사|유한회사|\s+|·|ㆍ/g, '').toLowerCase();
    try {
        const { rows } = await globalThis.__radarPool.query(
            'select id, company_raw, complex, products, address, sido, sigungu, lat, lng from factories where company_norm = $1 order by sido, sigungu limit 60', [norm]);
        return NextResponse.json({ factories: rows });
    } catch (e) {
        return NextResponse.json({ factories: [], error: e.message });
    }
}
