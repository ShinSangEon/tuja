import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** GET /api/permits?signal_id=… → 그 신호와 같은 법정동의 최근 공장·창고 건축허가 (건축HUB). 수집 전이면 빈 배열. */
export async function GET(req) {
    const id = req.nextUrl.searchParams.get('signal_id') ?? '';
    if (!id || !process.env.DATABASE_URL) return NextResponse.json({ permits: [], bjdong: null });
    const { Pool } = await import('pg');
    globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
    const p = globalThis.__radarPool;
    try {
        const s = await p.query('select bjdong_cd from signals where id = $1', [id]);
        const code = s.rows[0]?.bjdong_cd;
        if (!code) return NextResponse.json({ permits: [], bjdong: null });
        const { rows } = await p.query(
            `select id, plat_plc, bld_nm, main_purps, arch_gb, tot_area::float as tot_area, plat_area::float as plat_area, jiyuk,
                    pms_day, stcns_sched_day, real_stcns_day, use_apr_day, lat, lng
               from permits where sigungu_cd = $1 and bjdong_cd = $2 order by pms_day desc limit 40`, [code.slice(0, 5), code.slice(5)]);
        return NextResponse.json({ permits: rows, bjdong: code });
    } catch (e) {
        // permits 테이블이 아직 없으면(첫 수집 전) 조용히 빈 결과
        return NextResponse.json({ permits: [], bjdong: null, error: e.message });
    }
}
