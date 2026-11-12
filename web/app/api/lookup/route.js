import { NextResponse } from 'next/server';
import { TIER2_PRESS } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * 실시간 검색 — DB 에 없는 회사를 그 자리에서 찾는다. 서버(Vercel)가 조회하므로 어느 기기에서든 동작.
 *   GET  /api/lookup?q=포스코퓨처엠        → { news:[...], dart:[...], corp:{...}|null }
 *   POST /api/lookup  { q, items:[...] }   → 선택한 기사·공시를 raw_documents 에 넣는다 (다음 "레이더 업데이트" 때 분석)
 */
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; GENEQ-InvestRadar/0.1)' };
const INVEST_WORDS = '공장 OR 증설 OR 신설 OR 착공 OR 투자협약 OR 설비투자 OR 준공';

function norm(s) {
    return String(s).replace(/\(주\)|㈜|주식회사|유한회사|\s+|·|ㆍ/g, '').toLowerCase();
}
function tierOf(name) {
    return TIER2_PRESS.includes(name) ? 2 : 3;
}
function rssItems(xml) {
    const out = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const b = m[1];
        const g = (tag) => (b.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`)) || [])[1]?.trim() ?? '';
        let title = g('title');
        const source = g('source');
        title = title.replace(/\s*-\s*[^-]+$/, '');
        out.push({ title, url: g('link'), source, tier: tierOf(source), published_at: g('pubDate') ? new Date(g('pubDate')).toISOString() : null, kind: 'news' });
    }
    return out;
}

async function pool() {
    const { Pool } = await import('pg');
    globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
    return globalThis.__radarPool;
}

export async function GET(req) {
    const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
    if (q.length < 2) return NextResponse.json({ error: '두 글자 이상 입력하세요' }, { status: 400 });

    const result = { q, news: [], dart: [], corp: null, errors: [] };

    // 1) 구글뉴스: 회사명 + 투자 키워드, 최근 1년
    try {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`"${q}" (${INVEST_WORDS}) when:1y`)}&hl=ko&gl=KR&ceid=KR:ko`;
        const r = await fetch(url, { headers: UA, cache: 'no-store' });
        result.news = rssItems(await r.text()).slice(0, 25);
    } catch (e) { result.errors.push(`뉴스: ${e.message}`); }

    // 2) DART: 상장사면 코드 찾아 최근 1년 투자 관련 공시
    if (process.env.DATABASE_URL) {
        try {
            const p = await pool();
            const n = norm(q);
            const { rows } = await p.query('select corp_code, corp_name, stock_code from corp_codes where name_norm = $1 or name_norm like $2 order by length(name_norm) limit 1', [n, `%${n}%`]);
            if (rows[0]) {
                result.corp = rows[0];
                if (process.env.DART_API_KEY) {
                    const end = new Date(), bgn = new Date(Date.now() - 365 * 86400e3);
                    const f = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
                    const dr = await fetch(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${process.env.DART_API_KEY}&corp_code=${rows[0].corp_code}&bgn_de=${f(bgn)}&end_de=${f(end)}&page_count=100&last_reprt_at=Y`, { cache: 'no-store' });
                    const dj = await dr.json();
                    const KW = ['신규시설투자', '유형자산양수', '비유동자산취득', '시설투자', '공장'];
                    result.dart = (dj.list ?? []).filter((i) => KW.some((k) => i.report_nm.includes(k))).map((i) => ({
                        title: `[${i.corp_name}] ${i.report_nm.trim()}`, url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${i.rcept_no}`, source: 'DART', tier: 1,
                        published_at: `${i.rcept_dt.slice(0, 4)}-${i.rcept_dt.slice(4, 6)}-${i.rcept_dt.slice(6, 8)}T00:00:00+09:00`, kind: 'dart', rcept_no: i.rcept_no, corp_code: i.corp_code, corp_name: i.corp_name,
                    }));
                } else result.errors.push('DART_API_KEY 미설정 — 공시는 건너뜀');
            }
        } catch (e) { result.errors.push(`DART: ${e.message}`); }
    }
    return NextResponse.json(result);
}

export async function POST(req) {
    if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'DB 없음' }, { status: 503 });
    const { q, items } = await req.json();
    if (!Array.isArray(items) || !items.length) return NextResponse.json({ error: '항목 없음' }, { status: 400 });
    const p = await pool();
    let added = 0;
    for (const it of items.slice(0, 50)) {
        const meta = it.kind === 'dart' ? { rcept_no: it.rcept_no, corp_code: it.corp_code, corp_name: it.corp_name, lookup_q: q } : { keyword: `lookup:${q}`, lookup_q: q };
        const { rowCount } = await p.query(
            `insert into raw_documents (source_type, source_name, source_tier, url, title, body, published_at, meta)
             values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (url) do nothing`,
            [it.kind === 'dart' ? 'dart' : 'naver_news', it.source, it.tier, it.url, it.title, it.title, it.published_at, JSON.stringify(meta)],
        );
        added += rowCount;
    }
    return NextResponse.json({ added, total: items.length });
}
