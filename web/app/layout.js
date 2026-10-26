import './radar.css';

export const metadata = {
    title: 'GENEQ 투자 레이더',
    description: 'ES사업부 영업 타겟 — 국내 공장 신설·증설·개조 투자 신호 지도',
    robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
    return (
        <html lang="ko">
            <body style={{ margin: 0, fontFamily: '"Pretendard", -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif' }}>{children}</body>
        </html>
    );
}
