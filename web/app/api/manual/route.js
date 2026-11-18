import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { pool } from '@/lib/db';
import { normName } from '@/lib/format';

export const dynamic = 'force-dynamic';

// collector/config.py 와 같은 값
const INDUSTRY = { 이차전지: 40, 반도체: 40, 디스플레이: 40, '제약·바이오': 35, '식품·음료': 35, '자동차·부품': 30, '조선·해양': 30, '항공·방산': 30,
  '화학·소재': 25, '철강·금속': 25, '기계·장비': 25, 전자부품: 20, 섬유: 15, 에너지: 15, '물류·창고': 5, 데이터센터: 5, 기타: 10 };
const STAGE_W = { watch: 0, disclosure: 15, mou: 15, permit: 10, construction: 5, completed: 0 };
const TYPES = ['demand', 'equipment', 'expansion', 'new_plant', 'retrofit', 'relocation', 'other'];
const clamp3 = (v) => Math.max(0, Math.min(3, Number(v) || 0));

function sizeClass(amount, type, stage) {
  if (amount) return amount < 5e9 ? 'S' : amount < 5e10 ? 'M' : 'L';
  if (stage === 'watch' || type === 'demand') return 'U';
  if (type === 'new_plant' || stage === 'mou') return 'L';
  return 'U';
}

/**
 * 영업 직접 등록 — 영업이 아는 건(교체 계획 등)을 신호로 올린다.
 * 원문(raw_documents, source_type=manual)과 판독 결과(extractions)를 같이 저장하므로 레이더 재집계(rebuild) 뒤에도 남고,
 * 같은 회사의 뉴스·공시와 자동으로 합쳐진다. 지도에는 바로 보이도록 signals 에도 한 줄 넣는다.
 */
export async function POST(req) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'DB 없음' }, { status: 503 });
  const b = await req.json();
  const company = String(b.company ?? '').trim().slice(0, 60);
  const summary = String(b.summary ?? '').trim().slice(0, 600);
  const by = String(b.by ?? '').trim().slice(0, 30);
  if (company.length < 2 || summary.length < 5 || !by) return NextResponse.json({ error: '회사명, 내용, 입력자는 꼭 적어 주세요.' }, { status: 400 });
  const type = TYPES.includes(b.type) ? b.type : 'demand';
  const stage = type === 'demand' ? 'watch' : (STAGE_W[b.stage] != null && b.stage !== 'watch' ? b.stage : 'mou');
  const sector = INDUSTRY[b.sector] != null ? b.sector : '기타';
  const need = { compressed_air: clamp3(b.need_air), dryer: clamp3(b.need_dryer), hmi_control: clamp3(b.need_hmi) };
  const amount = b.amount_eok ? Math.round(Number(b.amount_eok) * 1e8) || null : null;
  const lat = Number.isFinite(b.lat) ? b.lat : null, lng = Number.isFinite(b.lng) ? b.lng : null;
  const sido = b.sido || null, sigungu = String(b.sigungu ?? '').trim() || null, address = String(b.address ?? '').trim() || null;
  const score = Math.max(0, Math.min(100, INDUSTRY[sector] + 5 * (need.compressed_air + need.dryer + need.hmi_control) + STAGE_W[stage]));
  const rationale = String(b.rationale ?? '').trim() || '영업 확인 정보';

  const payload = {
    is_relevant: true, irrelevant_reason: null, _model: 'manual',
    company: { name_raw: company, name_norm: company, group: null, listed: null, corp_code: null },
    event: { type, stage, summary, purpose: b.purpose || null },
    investment: { amount_krw: amount, amount_disclosed: !!amount, period_start: null, period_end: b.period_end || null, floor_area_m2: null },
    location: { sido, sigungu, industrial_complex: null, address_raw: address, precision: address ? 'address' : sigungu ? 'sigungu' : sido ? 'sido' : 'unknown' },
    industry: { sector, process_hint: null },
    utility_need: { ...need, rationale },
    confidence: 0.9,
  };

  const p = await pool();
  const c = await p.connect();
  try {
    await c.query('begin');
    const url = `manual://${randomUUID()}`;
    const doc = await c.query(
      `insert into raw_documents (source_type, source_name, source_tier, url, title, body, published_at, meta, prefilter_pass, extracted)
       values ('manual', $1, 1, $2, $3, $4, now(), $5, true, true) returning id`,
      [`영업 등록 · ${by}`, url, `[영업 등록] ${company} — ${summary.slice(0, 70)}`, summary, JSON.stringify({ by })],
    );
    const docId = doc.rows[0].id;
    const ex = await c.query(
      `insert into extractions (document_id, model, is_relevant, payload, confidence) values ($1, 'manual', true, $2, 0.9) returning id`,
      [docId, JSON.stringify(payload)],
    );
    const cust = await c.query(
      `select name from customers where lower(regexp_replace(name, '\\s', '', 'g')) = $1 or name_norm = $1 or $2 = any(coalesce(aliases, '{}'::text[])) limit 1`,
      [normName(company), normName(company)],
    ).catch(() => ({ rows: [] }));
    const sig = await c.query(
      `insert into signals (company_name, company_norm, event_type, stage, summary, purpose, amount_krw, amount_disclosed, period_end, size_class,
                            sido, sigungu, address_raw, location_precision, lat, lng, geocode_status, sector,
                            need_compressed_air, need_dryer, need_hmi, need_rationale, relevance_score, grade, confidence, source_count, customer_name)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'A',0.9,1,$24) returning id`,
      [company, normName(company), type, stage, summary, b.purpose || null, amount, !!amount, b.period_end || null, sizeClass(amount, type, stage),
        sido, sigungu, address, payload.location.precision, lat, lng, lat != null ? 'ok' : 'unlocated', sector,
        need.compressed_air, need.dryer, need.hmi_control, rationale, score, cust.rows[0]?.name ?? null],
    );
    const sid = sig.rows[0].id;
    await c.query('insert into signal_sources (signal_id, document_id, extraction_id) values ($1,$2,$3)', [sid, docId, ex.rows[0].id]);
    await c.query(`insert into signal_activities (signal_id, actor, kind, content) values ($1, $2, 'note', $3)`, [sid, by, `영업 등록: ${summary}`]);
    await c.query('commit');
    const { rows } = await p.query('select * from v_signals_map where id = $1', [sid]);
    const r = rows[0];
    return NextResponse.json({ ok: true, signal: r ? { ...r, amount_krw: r.amount_krw == null ? null : Number(r.amount_krw), lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng) } : null });
  } catch (e) {
    await c.query('rollback').catch(() => {});
    return NextResponse.json({ error: `저장하지 못했습니다: ${e.message}` }, { status: 500 });
  } finally {
    c.release();
  }
}
