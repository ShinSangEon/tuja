/** 쿠키 기반 로그인 토큰. Edge(proxy)와 Node(API) 양쪽에서 쓰므로 Web Crypto 만 사용.
 *  토큰 = exp(초).hmac_sha256(exp, 비밀). 비밀 = AUTH_SECRET 또는 ADMIN_PASSWORD. */
export const COOKIE = 'radar_auth';
export const MAX_AGE = 60 * 60 * 24 * 30; // 30일

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function key() {
    const secret = process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || 'dev';
    return crypto.subtle.importKey('raw', enc.encode(`radar:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function sign(exp = Math.floor(Date.now() / 1000) + MAX_AGE) {
    const sig = await crypto.subtle.sign('HMAC', await key(), enc.encode(String(exp)));
    return `${exp}.${hex(sig)}`;
}

export async function verify(token) {
    if (!token || !token.includes('.')) return false;
    const [exp, sig] = token.split('.');
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
    const want = hex(await crypto.subtle.sign('HMAC', await key(), enc.encode(exp)));
    if (want.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
}

export function authEnabled() {
    return !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD);
}
