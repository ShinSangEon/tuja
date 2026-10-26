"""설정값. 대표이사님과 합의 후 바꾸는 값은 전부 여기."""
import os
from dotenv import load_dotenv

load_dotenv()

# ── API 키 ──────────────────────────────────────────────
DART_API_KEY = os.getenv("DART_API_KEY", "")
NAVER_CLIENT_ID = os.getenv("NAVER_CLIENT_ID", "")
NAVER_CLIENT_SECRET = os.getenv("NAVER_CLIENT_SECRET", "")
KAKAO_REST_KEY = os.getenv("KAKAO_REST_KEY", "")
DATABASE_URL = os.getenv("DATABASE_URL", "")  # Neon: postgresql://...?sslmode=require

# ── 추출은 Claude 세션에서 수동 (API 미사용). pending.md 에 넣는 본문 길이 ──
MAX_BODY_CHARS = int(os.getenv("MAX_BODY_CHARS", "3000"))

# ── 규모 등급 (원) ──────────────────────────────────────
SIZE_THRESHOLDS = {
    "S_MAX": 5_000_000_000,       # 50억 미만 = S
    "M_MAX": 50_000_000_000,      # 500억 미만 = M, 이상 = L
}
AREA_THRESHOLDS = {"S_MAX": 3_000, "M_MAX": 20_000}  # ㎡, 금액 없을 때 보조

# ── 관련도 점수 ─────────────────────────────────────────
INDUSTRY_WEIGHTS = {
    "이차전지": 40, "반도체": 40, "디스플레이": 40,
    "제약·바이오": 35, "식품·음료": 35,
    "자동차·부품": 30, "조선·해양": 30, "항공·방산": 30,
    "화학·소재": 25, "철강·금속": 25, "기계·장비": 25,
    "전자부품": 20, "섬유": 15, "에너지": 15,
    "물류·창고": 5, "데이터센터": 5, "기타": 10,
}
STAGE_WEIGHTS = {"disclosure": 15, "mou": 15, "permit": 10, "construction": 5, "completed": 0}
STAGE_ORDER = ["disclosure", "mou", "permit", "construction", "completed"]

# ── 네이버 뉴스 키워드 ──────────────────────────────────
NEWS_KEYWORDS = [
    "공장 증설", "공장 신설", "신공장 건립", "생산라인 증설", "설비투자 결정",
    "투자협약 체결 공장", "신규시설투자", "공장 착공", "스마트공장 전환 투자",
    "생산능력 확대 투자", "제2공장", "제3공장", "산업단지 입주 투자",
]
NAVER_MAX_PER_KEYWORD = int(os.getenv("NAVER_MAX_PER_KEYWORD", "30"))

# 사전필터: 하나라도 있어야 AI로 보냄
POSITIVE_KEYWORDS = ["증설", "신설", "신공장", "착공", "준공", "투자협약", "설비투자", "라인", "공장", "생산능력", "입주"]
# 사전필터: 있으면 탈락 (단 POSITIVE 강한 단어와 같이 있으면 통과)
NEGATIVE_KEYWORDS = ["목표주가", "투자의견", "펀드", "ETF", "주가 전망", "채용", "인수합병", "해외법인"]
STRONG_POSITIVE = ["증설", "신설", "착공", "투자협약", "신규시설투자"]

# ── 소스 등급 ───────────────────────────────────────────
TIER2_PRESS = [
    "연합뉴스", "뉴시스", "뉴스1", "한국경제", "매일경제", "서울경제", "머니투데이",
    "아시아경제", "이데일리", "전자신문", "조선비즈", "중앙일보", "동아일보", "경향신문",
    "한겨레", "파이낸셜뉴스", "헤럴드경제", "KBS", "MBC", "SBS", "YTN", "연합인포맥스",
    "부산일보", "경남신문", "경남일보", "매일신문", "영남일보", "대전일보", "중도일보", "광주일보",
]

# ── 병합 ────────────────────────────────────────────────
DEDUPE_WINDOW_DAYS = 180
AMOUNT_SPLIT_RATIO = 3.0   # 금액이 3배 이상 차이면 별개 프로젝트
