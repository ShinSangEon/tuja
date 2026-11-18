import { NextResponse } from 'next/server';
import { pool, ensureSearchLog } from '@/lib/db';
import { normName } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * 검색창 기록과 '조사 요청'.
 *   POST { q, n }                          → 검색 기록 (같은 검색어는 10분에 한 번만)
 *   POST { q, n, request: true, note, by } → 조사 요청. 다음 '레이더 업데이트' 때 담당자가 조사해 답을 단다 (collector: run.py requests)
 *   GET  ?q=케이조선                        → 그 검색어의 조사 요청·답변
 *   GET  ?list=1                           → 최근 조사 요청 전체 (주간보고서용)
 */
export async function POST(req) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ ok: false });
  const { q, n, request, note, by } = await req.json();
  const qq = String(q ?? '').trim().slice(0, 80);
  if (qq.length < 2) return NextResponse.json({ ok: false }, { status: 400 });
  const p = await pool();
  await ensureSearchLog(p);
  const qn = normName(qq);
  if (!request) {
    const { rows } = await p.query("select 1 from search_log where q_norm = $1 and not requested and created_at > now() - interval '10 minutes' limit 1", [qn]);
    if (rows.length) return NextResponse.json({ ok: true, dup: true });
  }
  const { rows } = await p.query(
    'insert into search_log (q, q_norm, n_results, requested, note, requested_by) values ($1,$2,$3,$4,$5,$6) returning id, created_at',
    [qq, qn, Number.isFinite(n) ? n : null, !!request, request ? String(note ?? '').slice(0, 500) || null : null, request ? String(by ?? '').slice(0, 40) || null : null],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
}

export async function GET(req) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ requests: [] });
  const p = await pool();
  await ensureSearchLog(p);
  const sp = req.nextUrl.searchParams;
  if (sp.get('list')) {
    const { rows } = await p.query(`select id, q, note, requested_by, status, answer, answered_at, created_at from search_log
                                    where requested order by (status = 'open') desc, created_at desc limit 40`);
    return NextResponse.json({ requests: rows });
  }
  const q = (sp.get('q') ?? '').trim();
  if (q.length < 2) return NextResponse.json({ requests: [] });
  const { rows } = await p.query(`select id, q, note, requested_by, status, answer, answered_at, created_at from search_log
                                  where requested and q_norm = $1 order by created_at desc limit 5`, [normName(q)]);
  return NextResponse.json({ requests: rows });
}
