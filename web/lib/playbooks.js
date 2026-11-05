/** 회사·그룹별 "들어가는 길" — 구매 채널, 협력사 등록, 영업 팁.
 *  기본값(seed)은 여기, 팀이 고친 내용은 DB playbooks 테이블에 저장되어 기본값을 덮어쓴다.
 *  확실하지 않은 항목은 verify:true 로 표시해 화면에 "팀 확인 필요"가 뜬다. 추측으로 URL 을 적지 않는다. */

export const GROUPS = [
  { key: "hyundai", label: "현대차그룹", patterns: ["현대자동차", "현대차", "기아", "현대모비스", "현대제철", "현대위아", "현대로템", "현대트랜시스", "현대글로비스", "현대케피코", "현대엘앤씨", "현대엔지니어링", "현대건설"] },
  { key: "posco", label: "포스코그룹", patterns: ["포스코", "posco"] },
  { key: "samsung", label: "삼성", patterns: ["삼성"] },
  { key: "lg", label: "LG그룹", patterns: ["lg", "엘지"] },
  { key: "sk", label: "SK그룹", patterns: ["sk", "에스케이"] },
  { key: "hanwha", label: "한화그룹", patterns: ["한화"] },
  { key: "hdhyundai", label: "HD현대", patterns: ["hd현대", "현대중공업", "현대일렉트릭", "현대미포", "현대삼호", "현대오일뱅크"] },
  { key: "doosan", label: "두산그룹", patterns: ["두산"] },
  { key: "lotte", label: "롯데그룹", patterns: ["롯데"] },
  { key: "hyosung", label: "효성그룹", patterns: ["효성"] },
  { key: "gs", label: "GS그룹", patterns: ["gs", "지에스"] },
  { key: "cj", label: "CJ그룹", patterns: ["cj", "씨제이"] },
  { key: "kolon", label: "코오롱", patterns: ["코오롱"] },
  { key: "hankook", label: "한국앤컴퍼니(한국타이어)", patterns: ["한국타이어", "한국앤컴퍼니"] },
  { key: "ecopro", label: "에코프로", patterns: ["에코프로"] },
  { key: "public", label: "공공기관·지자체", patterns: ["한국전력", "한전", "공사", "공단", "경북도", "전북도", "충북도", "지자체", "시청", "군청"] },
];

const norm = (s) => (s ?? "").replace(/\(주\)|㈜|주식회사|\s|\(.*?\)/g, "").toLowerCase();

/** 회사명·그룹명으로 그룹 키 판정. 못 찾으면 'general'. */
export function detectGroup(companyName, companyGroup) {
  for (const cand of [norm(companyGroup), norm(companyName)]) {
    if (!cand) continue;
    for (const g of GROUPS) if (g.patterns.some((p) => cand.startsWith(p.toLowerCase()))) return g.key;
  }
  return "general";
}

export const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g.label]));
GROUP_LABEL.general = "일반 (중견·중소)";

