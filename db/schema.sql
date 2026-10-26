-- GENEQ 투자 레이더 — PostgreSQL 스키마 (Neon, GENEQ 계정 전용 프로젝트)
-- Neon 콘솔 → 프로젝트 → SQL Editor 에 그대로 붙여넣어 실행. 전용 DB 이므로 public 스키마에 둔다.

create extension if not exists pgcrypto;

-- 1) 원문 보관. 같은 URL은 한 번만.
create table if not exists raw_documents (
  id            uuid primary key default gen_random_uuid(),
  source_type   text not null,            -- dart | naver_news | press | data_go_kr | manual
  source_name   text,                     -- 'DART', '연합뉴스', '경상남도' ...
  source_tier   smallint not null default 3, -- 1 공식 / 2 주요언론 / 3 기타
  url           text not null unique,
  url_hash      text generated always as (md5(url)) stored,
  title         text,
  body          text,                     -- 90일 후 purge 가능
  published_at  timestamptz,
  fetched_at    timestamptz not null default now(),
  meta          jsonb not null default '{}'::jsonb,  -- rcept_no, corp_code, 키워드 등
  prefilter_pass boolean,                 -- 키워드 사전필터 통과 여부
  extracted     boolean not null default false
);
create index if not exists raw_documents_published_idx on raw_documents (published_at desc);
create index if not exists raw_documents_pending_idx on raw_documents (extracted) where not extracted;

-- 2) AI 추출 결과. 문서 1건당 1건 (실패도 저장).
create table if not exists extractions (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references raw_documents(id) on delete cascade,
  model         text,
  is_relevant   boolean,
  irrelevant_reason text,
  payload       jsonb,                    -- docs/02-schema.md 의 JSON 전체
  confidence    numeric(3,2),
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists extractions_doc_idx on extractions (document_id);

-- 3) 최종 신호(투자 건). 병합된 결과.
create table if not exists signals (
  id            uuid primary key default gen_random_uuid(),
  -- 회사
  company_name  text not null,            -- 표시용 (name_raw 중 최선)
  company_norm  text not null,            -- 정규화 (병합 키)
  corp_code     text,                     -- DART 고유번호
  company_group text,
  listed        boolean,
  -- 이벤트
  event_type    text not null,            -- new_plant | expansion | retrofit | equipment | relocation | other
  stage         text not null,            -- disclosure | mou | permit | construction | completed
  summary       text,
  purpose       text,
  -- 투자
  amount_krw    bigint,
  amount_disclosed boolean default false,
  amount_conflict  boolean default false,
  period_start  text,                     -- YYYY-MM
  period_end    text,
  floor_area_m2 numeric,
  size_class    char(1) not null default 'U',  -- S / M / L / U
  -- 지역
  sido          text,
  sigungu       text,
  industrial_complex text,
  address_raw   text,
  location_precision text,                -- address | complex | sigungu | sido | unknown
  lat           double precision,
  lng           double precision,
  geocode_status text default 'pending',  -- pending | ok | fallback_complex | fallback_region | unlocated
  -- 업종·관련도
  sector        text,
  process_hint  text,
  need_compressed_air smallint default 0,
  need_dryer          smallint default 0,
  need_hmi            smallint default 0,
  need_rationale      text,
  relevance_score     smallint default 0,
  -- 신뢰
  grade         char(1) not null default 'C',  -- A / B / C (자동)
  manual_grade  char(1),                        -- 사람이 승격/강등
  confidence    numeric(3,2),
  source_count  int not null default 1,
  -- 수명
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  archived      boolean not null default false,
  stale         boolean not null default false,
  -- 영업 액션 (Phase 2)
  owner         text,                     -- 담당자
  contact_status text default 'none',     -- none | planned | contacted | meeting | quoted | won | lost
  network_note  text,                     -- "○○전무 → 공장장 지인"
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists signals_dedupe_idx on signals (company_norm, sido, event_type);
create index if not exists signals_map_idx on signals (archived, grade, size_class, relevance_score desc);
create index if not exists signals_geo_idx on signals (lat, lng) where lat is not null;

-- 4) 신호 ↔ 출처 N:M
create table if not exists signal_sources (
  signal_id     uuid not null references signals(id) on delete cascade,
  document_id   uuid not null references raw_documents(id) on delete cascade,
  extraction_id uuid references extractions(id) on delete set null,
  primary key (signal_id, document_id)
);

-- 5) 회사명 별칭 (운영하며 채움)
create table if not exists company_aliases (
  alias_norm    text primary key,         -- 'lg엔솔'
  canonical_norm text not null,           -- 'lg에너지솔루션'
  corp_code     text
);

-- 6) 산업단지 마스터 (공공데이터포털 전국산업단지현황 CSV 적재)
create table if not exists industrial_complexes (
  id            serial primary key,
  name          text not null,
  name_norm     text not null unique,     -- 공백·'일반산업단지' 등 접미사 제거
  sido          text,
  sigungu       text,
  lat           double precision,
  lng           double precision,
  meta          jsonb default '{}'::jsonb
);

-- 7) 시도·시군구 중심점 (폴백용). collector/seed_regions.py 가 채움.
create table if not exists regions (
  id            serial primary key,
  sido          text not null,
  sigungu       text,                     -- null 이면 시도 중심
  lat           double precision not null,
  lng           double precision not null,
  unique (sido, sigungu)
);

-- 8) 지오코딩 캐시 (카카오 API 중복 호출 방지)
create table if not exists geocode_cache (
  query         text primary key,
  lat           double precision,
  lng           double precision,
  ok            boolean not null,
  cached_at     timestamptz not null default now()
);

-- 9) 영업 활동 로그 (Phase 2)
create table if not exists signal_activities (
  id            uuid primary key default gen_random_uuid(),
  signal_id     uuid not null references signals(id) on delete cascade,
  actor         text,
  kind          text,                     -- note | call | visit | quote | status_change
  content       text,
  created_at    timestamptz not null default now()
);

-- updated_at 자동 갱신
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists signals_updated_at on signals;
create trigger signals_updated_at before update on signals for each row execute function set_updated_at();

-- 대시보드가 읽는 뷰
create or replace view v_signals_map as
select s.*,
       coalesce(s.manual_grade, s.grade) as effective_grade,
       (select json_agg(json_build_object('title', d.title, 'url', d.url, 'source', d.source_name,
                                          'tier', d.source_tier, 'published_at', d.published_at)
                        order by d.source_tier, d.published_at desc)
          from signal_sources ss join raw_documents d on d.id = ss.document_id
         where ss.signal_id = s.id) as sources
  from signals s
 where not s.archived;
