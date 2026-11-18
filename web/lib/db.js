// 공용 DB 연결 (Neon). 요청마다 새로 붙지 않도록 전역에 한 번만 만든다.
export async function pool() {
  const { Pool } = await import('pg');
  globalThis.__radarPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
  return globalThis.__radarPool;
}

// 검색 기록·조사 요청 테이블 (처음 쓸 때 만든다)
export async function ensureSearchLog(p) {
  if (globalThis.__searchLogReady) return;
  await p.query(`create table if not exists search_log (
    id bigserial primary key, q text not null, q_norm text, n_results int, requested boolean not null default false,
    note text, requested_by text, status text not null default 'open', answer text, answered_at timestamptz,
    created_at timestamptz not null default now())`);
  await p.query('create index if not exists search_log_qn_idx on search_log (q_norm)');
  globalThis.__searchLogReady = true;
}