/** 기본 플레이북. fields: channel(구매 채널), channel_url, registration(등록·진입 절차), tips(영업 팁), verify(팀 확인 필요) */
export const SEED = {
  hyundai: {
    channel: "VAATZ(바츠) — 현대차그룹 통합 구매 포털",
    channel_url: "https://www.vaatz.com",
    registration: "바츠에 협력사 등록(사업자·재무·품질 서류) 후 입찰·견적 요청(RFQ)에 응답. 사업장(울산·아산·전주·화성 등)별 구매·설비 담당이 다르므로 해당 사업장 설비기술/구매 담당 확인.",
    tips: "설비(유틸리티)는 사업장 생산기술·설비 부서가 사양을 정하고 구매는 바츠로 진행. 기존 납품 사업장의 담당자 소개가 가장 빠름. 1차 협력사(모듈사) 공장은 그 협력사 구매팀 직접 접촉.",
    verify: false,
  },
  posco: {
    channel: "엔투비(eNtoB) — 포스코그룹 MRO·설비 구매 마켓플레이스",
    channel_url: "https://www.entob.com",
    registration: "엔투비 공급사 등록 후 포스코·그룹사(포스코퓨처엠·포스코플랜텍 등)의 견적·입찰 공고에 응답. 설비는 각 사 설비기술 부서와 사양 협의 후 엔투비로 발주.",
    tips: "GENEQ 는 이미 엔투비 공급사. 포스코퓨처엠(광양·포항) 양극재 라인은 저노점 드라이어 수요 큼. 포항·광양은 지역 협력사 우대 경향.",
    verify: false,
  },
  samsung: {
    channel: "삼성 구매포털(SECbuy) — 삼성전자 등 협력회사 등록·입찰",
    channel_url: "https://www.secbuy.com",
    registration: "구매포털에서 협력회사 등록 신청(핵심역량·기술 제안서 포함). 계열사(삼성전기·삼성SDI·삼성바이오로직스 등)는 별도 구매 조직이라 각 사 포털·담당 확인 필요.",
    tips: "신규 라인 유틸리티는 대부분 EPC(삼성물산·삼성엔지니어링 등)나 설비 벤더 패키지로 묶여 발주됨 → EPC·설비 벤더의 협력사로 들어가는 경로도 같이 검토.",
    verify: true,
  },
  lg: {
    channel: "LG 계열사별 협력사 포털(LG전자·LG화학·LG이노텍·LG에너지솔루션 각각)",
    channel_url: "",
    registration: "계열사마다 협력사 등록 창구가 다름. 해당 사업장 구매팀에 신규 협력사 등록 요건 문의 후 포털 등록.",
    tips: "LG전자 창원 사업장은 GENEQ 기존 거래처 — 창원 담당자 통해 타 사업장(구미·평택) 소개 요청.",
    verify: true,
  },
  sk: {
    channel: "SK 계열사별 협력사 포털(SK하이닉스·SK온·SKC 등 각각)",
    channel_url: "",
    registration: "SK하이닉스는 협력사 등록 포털을 통해 신규 등록 후 입찰 참여. 반도체 팹 유틸리티는 대부분 대형 설비사·EPC 패키지.",
    tips: "청주 P&T7·M17 등 신규 팹은 EPC/설비사 협력사 경로가 현실적. 소규모 라인·연구동은 직접 영업 가능.",
    verify: true,
  },
  hanwha: {
    channel: "한화 계열사별 협력사 포털(한화에어로스페이스·한화오션·한화솔루션 등)",
    channel_url: "",
    registration: "계열사별 협력사 등록. 한화에어로스페이스 창원은 GENEQ 기존 거래처.",
    tips: "창원1·3 납품 이력으로 순천 사업장(발사체) 소개 요청 가능. 방산·항공은 품질(AS9100 등) 서류 준비.",
    verify: true,
  },
  hdhyundai: {
    channel: "HD현대 계열사 협력사 포털",
    channel_url: "",
    registration: "HD현대일렉트릭·HD현대중공업 등 각 사 구매팀 통해 협력사 등록.",
    tips: "울산 지역 전력기기 증설(HD현대일렉트릭)은 변압기 진공건조 공정용 건조 압축공기 수요.",
    verify: true,
  },
  doosan: {
    channel: "두산 협력사 포털",
    channel_url: "",
    registration: "두산에너빌리티(창원)·㈜두산 전자BG(김제) 각 사 구매팀 통해 등록.",
    tips: "두산에너빌리티 창원은 본사 인근 — 방문 영업 가능. 원전 기자재 공장은 품질 요구 높음.",
    verify: true,
  },
  public: {
    channel: "나라장터(G2B) — 공공기관·지자체 입찰",
    channel_url: "https://www.g2b.go.kr",
    registration: "조달청 나라장터 입찰참가자격 등록 후 공고 응찰. 지자체 공유공장·공공 연구시설은 설계사·시공사 통해 설비 사양 반영.",
    tips: "공고 전 설계 단계에서 설계사에 사양 제안하는 게 핵심.",
    verify: false,
  },
  general: {
    channel: "직접 영업 — 구매팀·설비(생산기술)팀",
    channel_url: "",
    registration: "별도 포털 없는 경우가 대부분. 대표번호 → 구매팀/설비팀 담당 확인 → 회사소개서·납품실적 송부 → 현장 방문.",
    tips: "투자협약 단계면 지자체 투자유치과(담당 공무원)가 기업 담당자를 알고 있음. 설계·시공사가 정해졌으면 그쪽 설비 담당도 같이 접촉. 준공 건은 A/S·교체 수요로 접근.",
    verify: false,
  },
};
