import { NextResponse } from 'next/server';

// 전체 사이트 Basic Auth. ADMIN_USERNAME/ADMIN_PASSWORD 가 비어 있으면 통과(로컬 개발용).
export function proxy(req) {
    const user = process.env.ADMIN_USERNAME;
    const pwd = process.env.ADMIN_PASSWORD;
    if (!user || !pwd) return NextResponse.next();

    const auth = req.headers.get('authorization');
    if (auth?.startsWith('Basic ')) {
        const [u, p] = atob(auth.slice(6)).split(':');
        if (u === user && p === pwd) return NextResponse.next();
    }
    return new NextResponse('인증 필요', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="GENEQ Invest Radar", charset="UTF-8"' },
    });
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
