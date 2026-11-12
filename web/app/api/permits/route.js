import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** GET /api/permits?unknown=1 → 회사 미확인 대형 공사 전체.
 *  GET /api/permits?signal_id=… → 그 신호와 같은 법정동의 최근 공장·창고 건축허가 (건축HUB). 수집 전이면 빈 배열. */
export async function GET(req) {
    const id = req.nextUrl.searchParams.get('signal_id') ?? '';
    const unknown = req.nextUrl.searchParams.get('unknown') === '1';
    if ((!id && !unknown) || !process.env.DATABASE_URL) return NextResponse.json({ permits: [], bjdong: null });
    const { Pool } = await import('pg');
    globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
    const p = globalThis.__radarPool;
    if (unknown) {
        // 회사 미확인 대형 공사: 1만㎡ 이상 신·증·개축, 미준공, 건물명·카카오 조회 모두 회사를 못 찾은 허가
        try {
            const { rows } = await p.query(
                `select id, plat_plc, bld_nm, main_purps, arch_gb, tot_area::float as tot_area, plat_area::float as plat_area, jiyuk,
                        pms_day, stcns_sched_day, real_stcns_day, use_apr_day, lat, lng, guess_cands, true as unknown
                   from permits where guess_src = 'none' and lat is not null and coalesce(use_apr_day,'') = ''
                    and pms_day >= to_char(now() - interval '730 days', 'YYYYMMDD')
                  order by tot_area desc limit 80`);
            return NextResponse.json({ permits: rows });
        } catch (e) {
            return NextResponse.json({ permits: [], error: e.message });
        }
    }
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
