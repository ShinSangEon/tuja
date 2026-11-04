import { NextResponse } from 'next/server';
import { COOKIE, MAX_AGE, sign, authEnabled } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req) {
    const b = await req.json().catch(() => ({}));
    if (!authEnabled()) return NextResponse.json({ ok: true });
    const ok = String(b.username ?? '') === process.env.ADMIN_USERNAME && String(b.password ?? '') === process.env.ADMIN_PASSWORD;
    if (!ok) {
        await new Promise((r) => setTimeout(r, 600)); // 무차별 대입 완화
        return NextResponse.json({ error: '아이디 또는 비밀번호가 맞지 않습니다.' }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE, await sign(), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: MAX_AGE });
    return res;
}
