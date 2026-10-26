"""수집 소스. 각 모듈은 fetch(since: date) -> list[dict] 를 제공하고,
dict 는 raw_documents 컬럼과 같은 키(source_type, source_name, source_tier, url, title, body, published_at, meta)를 가진다."""
