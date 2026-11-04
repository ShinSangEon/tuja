"use client";

import { useEffect, useRef, useState } from "react";
import "./login.css";

const Eye = ({ off }) => off ? (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.1A10.4 10.4 0 0 1 12 5c5 0 8.6 3.4 10 7-0.5 1.3-1.3 2.5-2.3 3.5" /><path d="M6.2 6.2C4.2 7.6 2.8 9.6 2 12c1.4 3.6 5 7 10 7 1.6 0 3-0.3 4.3-0.9" />
  </svg>
) : (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12c1.4-3.6 5-7 10-7s8.6 3.4 10 7c-1.4 3.6-5 7-10 7S3.4 15.6 2 12z" /><circle cx="12" cy="12" r="3" />
  </svg>
);

export default function Login() {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u.trim(), password: p }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "로그인 실패");
      const next = new URLSearchParams(location.search).get("next") || "/";
      location.replace(next.startsWith("/") ? next : "/");
    } catch (x) {
      setErr(x.message); setShake(true); setTimeout(() => setShake(false), 500); setBusy(false);
    }
  };

  return (
    <main className="login">
      <svg className="radar-bg" viewBox="0 0 600 600" aria-hidden="true">
        {[80, 160, 240, 320, 400].map((r) => <circle key={r} cx="300" cy="300" r={r} />)}
        <line x1="300" y1="300" x2="300" y2="-100" /><line x1="300" y1="300" x2="700" y2="300" />
        <line x1="300" y1="300" x2="300" y2="700" /><line x1="300" y1="300" x2="-100" y2="300" />
        <path className="sweep" d="M300 300 L300 -100 A400 400 0 0 1 646 100 Z" />
        <circle className="blip" cx="412" cy="188" r="5" /><circle className="blip b2" cx="205" cy="372" r="4" /><circle className="blip b3" cx="470" cy="330" r="4" />
      </svg>

      <form className={`card ${shake ? "shake" : ""}`} onSubmit={submit} noValidate>
        <div className="brand">
          <span className="brand-name">GENEQ 투자 레이더</span>
          <span className="brand-sub">에너지시스템사업부 · 국내 공장 투자 신호</span>
        </div>

        <label className="field">
          <span>아이디</span>
          <input ref={first} value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" spellCheck={false} />
        </label>
        <label className="field">
          <span>비밀번호</span>
          <span className="pw">
            <input type={show ? "text" : "password"} value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
            <button type="button" className="eye" onClick={() => setShow((v) => !v)} aria-label={show ? "비밀번호 숨기기" : "비밀번호 보기"} aria-pressed={show}><Eye off={show} /></button>
          </span>
        </label>

        <p className={`msg ${err ? "err" : ""}`} aria-live="polite">{err || " "}</p>
        <button className="go" type="submit" disabled={busy || !u || !p}>{busy ? "확인 중…" : "들어가기"}</button>
        <p className="foot">팀 공용 계정입니다. 로그인은 이 브라우저에 30일 유지됩니다.</p>
      </form>
    </main>
  );
}
