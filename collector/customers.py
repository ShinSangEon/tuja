"""기존 거래처(드라이어 납품 이력) 매칭 — customers.yaml → customers 테이블 → signals.customer_name.

기존 고객의 증설은 가장 따기 쉬운 영업이라 지도·목록·보고서에서 따로 색을 준다.
"""
from __future__ import annotations

import logging
from pathlib import Path

import yaml

from validate import normalize_company

log = logging.getLogger(__name__)
YAML = Path(__file__).parent / "customers.yaml"

SCHEMA = """
create table if not exists customers (
  name text primary key,
  name_norm text not null,
  aliases text[] not null default '{}',   -- 정규화된 별칭
  sites text, note text,
  updated_at timestamptz not null default now()
);
alter table signals add column if not exists customer_name text;
"""


def load_yaml(c, path: Path = YAML) -> int:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    rows = data.get("customers") or []
    c.execute(SCHEMA)
    c.execute("delete from customers")
    for r in rows:
        name = str(r["name"]).strip()
        aliases = sorted({normalize_company(a) for a in (r.get("aliases") or []) if a})
        c.execute("insert into customers (name, name_norm, aliases, sites, note) values (%s,%s,%s,%s,%s)",
                  (name, normalize_company(name), aliases, ", ".join(map(str, r.get("sites") or [])) or None, r.get("note")))
    log.info("customers: %d 건 적재", len(rows))
    return len(rows)


class Matcher:
    """signals 회사명(정규화)·그룹명 → 거래처 이름. 짧은 별칭(2자 이하)은 완전일치만."""

    def __init__(self, c):
        c.execute(SCHEMA)
        self.rows = c.execute("select name, name_norm, aliases from customers").fetchall()
        self.keys: list[tuple[str, str]] = []  # (norm, name)
        for r in self.rows:
            for k in [r["name_norm"], *(r["aliases"] or [])]:
                if k:
                    self.keys.append((k, r["name"]))
        self.keys.sort(key=lambda x: -len(x[0]))  # 긴 키 우선 (포스코퓨처엠 > 포스코)

    def match(self, company_norm: str | None, group: str | None = None) -> str | None:
        cn = (company_norm or "").lower()
        if not cn:
            return None
        for k, name in self.keys:
            if cn == k:
                return name
            if len(k) >= 3 and (cn.startswith(k) or (len(cn) >= 3 and k.startswith(cn))):
                return name
        gn = normalize_company(group) if group else ""
        if gn:
            for k, name in self.keys:
                if gn == k or (len(k) >= 3 and gn.startswith(k)):
                    return name
        return None
