import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * GET /api/signals?grade=A,B&size=L,M&stage=mou&sido=경상남도&minScore=40&q=배터리
 * DATABASE_URL 이 있으면 Neon 의 v_signals_map 을 조회 (조회할 때만 DB 가 깨어남),
 * 없거나 실패하면 public/sample-signals.json 으로 폴백.
 */
export async function GET(req) {
    const p = req.nextUrl.searchParams;
    const grades = (p.get('grade') ?? 'A,B').split(',').filter(Boolean);
    const sizes = (p.get('size') ?? '').split(',').filter(Boolean);
    const stages = (p.get('stage') ?? '').split(',').filter(Boolean);
    const sidos = (p.get('sido') ?? '').split(',').filter(Boolean);
    const minScore = Number(p.get('minScore') ?? 0);
    const q = (p.get('q') ?? '').trim();

    let rows;
    let source = 'sample';
    if (process.env.DATABASE_URL) {
        try {
            rows = await fromDb();
            source = 'db';
        } catch (e) {
            console.warn('radar: DB 조회 실패, 샘플로 폴백:', e?.message);
        }
    }
    if (!rows) {
        const file = path.join(process.cwd(), 'public', 'sample-signals.json');
        rows = JSON.parse(await fs.readFile(file, 'utf-8'));
    }

    const filtered = rows.filter((s) => {
        const g = s.effective_grade ?? s.manual_grade ?? s.grade;
        if (grades.length && !grades.includes(g)) return false;
        if (sizes.length && !sizes.includes(s.size_class)) return false;
        if (stages.length && !stages.includes(s.stage)) return false;
        if (sidos.length && !sidos.includes(s.sido ?? '')) return false;
        if (s.relevance_score < minScore) return false;
        if (q) {
            const hay = `${s.company_name} ${s.summary ?? ''} ${s.sector ?? ''} ${s.sigungu ?? ''} ${s.industrial_complex ?? ''}`.toLowerCase();
            if (!hay.includes(q.toLowerCase())) return false;
        }
        return true;
    });

    return NextResponse.json({ source, total: rows.length, count: filtered.length, signals: filtered });
}

async function fromDb() {
    const { Pool } = await import('pg');
    globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
    const { rows } = await globalThis.__radarPool.query(
        'select * from v_signals_map order by relevance_score desc, last_seen_at desc limit 2000',
    );
    return rows.map((r) => ({
        ...r,
        amount_krw: r.amount_krw == null ? null : Number(r.amount_krw),
        lat: r.lat == null ? null : Number(r.lat),
        lng: r.lng == null ? null : Number(r.lng),
        confidence: r.confidence == null ? null : Number(r.confidence),
    }));
}
