"use client";

import { useEffect, useState } from "react";
import { SIDO_LIST, fmtDate, sidoName } from "@/lib/format";

const myName = () => { try { return localStorage.getItem("radar.me") || ""; } catch { return ""; } };
const saveName = (n) => { try { localStorage.setItem("radar.me", n); } catch {} };
const fmtArea = (a) => (a ? (a >= 10000 ? `${(a / 10000).toFixed(1)}만㎡` : `${Math.round(a).toLocaleString()}㎡`) : "");
const fmtDay = (d) => (d && d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : "");

/**
 * 검색했는데 레이더 신호에 없을 때(또는 더 찾고 싶을 때) 여는 패널.
 *  ① 레이더가 이미 아는 것: 기존 거래처 여부, 등록공장, 건축허가
 *  ② 지난 조사 요청과 답
 *  ③ 구글뉴스(투자 소식 + 교체 가능성 징후)·DART 를 지금 찾아 '레이더에 추가'
 *  ④ 조사 요청 — 다음 '레이더 업데이트' 때 담당자가 조사해 여기 답을 단다
 *  ⑤ 영업 직접 등록 — 영업이 아는 교체 계획 등을 바로 신호로 올린다
 */
export default function LookupPanel({ q, inDb, onCreated }) {
  const [state, setState] = useState({ status: "idle", data: null });
  const [picked, setPicked] = useState(new Set());
  const [queued, setQueued] = useState(null);
  const [reqs, setReqs] = useState([]);
  const [mode, setMode] = useState(null); // null | "request" | "manual"

  useEffect(() => {
    if (!q || q.length < 2) return;
    const ctl = new AbortController();
    setState({ status: "loading", data: null }); setPicked(new Set()); setQueued(null); setMode(null);
    fetch(`/api/lookup?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
      .then((r) => r.json())
      .then((d) => {
        setState({ status: "done", data: d });
        setPicked(new Set([...(d.dart ?? []), ...(d.news ?? []).filter((x) => x.about !== "demand")].map((x) => x.url)));
      })
      .catch((e) => { if (e.name !== "AbortError") setState({ status: "error", data: null }); });
    fetch(`/api/search-log?q=${encodeURIComponent(q)}`, { signal: ctl.signal }).then((r) => r.json()).then((d) => setReqs(d.requests ?? [])).catch(() => {});
    return () => ctl.abort();
  }, [q]);

  const d = state.data;
  const all = d ? [...(d.dart ?? []), ...(d.news ?? [])] : [];
  const toggle = (url) => setPicked((p) => { const n = new Set(p); n.has(url) ? n.delete(url) : n.add(url); return n; });
  const known = d?.known;

  async function queue() {
    const items = all.filter((x) => picked.has(x.url));
    const r = await fetch("/api/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q, items }) });
    setQueued(await r.json());
  }

  return (
    <div className="lookup">
      <div className="lookup-head">
        <h3>{inDb ? `‘${q}’ 더 찾아보기` : `‘${q}’ 은(는) 레이더 신호에 없습니다`}</h3>
        <p>레이더가 이미 아는 정보와 최근 1년 뉴스·공시를 보여 줍니다. 찾는 내용이 없으면 조사를 요청하거나, 알고 계신 내용을 직접 등록하세요.</p>
      </div>

      <div className="lookup-tools" role="group" aria-label="요청과 등록">
        <button className={mode === "request" ? "on" : ""} onClick={() => setMode(mode === "request" ? null : "request")}>조사 요청</button>
        <button className={mode === "manual" ? "on" : ""} onClick={() => setMode(mode === "manual" ? null : "manual")}>영업 정보 직접 등록</button>
      </div>
      {mode === "request" && <RequestForm q={q} onDone={(r) => { setReqs((x) => [r, ...x]); setMode(null); }} onCancel={() => setMode(null)} />}
      {mode === "manual" && <ManualForm company={q} known={known} onCreated={(s) => { setMode(null); onCreated?.(s); }} onCancel={() => setMode(null)} />}

      {reqs.length > 0 && (
        <section className="lk-sec">
          <h4>조사 요청</h4>
          <ul className="lk-reqs">
            {reqs.map((r) => (
              <li key={r.id} className={r.status === "done" ? "done" : ""}>
                <div className="lk-req-q"><b>{r.status === "done" ? "답변" : "조사 대기"}</b> · {r.requested_by ?? "요청자 미기재"} · {fmtDate(r.created_at)}{r.note ? ` — ${r.note}` : ""}</div>
                {r.answer ? <p className="lk-req-a">{r.answer}</p> : <p className="lk-req-a muted">다음 ‘레이더 업데이트’ 때 조사해서 여기에 답을 답니다.</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.status === "loading" && <p className="lookup-note">찾는 중…</p>}
      {state.status === "error" && <p className="lookup-note warn">검색에 실패했습니다. 잠시 후 다시 시도하세요.</p>}

      {known && (
        <section className="lk-sec">
          <h4>레이더가 아는 것</h4>
          <ul className="lk-known">
            <li>{known.customer ? <><span className="cust-tag">고객</span> 기존 거래처 <b>{known.customer.name}</b>{known.customer.sites ? ` · ${known.customer.sites}` : ""}</> : "기존 거래처 목록에는 없습니다."}</li>
            {known.factories.length > 0
              ? known.factories.map((f, i) => (
                  <li key={i}><span className="lk-k">등록공장</span> {f.company_raw} · {f.complex || f.sigungu || ""}{f.products ? ` · ${f.products}` : ""}<small>{f.address}</small></li>
                ))
              : <li className="muted">한국산업단지공단 등록공장 목록에서 같은 이름을 찾지 못했습니다.</li>}
            {known.permits.map((p, i) => (
              <li key={`p${i}`}><span className="lk-k">건축허가</span> {p.bld_nm || p.company_guess} · {p.arch_gb ?? ""} {fmtArea(p.tot_area)} · 허가 {fmtDay(p.pms_day)}{p.use_apr_day ? " · 사용승인" : p.real_stcns_day ? " · 착공" : ""}<small>{p.plat_plc}</small></li>
            ))}
          </ul>
        </section>
      )}

      {d && (
        <section className="lk-sec">
          <h4>최근 1년 뉴스·공시</h4>
          <p className="lookup-sum">
            {d.corp ? <>상장사 <b>{d.corp.corp_name}</b>({d.corp.stock_code}) · </> : <>비상장 또는 DART 미등록 · </>}
            공시 <b>{d.dart.length}</b>건, 기사 <b>{d.news.length}</b>건
          </p>
          {d.errors?.length > 0 && <p className="lookup-note">{d.errors.join(" / ")}</p>}
          {all.length === 0 && <p className="empty">최근 1년 안에 투자·설비 관련 소식이 없습니다. 장비 교체처럼 기사가 나지 않는 건은 조사 요청이나 직접 등록을 써 주세요.</p>}
          <ul className="lookup-list">
            {all.map((x) => (
              <li key={x.url}>
                <label>
                  <input type="checkbox" checked={picked.has(x.url)} onChange={() => toggle(x.url)} />
                  <span className={`tier t${x.tier}`}>{x.tier === 1 ? "공시" : x.about === "demand" ? "징후" : x.tier === 2 ? "주요지" : "기타"}</span>
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
        </section>
      )}
    </div>
  );
}

function RequestForm({ q, onDone, onCancel }) {
  const [note, setNote] = useState("");
  const [by, setBy] = useState(myName());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function submit(e) {
    e.preventDefault();
    if (!by.trim()) { setErr("요청자 이름을 적어 주세요."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/search-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q, n: 0, request: true, note, by }) });
      const j = await r.json();
      if (!j.ok) throw new Error("저장 실패");
      saveName(by);
      onDone({ id: j.id, q, note, requested_by: by, status: "open", answer: null, created_at: new Date().toISOString() });
    } catch { setErr("요청을 저장하지 못했습니다. 잠시 후 다시 시도하세요."); } finally { setBusy(false); }
  }
  return (
    <form className="lk-form" onSubmit={submit}>
      <p className="lk-form-h">‘{q}’ 조사 요청 — 다음 레이더 업데이트 때 공개 자료를 다시 찾아보고, 이 화면에 답을 남깁니다.</p>
      <label htmlFor="rq-note">알고 계신 내용 (선택)</label>
      <textarea id="rq-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 진해 야드 압축기 4대·드라이어 3대 교체 검토 중이라고 들음" />
      <label htmlFor="rq-by">요청자</label>
      <input id="rq-by" value={by} onChange={(e) => setBy(e.target.value)} placeholder="이름" />
      {err && <p className="lookup-note warn">{err}</p>}
      <div className="lk-form-act"><button type="button" className="link" onClick={onCancel}>취소</button><button className="primary" disabled={busy}>{busy ? "저장 중…" : "조사 요청"}</button></div>
    </form>
  );
}

const SECTORS = ["조선·해양", "자동차·부품", "반도체", "이차전지", "디스플레이", "제약·바이오", "식품·음료", "항공·방산", "화학·소재", "철강·금속", "기계·장비", "전자부품", "섬유", "에너지", "기타"];
const TYPE_OPTS = [["demand", "교체 가능성 (장비 교체·증설 검토)"], ["equipment", "설비투자 확정"], ["expansion", "공장 증설"], ["new_plant", "신공장"], ["retrofit", "개조·스마트화"]];
const STAGE_OPTS = [["mou", "발표·협약"], ["permit", "인허가"], ["construction", "착공·진행 중"], ["completed", "준공"]];

async function geocode(query, company) {
  const svc = typeof window !== "undefined" ? window.kakao?.maps?.services : null;
  if (!svc) return null;
  const byAddr = () => new Promise((res) => {
    if (!query) return res(null);
    new svc.Geocoder().addressSearch(query, (r, st) => res(st === svc.Status.OK && r[0] ? { lat: Number(r[0].y), lng: Number(r[0].x) } : null));
  });
  const byPlace = () => new Promise((res) => {
    new svc.Places().keywordSearch(`${query ?? ""} ${company}`.trim(), (r, st) => res(st === svc.Status.OK && r[0] ? { lat: Number(r[0].y), lng: Number(r[0].x) } : null));
  });
  return (await byAddr()) ?? (await byPlace());
}

function ManualForm({ company: initial, known, onCreated, onCancel }) {
  const f0 = known?.factories?.[0];
  const [f, setF] = useState({
    company: initial, type: "demand", stage: "construction", summary: "", sector: "기타",
    sido: SIDO_LIST.find((s) => f0?.address?.startsWith(s)) ?? "", sigungu: f0?.sigungu ?? "", address: f0?.address?.replace(/\s*외\s*\d+필지.*$/, "") ?? "",
    need_air: 2, need_dryer: 2, need_hmi: 1, amount_eok: "", rationale: "", by: myName(),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    if (f.company.trim().length < 2 || f.summary.trim().length < 5 || !f.by.trim()) { setErr("회사명, 내용, 입력자는 꼭 적어 주세요."); return; }
    setBusy(true); setErr("");
    try {
      const pt = await geocode(f.address || [f.sido, f.sigungu].filter(Boolean).join(" "), f.company);
      const r = await fetch("/api/manual", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...f, lat: pt?.lat, lng: pt?.lng }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "저장 실패");
      saveName(f.by);
      onCreated(j.signal);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <form className="lk-form" onSubmit={submit}>
      <p className="lk-form-h">영업이 아는 건을 신호로 올립니다. 지도에 바로 보이고, 같은 회사의 뉴스·공시가 나오면 자동으로 합쳐집니다.</p>
      <label htmlFor="mf-co">회사명</label>
      <input id="mf-co" value={f.company} onChange={set("company")} />
      <label htmlFor="mf-type">무슨 건</label>
      <select id="mf-type" value={f.type} onChange={set("type")}>{TYPE_OPTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      {f.type !== "demand" && (<><label htmlFor="mf-stage">단계</label><select id="mf-stage" value={f.stage} onChange={set("stage")}>{STAGE_OPTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></>)}
      <label htmlFor="mf-sum">내용</label>
      <textarea id="mf-sum" rows={3} value={f.summary} onChange={set("summary")} placeholder="예: 진해 야드 압축기 4대·드라이어 3대 교체 진행 중. 2027년 상반기 발주 예정" />
      <div className="lk-form-row">
        <div><label htmlFor="mf-sido">시도</label><select id="mf-sido" value={f.sido} onChange={set("sido")}><option value="">선택</option>{SIDO_LIST.map((s) => <option key={s} value={s}>{sidoName(s)}</option>)}</select></div>
        <div><label htmlFor="mf-sgg">시군구</label><input id="mf-sgg" value={f.sigungu} onChange={set("sigungu")} placeholder="창원시" /></div>
      </div>
      <label htmlFor="mf-addr">주소 (지도 위치)</label>
      <input id="mf-addr" value={f.address} onChange={set("address")} placeholder="경상남도 창원시 진해구 명제로 60" />
      <div className="lk-form-row">
        <div><label htmlFor="mf-sec">업종</label><select id="mf-sec" value={f.sector} onChange={set("sector")}>{SECTORS.map((s) => <option key={s}>{s}</option>)}</select></div>
        <div><label htmlFor="mf-amt">금액 (억, 선택)</label><input id="mf-amt" inputMode="decimal" value={f.amount_eok} onChange={set("amount_eok")} placeholder="모르면 비움" /></div>
      </div>
      <fieldset className="lk-need">
        <legend>우리 장비 수요 (0 없음 ~ 3 핵심)</legend>
        {[["need_air", "압축기"], ["need_dryer", "드라이어"], ["need_hmi", "제어"]].map(([k, l]) => (
          <label key={k}>{l}<select value={f[k]} onChange={set(k)}>{[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        ))}
      </fieldset>
      <label htmlFor="mf-by">입력자</label>
      <input id="mf-by" value={f.by} onChange={set("by")} placeholder="이름" />
      {err && <p className="lookup-note warn">{err}</p>}
      <div className="lk-form-act"><button type="button" className="link" onClick={onCancel}>취소</button><button className="primary" disabled={busy}>{busy ? "등록 중…" : "신호로 등록"}</button></div>
    </form>
  );
}
