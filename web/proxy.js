import { NextResponse } from 'next/server';
import { COOKIE, verify, authEnabled } from '@/lib/auth';

// 전체 사이트 로그인. ADMIN_USERNAME/ADMIN_PASSWORD 가 비어 있으면 통과(로컬 개발용).
// 로그인 쿠키(/login 에서 발급) 또는 Basic 헤더(스크립트용) 중 하나면 통과.
export async function proxy(req) {
    if (!authEnabled()) return NextResponse.next();
    const { pathname } = req.nextUrl;
    if (pathname === '/login' || pathname === '/api/login') return NextResponse.next();

    if (await verify(req.cookies.get(COOKIE)?.value)) return NextResponse.next();

    const auth = req.headers.get('authorization');
    if (auth?.startsWith('Basic ')) {
        const [u, p] = atob(auth.slice(6)).split(':');
        if (u === process.env.ADMIN_USERNAME && p === process.env.ADMIN_PASSWORD) return NextResponse.next();
    }
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: '로그인 필요' }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname !== '/' ? `?next=${encodeURIComponent(pathname + req.nextUrl.search)}` : '';
    return NextResponse.redirect(url);
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
