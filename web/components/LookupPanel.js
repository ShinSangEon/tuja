"use client";

import { useEffect, useState } from "react";
import { fmtDate } from "@/lib/format";

/**
 * DB 에 없는 회사를 실시간으로 찾는 패널.
 * 서버(/api/lookup)가 구글뉴스·DART 를 조회 → 결과 목록 → "레이더에 추가" 하면 수집함(raw_documents)에 들어가고
 * 다음 "레이더 업데이트" 때 분석·병합되어 핀으로 올라온다.
 */
export default function LookupPanel({ q, inDb }) {
  const [state, setState] = useState({ status: "idle", data: null });
  const [picked, setPicked] = useState(new Set());
  const [queued, setQueued] = useState(null);

  useEffect(() => {
    if (!q || q.length < 2) return;
    const ctl = new AbortController();
    setState({ status: "loading", data: null }); setPicked(new Set()); setQueued(null);
    fetch(`/api/lookup?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
      .then((r) => r.json())
      .then((d) => {
        setState({ status: "done", data: d });
        setPicked(new Set([...(d.dart ?? []), ...(d.news ?? [])].map((x) => x.url)));
      })
      .catch((e) => { if (e.name !== "AbortError") setState({ status: "error", data: null }); });
    return () => ctl.abort();
  }, [q]);

  const d = state.data;
  const all = d ? [...(d.dart ?? []), ...(d.news ?? [])] : [];
  const toggle = (url) => setPicked((p) => { const n = new Set(p); n.has(url) ? n.delete(url) : n.add(url); return n; });

  async function queue() {
    const items = all.filter((x) => picked.has(x.url));
    const r = await fetch("/api/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q, items }) });
    const j = await r.json();
    setQueued(j);
  }

  return (
    <div className="lookup">
      <div className="lookup-head">
        <h3>{inDb ? `‘${q}’ 전체 웹 검색` : `‘${q}’ 은(는) 레이더에 아직 없습니다`}</h3>
        <p>구글뉴스(최근 1년)와 DART 공시를 지금 바로 찾아 봅니다.</p>
      </div>

      {state.status === "loading" && <p className="lookup-note">찾는 중…</p>}
      {state.status === "error" && <p className="lookup-note warn">검색에 실패했습니다. 잠시 후 다시 시도하세요.</p>}

      {d && (
        <>
          <p className="lookup-sum">
            {d.corp ? <>상장사 <b>{d.corp.corp_name}</b>({d.corp.stock_code}) · </> : <>비상장 또는 DART 미등록 · </>}
            공시 <b>{d.dart.length}</b>건, 기사 <b>{d.news.length}</b>건
          </p>
          {d.errors?.length > 0 && <p className="lookup-note">{d.errors.join(" / ")}</p>}

          {all.length === 0 && <p className="empty">최근 1년 안에 공장·설비 투자 관련 소식이 없습니다. 회사명 표기를 바꿔 보세요(예: 띄어쓰기, 영문).</p>}

          <ul className="lookup-list">
            {all.map((x) => (
              <li key={x.url}>
                <label>
                  <input type="checkbox" checked={picked.has(x.url)} onChange={() => toggle(x.url)} />
                  <span className={`tier t${x.tier}`}>{x.tier === 1 ? "공시" : x.tier === 2 ? "주요지" : "기타"}</span>
                  <span className="lk-main">
                    <a href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
                    <small>{x.source} · {fmtDate(x.published_at)}</small>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {all.length > 0 && (
            <div className="lookup-act">
              {queued
                ? <p className="lookup-ok">{queued.added}건을 수집함에 넣었습니다{queued.added < queued.total ? ` (이미 있던 ${queued.total - queued.added}건 제외)` : ""}. 다음 ‘레이더 업데이트’ 때 분석해서 핀으로 올립니다.</p>
                : <button className="primary" disabled={picked.size === 0} onClick={queue}>선택한 {picked.size}건 레이더에 추가</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
