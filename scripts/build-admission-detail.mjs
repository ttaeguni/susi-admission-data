import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, '..');
const sourceDir = path.join(repoDir, 'admission-detail-source', '2027');
const outputDir = path.join(repoDir, 'admission-detail', '2027');
const universityDir = path.join(outputDir, 'universities');
const operationalPath = path.join(repoDir, 'admission-data.json');
const manualCrosswalkPath = path.join(scriptDir, 'admission-detail-manual-crosswalk.json');
const reviewDir = path.join(repoDir, 'admission-detail-review', '2027');
const reviewPath = path.join(reviewDir, 'matching-review.json');

// 공개 GitHub Pages에 올려도 되는 대학 전형 정보만 허용한다.
// 교사 내부 판단 성격의 `입결예상`과 오래된 2020~2023 자료는 제외한다.
const PUBLIC_FIELDS = [
  'ID', '지역', '대학', '전형', '세부전형', '계열', '세부전공', '변경구분',
  '지원자격26', '지원자격27', '전형요소26', '전형요소27',
  '변경사항26', '변경사항27', '모집인원26', '모집인원27', '모집증감',
  '경쟁률24', '경쟁률25', '경쟁률26', '충원24', '충원25', '충원26',
  '합격50컷24', '합격70컷24', '합격50컷25', '합격70컷25',
  '합격50컷26', '합격70컷26',
  '진로과목평가26', '진로과목평가27', '반영비율26', '반영비율27',
  '최저기준26', '최저기준27', '학교일정2027', '최종발표일'
];

const HISTORICAL_RESULT_FIELDS = [
  '경쟁률24', '경쟁률25', '경쟁률26',
  '충원24', '충원25', '충원26',
  '합격50컷24', '합격70컷24',
  '합격50컷25', '합격70컷25',
  '합격50컷26', '합격70컷26'
];

const PRIVATE_KEY_PATTERN = /학번|학생명|성명|주민|전화|연락처|휴대폰|이메일|email|주소|비밀번호|password|교사메모|학생상담/i;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_PATTERN = /(?:01[016789])[-\s]?\d{3,4}[-\s]?\d{4}/;
const RESIDENT_PATTERN = /\b\d{6}[-\s]?[1-4]\d{6}\b/;

function normalizeUniversity(value) {
  return String(value || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/대학교/g, '대')
    .replace(/[\s\-_.·ㆍ,()[\]{}]/g, '');
}

function normalizeDepartment(value) {
  return normalizeUniversity(value)
    .replace(/학부$/, '')
    .replace(/학과$/, '')
    .replace(/전공$/, '');
}

// 대학 공식 모집요강에서 확인한 단과대학 접두어다.
// 운영자료에는 단과대학명이 포함되지만 상세 원문에는 모집단위만 있는 경우에만 사용한다.
const OFFICIAL_DEPARTMENT_PREFIXES = new Map([
  ['부산대학교', [
    '한의학전문대학원', '생명자원과학대학', '경제통상대학', '사회과학대학',
    '자연과학대학', '생활과학대학', '인문대학', '공과대학', '사범대학',
    '경영대학', '예술대학', '학부대학', 'AI대학', '간호대학', '약학대학',
    '의과대학', '치과대학'
  ]],
  ['한양대학교', [
    '인문과학대학', '사회과학대학', '자연과학대학', '정책과학대학',
    '경제금융대학', '예술체육대학', '기술혁신대학', '한양YK인터칼리지',
    '의과대학', '공과대학', '간호대학', '경영대학', '사범대학',
    '생활과학대학', '음악대학', '국제대학'
  ]],
  ['명지대학교', [
    '청소년지도·아동학부', '컴퓨터AI응용공학부', '아시아·중동어문학부',
    '화학·에너지융합학부', '인문콘텐츠학부', '융합소프트웨어학부',
    '기계시스템공학부', '스마트인프라공학부', '화공신소재공학부',
    '경상·통계학부', '전기전자공학부', '융합바이오학부',
    '공공인재학부', '미래전략학부', '융합인재학부', '경영학부',
    '건축학부', '디자인학부', '예술학부', '스포츠학부'
  ]],
  ['한국해양대학교', [
    '전자전기정보공학부', '해양과학융합학부', '인공지능공학부',
    '기계공학부'
  ]],
  ['충남대학교', [
    'AI(인공지능)대학', '생명시스템과학대학', '농업생명과학대학',
    '자연과학대학', '사회과학대학', '지식융합학부', '사범대학',
    '예술대학', '간호대학', '수의과대학', '의과대학', '공과대학'
  ]]
]);

function operationalDepartmentVariants(value, university) {
  const original = String(value || '').trim();
  const variants = [original];
  const baseUniversity = university.replace(/\s*\([^()]+\)\s*$/, '').trim();
  const prefixes = OFFICIAL_DEPARTMENT_PREFIXES.get(university)
    || OFFICIAL_DEPARTMENT_PREFIXES.get(baseUniversity)
    || [];
  let withoutPrefix = original;

  for (const prefix of prefixes) {
    if (!withoutPrefix.startsWith(`${prefix} `)) continue;
    withoutPrefix = withoutPrefix.slice(prefix.length).trim();
    break;
  }

  if (withoutPrefix !== original) {
    withoutPrefix = withoutPrefix
      .replace(/\(정원외\)\s*$/g, '')
      .replace(/[★♣♠]/g, '')
      .trim();
    variants.push(withoutPrefix);

    // `전기전자공학부 전기공학전공`처럼 상위 학부와 세부전공이 함께 적힌 경우다.
    const parts = withoutPrefix.split(/\s+/).filter(Boolean);
    for (let index = 1; index < parts.length; index++) {
      variants.push(parts.slice(index).join(' '));
    }
  }

  if (/^강원대학교\((강릉|원주|삼척|도계)\)$/.test(university)) {
    const withoutCampus = original
      .replace(/\s*\(삼척·도계\)\s*$/, '')
      .replace(/\s*\((강릉|원주|도계)\)\s*$/, '')
      .trim();
    variants.push(withoutCampus);
    variants.push(withoutCampus
      .replace(/\(인문계열\)/g, '(인문)')
      .replace(/\(자연계열\)/g, '(자연)'));
  }

  if (
    baseUniversity === '강원대학교'
    && original === '디지털미디어커뮤니케이션학과'
  ) {
    variants.push('디지털미디어커뮤니케이션학부');
  }

  if (baseUniversity === '강원대학교') {
    // 강릉캠퍼스 정원외 전형은 공식 표에서 단과대학 단위로 합산해
    // 공개한다. 운영자료의 `전 모집단위` 표기만 제거하고, 전형군·전형명·
    // 모집인원까지 같은 경우에만 아래 비교 단계에서 연결한다.
    const gangneungCollege = original.match(
      /^(인문대학|사회과학대학|자연과학대학|생명과학대학|공과대학)\(강릉\) (?:전|해당) 모집단위$/
    );
    if (gangneungCollege) {
      const college = gangneungCollege[1];
      variants.push(college);
      if (college === '인문대학') variants.push('인문대학(자유전공학과제외)');
      if (college === '자연과학대학') {
        variants.push('자연과학대학(자유전공학과제외)');
        variants.push('자연과학대학(자연과학자유전공학과제외)');
      }
      if (college === '생명과학대학') {
        variants.push('생명과학대학(자유전공학과제외)');
        variants.push('생명과학대학(생명과학대학자유전공학과제외)');
      }
    }

    // 2027 공식 모집요강의 캠퍼스·세부종목 표기와 상세
    // 원문의 모집단위 표기가 다른 항목이다. 모집인원과 전형명이
    // 함께 같은 경우에만 아래 비교 후보로 사용한다.
    if (original === '생명과학과') variants.push('생명과학과(춘천)');
    if (original === '공학대학 자유전공학과') variants.push('공과대학 자유전공학과');
    const humanSports = original.match(/^(휴먼스포츠학과)\([^()]+\)$/);
    if (humanSports) variants.push(humanSports[1]);
  }

  // 전남대 공식 모집요강 표와 상세 원문은 여수캠퍼스 학과명에 캠퍼스
  // 접미어를 붙이지 않는다. 운영자료에만 붙은 `(여수)`는 모집인원까지
  // 정확히 일치하는 경우에 한해 비교 후보로 사용한다.
  if (university === '전남대학교' && /\s*\(여수\)\s*$/.test(original)) {
    variants.push(original.replace(/\s*\(여수\)\s*$/, '').trim());
  }

  if (baseUniversity === '경상국립대학교') {
    const withoutFootnote = original.replace(/\*/g, '').trim();
    if (withoutFootnote !== original) variants.push(withoutFootnote);
    if (/\//.test(withoutFootnote)) variants.push(withoutFootnote.replace(/\//g, ','));

    if (withoutFootnote === '해양식품공학·수산생명의학부(해양식품공학전공/수산생명의학전공)') {
      variants.push('해양식품생명의학부(해양식품공학/수산생명의학)');
    }

    // 2027 학사구조 개편으로 여러 전공을 한 학부에서 통합 선발한다.
    // 상세 원문이 상위 학부명으로 집계한 행은 전공 나열 괄호만 제거한다.
    // 모집인원 불일치 시 아래 비교 단계에서 후보 자체를 제외한다.
    const mergedDepartment = withoutFootnote.match(/^(.+)\(([^()]*)\)$/);
    if (mergedDepartment && /\//.test(mergedDepartment[2]) && /전공/.test(mergedDepartment[2])) {
      variants.push(mergedDepartment[1].trim());
    }
  }

  if (university === '순천향대학교') {
    // 2027 학사구조 개편으로 기존 학과가 학부·스쿨의 세부전공으로
    // 표기된다. 공식 모집단위에서 확인되는 동일 전공만 옛 상세자료의
    // 학과명 후보로 추가하며, 전형과 모집인원 일치 조건은 그대로 둔다.
    const schMajorAliases = new Map([
      ['법·행정학부(법학전공)', '법학과'],
      ['법·행정학부(행정학전공)', '행정학과'],
      ['전자공학부(정보통신공학전공)', '정보통신공학과'],
      ['전자공학부(전자공학전공)', '전자공학과'],
      ['컴퓨터공학부(소프트웨어공학전공)', '컴퓨터소프트웨어공학과'],
      ['컴퓨터공학부(컴퓨터공학전공)', '컴퓨터공학과'],
      ['의약바이오스쿨(임상병리학전공)', '임상병리학과'],
      ['헬스케어서비스스쿨(보건행정경영학전공)', '보건행정경영학과'],
      ['헬스케어서비스스쿨(작업치료학전공)', '작업치료학과'],
      ['소프트웨어공학전공', '컴퓨터소프트웨어공학과'],
      ['컴퓨터공학전공', '컴퓨터공학과'],
      ['임상병리학전공', '임상병리학과']
    ]);
    const alias = schMajorAliases.get(original);
    if (alias) variants.push(alias);
  }

  if (university === '인천대학교') {
    // 2027 모집요강은 학사구조 개편 뒤의 상위 학부까지 표시하지만
    // 상세 원문은 기존 학부·전공명으로 저장되어 있다. 공식 모집단위의
    // 동일 전공명(또는 동일 통합학부명)만 후보로 추가한다.
    const inuAliases = new Map([
      ['전자공학부(전자공학전공·반도체융합전공)', '전자공학부'],
      ['컴퓨터공학부(컴퓨터공학전공·인공지능전공)', '컴퓨터공학부'],
      ['도시환경공학부(건설환경공학전공)', '건설환경공학전공'],
      ['도시환경공학부(환경공학전공)', '환경공학전공'],
      ['도시건축학부(건축공학전공·도시건축학전공)', '도시건축학부(도시건축학,건축공학)'],
      ['생명과학부(생명과학전공)', '생명과학전공'],
      ['생명과학부(분자의생명전공)', '분자의생명전공'],
      ['생명공학부(생명공학전공)', '생명공학전공'],
      ['생명공학부(나노바이오공학전공)', '나노바이오공학전공'],
      ['동북아국제통상물류학부(동북아국제통상전공)', '동북아국제통상전공'],
      ['동북아국제통상물류학부(스마트물류공학전공)', '스마트물류공학전공'],
      ['조형예술학부(한국화전공)', '한국화전공'],
      ['조형예술학부(서양화전공)', '서양화전공']
    ]);
    const alias = inuAliases.get(original);
    if (alias) variants.push(alias);
  }

  if (university === '제주대학교') {
    // 운영자료는 개편된 상위 학부를 함께 적고, 상세 원문은 동일 전공만
    // 기록한다. 야간 표기 위치 변경과 확인된 상위 학부 접두어만 보정한다.
    const jejuAliases = new Map([
      ['(야)행정학과', '행정학과(야)'],
      ['(야)경영학과', '경영학과(야)'],
      ['과학교육학부 물리교육전공', '물리교육전공'],
      ['과학교육학부 생물교육전공', '생물교육전공'],
      ['스마트팜학부 식물자원환경전공', '식물자원환경전공'],
      ['스마트팜학부 원예과학전공', '원예과학전공'],
      ['음악학부 작곡전공', '작곡전공'],
      ['음악학부 성악전공', '성악전공'],
      ['음악학부 피아노전공', '피아노전공'],
      ['음악학부 관·현악전공', '관현악전공'],
      ['디자인학부 공업디자인전공', '공업디자인전공'],
      ['디자인학부 문화공예디자인전공', '문화공예디자인전공'],
      ['디자인학부 시각영상디자인전공', '시각영상디자인전공']
    ]);
    const alias = jejuAliases.get(original);
    if (alias) variants.push(alias);
  }

  if (university === '수원대학교') {
    // 공식 2027 모집인원 표는 단과대학·통합학부 단위로 선발한다.
    // 운영자료의 `외 N개 학과` 축약과 상세 원문의 전체 전공 나열을
    // 같은 공식 모집단위로 연결한다.
    const suwonAliases = new Map([
      ['인문사회융합대학(한국언어문화 외 8개 학과)', '인문사회융합대학(한국언어문화,영미언어문화,일본언어문화,중국언어문화,러시아언어문화,법학,행정학,미디어커뮤니케이션,디지털헤리티지)'],
      ['경영공학대학(경영 외 4개 학과)', '경영공학대학(경영,글로벌비즈니스,회계,경제금융,호텔관광외식경영)'],
      ['건설환경에너지공학부(건설환경공학/환경에너지공학)', '건설환경에너지공학부(건설환경공학,환경에너지공학)'],
      ['전기전자공학부(전기공학/전자공학/정보통신공학)', '전기전자공학부(전기공학,전자공학,정보통신공학)'],
      ['화학공학·신소재공학부(화학공학/신소재공학)', '화학공학·신소재공학부(화학공학,신소재공학)'],
      ['AI데이터과학부(AI빅데이터/AI소프트웨어)', 'AI데이터과학부(AI빅데이터,AI소프트웨어)'],
      ['지능형보안학부(정보보안/보안관리)', '지능형보안학부(정보보안,보안관리)'],
      ['스포츠과학부(체육학/레저스포츠/운동건강관리)', '스포츠과학부(체육학,레저스포츠,운동건강관리)'],
      ['조형예술학부(회화/조소)', '조형예술학부(회화(한국화,서양화),조소)'],
      ['커뮤니케이션디자인', '디자인학부(커뮤니케이션디자인)'],
      ['패션디자인', '디자인학부(패션디자인)'],
      ['공예디자인', '디자인학부(공예디자인)'],
      ['디지털콘텐츠', '아트앤엔터테인먼트학부 디지털콘텐츠']
    ]);
    const alias = suwonAliases.get(original);
    if (alias) variants.push(alias);
  }

  if (university === '충남대학교') {
    if (original === '반도체응합학과') variants.push('반도체융합학과');
    if (original === '건축학과') variants.push('건축학과(5년제)');
  }

  if (university === '충북대학교') {
    // 2027 공식 모집요강의 개편 모집단위와 상세 원문의 표기가 다른 항목이다.
    // 전형명과 모집인원이 같은 경우에만 아래 비교 단계에서 연결한다.
    if (original === '건축학과') variants.push('건축학과(5년제)');
    if (original === '인공지능학부') variants.push('소프트웨어학부');
    if (original === '인문사회자율전공계열') {
      variants.push('인문사회자율전공');
      variants.push('자율전공학부\n(인문사회자율전공계열)');
    }
    if (original === '자연과학자율전공계열') {
      variants.push('자연과학자율전공');
      variants.push('자율전공학부\n(자연과학자율전공계열)');
    }
  }

  if (university === '한성대학교') {
    // 운영자료의 `(주)`는 주간 구분 표기이며 상세 원문에는 생략되어 있다.
    const withoutDaytime = original.replace(/\(주\)\s*$/, '').trim();
    if (withoutDaytime !== original) variants.push(withoutDaytime);
    if (original === 'IT공과대학(컴퓨터공학부·기계전자공학부·산업시스템공학부)(주)') {
      variants.push('IT공과대학');
    }
  }

  if (university === '명지대학교') {
    if (original === '기계시스템공학부 기계공학·로봇공학전공') {
      variants.push('기계시스템공학부(기계공학전공,로봇공학전공)');
    }
  }

  if (baseUniversity === '경북대학교') {
    if (original === '말/특수동물학과') variants.push('말특수동물학과');
    const textile = original.match(/^섬유패션디자인학부 (섬유공학전공|패션디자인전공)$/);
    if (textile) variants.push(`섬유패션디자인학부(${textile[1]})`);
  }

  if (university === '용인대학교') {
    // 공식 모집인원 표는 상위 학과·학부로 집계하고,
    // 운영자료는 괄호 안을 종목·전공 설명으로 더 세분화한다.
    const yonginAliases = new Map([
      ['골프학부 골프/골프매니지먼트', '골프학부(골프, 골프매니지먼트)'],
      ['AI융합학부 AI/빅데이터', 'AI융합학부(AI,빅데이터)'],
      ['실용음악과 기악(피아노/기타/베이스/드럼)', '실용음악과(기악)'],
      ['실용음악과 국악(현악/관악/성악/타악)', '실용음악과(국악)']
    ]);
    const alias = yonginAliases.get(original);
    if (alias) variants.push(alias);
  }

  if (university === '한국공학대학교') {
    // 2027 공식 모집요강에 명시된 명칭 변경과 통합 모집단위.
    const kituAliases = new Map([
      ['나노반도체공학전공', '나노반도체공학과'],
      ['전기공학전공', '전력응용시스템전공'],
      ['에너지공학전공', '미래에너지시스템전공'],
      ['경영학전공', '경영학 전공 (산업경영전공)'],
      ['산업디자인공학전공·미디어디자인공학전공', '디자인공학부'],
      ['산업융합공학과(야간)', '산업융합학과(야)'],
      ['디지털경영학과(야간)', '디지털경영학과(야)']
    ]);
    const alias = kituAliases.get(original);
    if (alias) variants.push(alias);
  }

  if (university === '조선대학교') {
    // 공식 표의 `학부(전공)`과 상세 원문의 전공명/통합명을
    // 모집인원과 전형명이 함께 같은 경우에만 비교한다.
    const nestedMajor = original.match(/^.+\(([^()]*전공)\)$/);
    if (nestedMajor) variants.push(nestedMajor[1]);
    const chosunAliases = new Map([
      ['국어국문학부(국어국문학전공)', '국어국문학과'],
      ['행정복지학부', '행정복지학부(행정학,사회복지학)'],
      ['문화콘텐츠학부(현대조형미디어전공/가구도자디자인전공)', '문화콘텐츠학부(현대조형미디어,가구도자디자인)'],
      ['라이프스타일디자인학부(실내디자인전공)', '라이프스타일디자인학부(실내디자인)'],
      ['라이프스타일디자인학부(섬유패션디자인전공)', '라이프스타일디자인학부(섬유·패션디자인)']
    ]);
    const alias = chosunAliases.get(original);
    if (alias) variants.push(alias);
  }

  if (university === '경희대학교') {
    // 2027 공식 표의 통합 모집단위와 상세 원문의 축약 표기.
    const kyungheeAliases = new Map([
      ['경영학과', '경영회계계열'],
      ['환경공학및환경공학과', '환경학및환경공학과'],
      ['건축학과(5년제)', '건축학과(5년제)(자연)'],
      ['전자공학부 전자공학과', '전자공학과'],
      ['전자공학부 반도체공학과', '반도체공학과'],
      ['컴퓨터공학부 컴퓨터공학과', '컴퓨터공학과'],
      ['컴퓨터공학부 인공지능학과', '인공지능학과'],
      ['연극영화학과(영화연출 및 제작)', '영화연출및제작'],
      ['연극영화학과(연극·뮤지컬 연기)', '연극뮤지컬연기'],
      ['스포츠의학과', '스프츠의학과']
    ]);
    const alias = kyungheeAliases.get(original);
    if (alias) variants.push(alias);
  }

  if (university === '중앙대학교') {
    const nestedMajor = original.match(/^(.+)\(([^()]*)\)$/);
    if (nestedMajor) {
      const parent = nestedMajor[1].trim();
      const detail = nestedMajor[2].trim();
      if (detail === '전공개방') variants.push(parent);
      else if (detail && !/[,/]/.test(detail)) variants.push(detail);
    }
  }

  return [...new Set(variants.filter(Boolean))];
}

function operationalTypeVariants(value, university) {
  const original = String(value || '').trim();
  const variants = [original];
  if (/^강원대학교\((강릉|원주|삼척|도계)\)$/.test(university)) {
    variants.push(original
      .replace(/\s*\(삼척·도계\)/g, '')
      .replace(/\s*\(원주\)/g, '')
      .replace(/\s*\(치과대학\)/g, '')
      .trim());
    if (original === '체육특기자전형') variants.push('특기자전형');
    if (/^체육특기자전형-개인종목/.test(original)) {
      variants.push('체육특기자전형(개인)');
    }
    if (/^체육특기자전형-단체종목/.test(original)) {
      variants.push('체육특기자전형(단체)');
    }
  }
  if (university === '충남대학교') {
    const innerType = original.match(/^(?:실기|실적)\((.+)\)$/)?.[1];
    if (innerType) variants.push(innerType);
  }
  return [...new Set(variants.filter(Boolean))];
}

// 대학이 여러 모집단위의 입결을 한 행에 묶어 공개한 경우를 지원한다.
// 괄호 안의 쉼표는 전공 설명일 수 있으므로 최상위 쉼표만 학과 구분자로 본다.
function splitTopLevelDepartments(value) {
  const text = String(value || '').trim();
  if (!text) return [];

  const departments = [];
  let current = '';
  let depth = 0;

  for (const character of text) {
    if ('([{'.includes(character)) depth += 1;
    if (')]}'.includes(character)) depth = Math.max(0, depth - 1);

    if (character === ',' && depth === 0) {
      if (current.trim()) departments.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }

  if (current.trim()) departments.push(current.trim());
  return departments;
}

// 원문이 `학부(세부전공1,세부전공2)`처럼 모집단위 뒤에 설명을 붙이는 경우,
// 끝의 괄호 설명만 단계적으로 제거한 안전한 비교 이름을 만든다.
// 중간 괄호나 접두·접미 문자열은 건드리지 않아 서로 다른 학과가 섞이지 않게 한다.
function trailingParentheticalVariants(value) {
  let text = String(value || '').trim();
  const variants = [];

  while (text) {
    variants.push(text);
    const trailing = text.match(/\(([^()]*)\)\s*$/);
    if (!trailing) break;

    // 야간/주간, 계열, 수업연한 같은 고유 구분은 학과명 일부로 보존한다.
    // 쉼표로 나열했거나 학과·학부·전공임이 드러난 세부 설명만 제거한다.
    const detail = trailing[1].trim();
    if (!detail || !(/[,/·]/.test(detail) || /(전공|학과|학부|예과)$/.test(detail))) break;
    text = text.replace(/\([^()]*\)\s*$/, '').trim();
  }

  return [...new Set(variants)];
}

// 기존 자동 매칭 결과는 그대로 보존하기 위한 1차 정규화 규칙이다.
// 새 규칙이 애매할 때는 이 규칙의 결과로 되돌아간다.
function normalizeTypeLegacy(value) {
  return normalizeUniversity(String(value || '').replace(/^\s*\[[^\]]+\]\s*/, ''))
    .replace(/학생부교과|학생부종합|논술위주|실기위주/g, '')
    .replace(/전형|학생|지원자|대상자|특별/g, '')
    .replace(/교과|종합/g, '');
}

function normalizeTypeLiteral(value) {
  return normalizeUniversity(String(value || '').replace(/^\s*\[[^\]]+\]\s*/, ''))
    .replace(/전형$/, '');
}

function normalizeType(value) {
  const romanNormalized = String(value || '')
    .replace(/\bIII\b/g, '3')
    .replace(/\bII\b/g, '2')
    .replace(/\bI\b/g, '1')
    .replace(/[\u2162\u2172]/g, '3')
    .replace(/[\u2161\u2171]/g, '2')
    .replace(/[\u2160\u2170]/g, '1')
    .replace(/^\s*\[[^\]]+\]\s*/, '');

  return normalizeUniversity(romanNormalized)
    .replace(/학생부교과|학생부종합|논술위주|실기위주/g, '')
    .replace(/정원외/g, '')
    .replace(/전형외$/g, '전형')
    .replace(/우수자|우수형/g, '우수')
    .replace(/교과성적/g, '교과')
    .replace(/전형|학생|지원자|대상자|특별/g, '')
    .replace(/교과|종합/g, '');
}

function normalizeGroup(value) {
  const normalized = normalizeUniversity(value);
  if (normalized === '교과' || normalized === '학생부교과') return '교과';
  if (normalized === '종합' || normalized === '학생부종합') return '종합';
  return normalized.replace(/학생부/g, '');
}

function firstNumber(value) {
  const match = String(value == null ? '' : value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function fillHistoricalDuplicateGaps(rows) {
  const groups = new Map();
  rows.forEach(row => {
    const identity = [
      normalizeUniversity(row['세부전공']),
      normalizeGroup(row['전형']),
      normalizeTypeLiteral(row['세부전형'])
    ].join('|');
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(row);
  });

  groups.forEach(group => {
    if (group.length !== 2) return;
    const activeRows = group.filter(row => (firstNumber(row['모집인원27']) ?? 0) > 0);
    const inactiveRows = group.filter(row => (firstNumber(row['모집인원27']) ?? 0) <= 0);
    if (activeRows.length !== 1 || inactiveRows.length !== 1) return;

    const active = activeRows[0];
    const inactive = inactiveRows[0];
    const activeRecruit26 = firstNumber(active['모집인원26']);
    const inactiveRecruit26 = firstNumber(inactive['모집인원26']);
    if (activeRecruit26 === null || activeRecruit26 !== inactiveRecruit26) return;

    HISTORICAL_RESULT_FIELDS.forEach(field => {
      if (!hasValue(active[field]) && hasValue(inactive[field])) active[field] = inactive[field];
    });
  });
}

function operationalKey(row) {
  return [
    normalizeGroup(row['전형선택']),
    normalizeUniversity(row['계열학과']),
    normalizeUniversity(row['전형명']),
    firstNumber(row['모집인원']) ?? ''
  ].join('|');
}

function manualKey(university, row) {
  return `${university}\t${operationalKey(row)}`;
}

function rankOperationalRows(rows, operationalRow, typeNormalizer, useLiteralType = true, university = '') {
  const opDepartment = normalizeUniversity(operationalRow['계열학과']);
  const opDepartmentBase = normalizeDepartment(operationalRow['계열학과']);
  const opDepartmentVariants = operationalDepartmentVariants(operationalRow['계열학과'], university)
    .map(normalizeUniversity);
  const opDepartmentBaseVariants = operationalDepartmentVariants(operationalRow['계열학과'], university)
    .map(normalizeDepartment);
  const opTypeLiterals = operationalTypeVariants(operationalRow['전형명'], university)
    .map(normalizeTypeLiteral);
  const opTypes = operationalTypeVariants(operationalRow['전형명'], university)
    .map(typeNormalizer);
  const opGroup = normalizeGroup(operationalRow['전형선택']);
  const opRecruit = firstNumber(operationalRow['모집인원']);
  const candidates = [];

  rows.forEach((row, index) => {
    const rowDepartments = splitTopLevelDepartments(row['세부전공']);
    const rowDepartment = normalizeUniversity(row['세부전공']);
    const rowDepartmentBase = normalizeDepartment(row['세부전공']);
    const normalizedDepartments = rowDepartments.map(normalizeUniversity);
    const normalizedDepartmentBases = rowDepartments.map(normalizeDepartment);
    const normalizedDepartmentVariants = trailingParentheticalVariants(row['세부전공'])
      .map(normalizeUniversity);
    const normalizedDepartmentBaseVariants = trailingParentheticalVariants(row['세부전공'])
      .map(normalizeDepartment);
    const rowRecruit = firstNumber(row['모집인원27']);
    let score = 0;

    // 단일 모집단위 공시행이 있으면 묶음 공시행보다 항상 우선한다.
    if (rowDepartment === opDepartment) score += 60;
    else if (rowDepartmentBase && rowDepartmentBase === opDepartmentBase) score += 48;
    else if (normalizedDepartments.includes(opDepartment)) score += 58;
    else if (opDepartmentBase && normalizedDepartmentBases.includes(opDepartmentBase)) score += 46;
    else if (opDepartmentVariants.includes(rowDepartment)) {
      if (rowRecruit === null || opRecruit === null || rowRecruit !== opRecruit) return;
      score += 57;
    } else if (rowDepartmentBase && opDepartmentBaseVariants.includes(rowDepartmentBase)) {
      if (rowRecruit === null || opRecruit === null || rowRecruit !== opRecruit) return;
      score += 45;
    }
    else if (normalizedDepartmentVariants.includes(opDepartment)) {
      if (rowRecruit === null || opRecruit === null || rowRecruit !== opRecruit) return;
      score += 56;
    } else if (opDepartmentBase && normalizedDepartmentBaseVariants.includes(opDepartmentBase)) {
      if (rowRecruit === null || opRecruit === null || rowRecruit !== opRecruit) return;
      score += 44;
    }
    else return;

    const rowTypeLiteral = normalizeTypeLiteral(row['세부전형']);
    const rowType = typeNormalizer(row['세부전형']);
    const rowGroup = normalizeGroup(row['전형']);
    if (useLiteralType && rowTypeLiteral && opTypeLiterals.includes(rowTypeLiteral)) score += 45;
    else if (rowType && opTypes.includes(rowType)) score += 45;
    else if (
      rowType && opTypes.some(opType => (
        opType
        && (rowType.includes(opType) || opType.includes(rowType))
        && Math.min(rowType.length, opType.length) >= 2
      ))
    ) score += 30;

    if (rowGroup && opGroup && rowGroup === opGroup) score += 10;
    if (rowRecruit !== null && opRecruit !== null && rowRecruit === opRecruit) score += 18;
    candidates.push({ index, score });
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function uniqueCandidate(candidates, minimumScore, rows = null) {
  if (!candidates.length || candidates[0].score < minimumScore) return null;
  if (candidates[1] && candidates[1].score === candidates[0].score) {
    if (!rows) return null;

    const topScore = candidates[0].score;
    const tiedCandidates = candidates.filter(candidate => candidate.score === topScore);
    const identities = new Set(tiedCandidates.map(candidate => {
      const row = rows[candidate.index];
      return [
        normalizeUniversity(row['세부전공']),
        normalizeGroup(row['전형']),
        normalizeTypeLiteral(row['세부전형'])
      ].join('|');
    }));
    const activeCandidates = tiedCandidates.filter(candidate => {
      const recruit = firstNumber(rows[candidate.index]['모집인원27']);
      return recruit !== null && recruit > 0;
    });

    // 같은 학과·전형의 구행과 활성행이 중복된 경우에만 2027 활성행을 선택한다.
    if (identities.size === 1 && activeCandidates.length === 1) return activeCandidates[0];
    return null;
  }
  return candidates[0];
}

function matchOperationalRow(rows, operationalRow, university = '') {
  const legacy = uniqueCandidate(
    rankOperationalRows(rows, operationalRow, normalizeTypeLegacy, false, university),
    93,
    rows
  );
  const enhanced = uniqueCandidate(
    rankOperationalRows(rows, operationalRow, normalizeType, true, university),
    93,
    rows
  );

  // 기존 연결은 깨뜨리지 않는다. 새 규칙이 더 높은 점수로 특정한 경우에만 교정한다.
  if (legacy) {
    if (enhanced && enhanced.index !== legacy.index && enhanced.score > legacy.score) {
      return enhanced;
    }
    return legacy;
  }

  // 새 규칙만으로 찾은 낮은 점수 후보는 자동 확정하지 않고 교사 확인 대상으로 남긴다.
  return enhanced && enhanced.score >= 105 ? enhanced : null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function publicRow(row, fileName, rowIndex) {
  for (const key of Object.keys(row)) {
    if (PRIVATE_KEY_PATTERN.test(key)) {
      throw new Error(`${fileName} ${rowIndex + 1}행: 비공개 의심 필드 ${key}`);
    }
  }

  const textValues = Object.values(row)
    .filter(value => typeof value === 'string')
    .join('\n');

  if (EMAIL_PATTERN.test(textValues) || PHONE_PATTERN.test(textValues) || RESIDENT_PATTERN.test(textValues)) {
    throw new Error(`${fileName} ${rowIndex + 1}행: 개인정보 형식으로 보이는 값 발견`);
  }

  const result = {};
  for (const key of PUBLIC_FIELDS) {
    const value = row[key];
    // 공개 파일 크기를 줄이기 위해 null/빈 문자열 필드는 기록하지 않는다.
    if (value === null || value === undefined || value === '') continue;
    result[key] = value;
  }
  return result;
}

if (!fs.existsSync(sourceDir)) {
  throw new Error(`원본 폴더가 없습니다: ${sourceDir}`);
}

const manualRoot = fs.existsSync(manualCrosswalkPath)
  ? JSON.parse(fs.readFileSync(manualCrosswalkPath, 'utf8'))
  : { version: 1, mappings: [] };

if (!manualRoot || !Array.isArray(manualRoot.mappings)) {
  throw new Error('수동 매칭표의 mappings가 배열이 아닙니다.');
}

const manualMappings = new Map();
manualRoot.mappings.forEach((mapping, index) => {
  const university = String(mapping.university || '').trim();
  const key = String(mapping.operationalKey || '').trim();
  const sourceId = String(mapping.sourceId ?? '').trim();
  if (!university || !key || !sourceId) {
    throw new Error(`수동 매칭표 ${index + 1}번: university, operationalKey, sourceId가 필요합니다.`);
  }
  const combined = `${university}\t${key}`;
  if (manualMappings.has(combined)) {
    throw new Error(`수동 매칭표 중복: ${university} / ${key}`);
  }
  manualMappings.set(combined, { sourceId, mapping });
});

const manualRules = new Map();
const manualRuleAppliedCounts = new Map();
(Array.isArray(manualRoot.rules) ? manualRoot.rules : []).forEach((rule, index) => {
  const university = String(rule.university || '').trim();
  const operationalType = String(rule.operationalType || '').trim();
  const candidateType = String(rule.candidateType || '').trim();
  const expectedCount = Number(rule.expectedCount);
  if (!university || !operationalType || !candidateType || !Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new Error(`수동 매칭 규칙 ${index + 1}번: 대학, 두 전형명, expectedCount가 필요합니다.`);
  }
  const key = `${university}\t${operationalType}`;
  if (manualRules.has(key)) throw new Error(`수동 매칭 규칙 중복: ${key}`);
  manualRules.set(key, { ...rule, university, operationalType, candidateType, expectedCount });
  manualRuleAppliedCounts.set(key, 0);
});

const rejectedPairs = new Set();
(Array.isArray(manualRoot.rejections) ? manualRoot.rejections : []).forEach((rejection, index) => {
  const university = String(rejection.university || '').trim();
  const operationalType = String(rejection.operationalType || '').trim();
  const candidateType = String(rejection.candidateType || '').trim();
  const sourceUrl = String(rejection.sourceUrl || '').trim();
  if (!university || !operationalType || !candidateType || !sourceUrl) {
    throw new Error(`제외 규칙 ${index + 1}번: 대학, 두 전형명, 공식 근거 URL이 필요합니다.`);
  }
  rejectedPairs.add(`${university}\t${operationalType}\t${candidateType}`);
});

function isRejectedPair(university, operationalRow, sourceRow) {
  const operationalType = String(operationalRow['전형명'] || '').trim();
  const candidateType = String(sourceRow?.['세부전형'] || '').trim();
  return rejectedPairs.has(`${university}\t${operationalType}\t${candidateType}`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(universityDir, { recursive: true });

const sourceFiles = fs.readdirSync(sourceDir)
  .filter(name => name.endsWith('.json'))
  .sort((a, b) => a.localeCompare(b, 'ko'));

const sourceUniversityNames = sourceFiles.map(name => name.replace(/\.json$/i, ''));
const sourceNameByNormalized = new Map();
sourceUniversityNames.forEach(name => {
  const key = normalizeUniversity(name);
  if (!sourceNameByNormalized.has(key)) sourceNameByNormalized.set(key, []);
  sourceNameByNormalized.get(key).push(name);
});

// 강원대학교는 2027 공식 수시모집요강을 춘천·삼척과 강릉·원주로 나누어
// 공고하지만 운영자료의 대학명은 모두 `강원대학교`로 합쳐져 있다.
// 학과·전형군·전형명·모집인원이 한 캠퍼스 원문에만 정확히 존재할 때에만
// 해당 파일로 보낸다. 하나라도 다르거나 여러 캠퍼스에 겹치면 기존처럼 보류한다.
const EXACT_CAMPUS_ROUTING_GROUPS = new Map([
  ['강원대학교', [
    '강원대학교', '강원대학교(강릉)', '강원대학교(원주)',
    '강원대학교(삼척)', '강원대학교(도계)'
  ]],
  ['연세대학교', [
    '연세대학교', '연세대학교(미래)'
  ]],
  ['경북대학교', [
    '경북대학교', '경북대학교(상주)'
  ]],
  ['경상국립대학교', [
    '경상국립대학교', '경상국립대학교(통영)'
  ]]
]);

function exactCampusRoutingKey(group, department, type, recruit) {
  const recruitNumber = firstNumber(recruit);
  if (!group || !department || !type || recruitNumber === null) return null;
  return [
    normalizeGroup(group),
    normalizeUniversity(department),
    normalizeType(type),
    recruitNumber
  ].join('|');
}

const exactCampusSourceNames = new Map();
for (const [baseUniversity, campusNames] of EXACT_CAMPUS_ROUTING_GROUPS) {
  const sourceNamesByKey = new Map();
  for (const campusName of campusNames) {
    const campusPath = path.join(sourceDir, `${campusName}.json`);
    if (!fs.existsSync(campusPath)) continue;
    const campusRows = JSON.parse(fs.readFileSync(campusPath, 'utf8'));
    for (const row of campusRows) {
      const departmentVariants = baseUniversity === '강원대학교'
        ? trailingParentheticalVariants(row['세부전공'])
        : [row['세부전공']];
      for (const departmentVariant of departmentVariants) {
        const key = exactCampusRoutingKey(
          row['전형'], departmentVariant, row['세부전형'], row['모집인원27']
        );
        if (!key) continue;
        if (!sourceNamesByKey.has(key)) sourceNamesByKey.set(key, new Set());
        sourceNamesByKey.get(key).add(campusName);
      }
    }
  }
  exactCampusSourceNames.set(baseUniversity, sourceNamesByKey);
}

function resolveSourceUniversityName(value) {
  const university = String(value || '').trim();
  if (sourceUniversityNames.includes(university)) return university;

  let matches = sourceNameByNormalized.get(normalizeUniversity(university)) || [];
  if (matches.length === 1) return matches[0];

  const withoutCampus = university.replace(/\s*\([^()]+\)\s*$/, '').trim();
  matches = sourceNameByNormalized.get(normalizeUniversity(withoutCampus)) || [];
  return matches.length === 1 ? matches[0] : null;
}

// 공식 모집요강의 캠퍼스 열을 기준으로, 운영자료에서 본교 이름으로 합쳐진 행을
// 실제 상세 원문 파일에 배정한다. 확인되지 않은 대학·모집단위에는 적용하지 않는다.
function resolveOperationalSourceUniversityName(value, operationalRow) {
  const resolved = resolveSourceUniversityName(value);
  const exactCampusCandidates = exactCampusSourceNames.get(resolved);
  if (exactCampusCandidates) {
    const group = operationalRow?.['전형선택'];
    const department = String(operationalRow?.['계열학과'] || '').trim();
    const type = String(operationalRow?.['전형명'] || '').trim();
    const recruit = operationalRow?.['모집인원'];
    const routingKeys = [exactCampusRoutingKey(group, department, type, recruit)];

    if (resolved === '강원대학교') {
      // 통합 운영자료에만 붙은 캠퍼스 구분 표기를 제거한 뒤에도
      // 삼척·도계 원문 중 하나에만 정확히 일치해야 라우팅한다.
      routingKeys.push(exactCampusRoutingKey(
        group,
        department
          .replace(/\s*\(삼척·도계\)\s*$/, '')
          .replace(/\s*\(도계\)\s*$/, '')
          .replace(/\s*\((강릉|원주)\)\s*$/, ''),
        type
          .replace(/\s*\(삼척·도계\)/g, '')
          .replace(/\s*\(원주\)/g, ''),
        recruit
      ));
      routingKeys.push(exactCampusRoutingKey(
        group,
        department
          .replace(/\s*\(삼척·도계\)\s*$/, '')
          .replace(/\s*\(도계\)\s*$/, '')
          .replace(/\s*\((강릉|원주)\)\s*$/, '')
          .replace(/\(인문계열\)/g, '(인문)')
          .replace(/\(자연계열\)/g, '(자연)'),
        type
          .replace(/\s*\(삼척·도계\)/g, '')
          .replace(/\s*\(원주\)/g, ''),
        recruit
      ));
      if (department === '디지털미디어커뮤니케이션학과') {
        routingKeys.push(exactCampusRoutingKey(
          group, '디지털미디어커뮤니케이션학부', type, recruit
        ));
      }
      if (department === '생명과학과') {
        routingKeys.push(exactCampusRoutingKey(
          group, '생명과학과(춘천)', type, recruit
        ));
      }
      if (department === '공학대학 자유전공학과') {
        routingKeys.push(exactCampusRoutingKey(
          group,
          '공과대학 자유전공학과',
          type.replace(/\s*\(삼척·도계\)/g, ''),
          recruit
        ));
      }
      if (type === '체육특기자전형') {
        routingKeys.push(exactCampusRoutingKey(
          group, department, '특기자전형', recruit
        ));
      }
      const humanSports = department.match(/^(휴먼스포츠학과)\([^()]+\)$/);
      if (humanSports && /^체육특기자전형-(개인|단체)종목/.test(type)) {
        const eventType = type.includes('개인')
          ? '체육특기자전형(개인)'
          : '체육특기자전형(단체)';
        routingKeys.push(exactCampusRoutingKey(
          group, humanSports[1], eventType, recruit
        ));
      }
      const gangneungCollege = department.match(
        /^(인문대학|사회과학대학|자연과학대학|생명과학대학|공과대학)\(강릉\) (?:전|해당) 모집단위$/
      );
      if (gangneungCollege) {
        const college = gangneungCollege[1];
        const collegeVariants = [college];
        if (college === '인문대학') collegeVariants.push('인문대학(자유전공학과제외)');
        if (college === '자연과학대학') {
          collegeVariants.push('자연과학대학(자유전공학과제외)');
          collegeVariants.push('자연과학대학(자연과학자유전공학과제외)');
        }
        if (college === '생명과학대학') {
          collegeVariants.push('생명과학대학(자유전공학과제외)');
          collegeVariants.push('생명과학대학(생명과학대학자유전공학과제외)');
        }
        for (const collegeVariant of collegeVariants) {
          routingKeys.push(exactCampusRoutingKey(
            group, collegeVariant, type, recruit
          ));
        }
      }
      if (/\(치과대학\)/.test(type)) {
        routingKeys.push(exactCampusRoutingKey(
          group,
          department.replace(/\s*\(강릉\)\s*$/, ''),
          type.replace(/\s*\(치과대학\)/g, ''),
          recruit
        ));
      }
    }

    if (resolved === '경상국립대학교') {
      const departmentVariants = [department.replace(/\*/g, '').replace(/\//g, ',')];
      if (department === '해양식품공학·수산생명의학부(해양식품공학전공/수산생명의학전공)') {
        departmentVariants.push('해양식품생명의학부(해양식품공학/수산생명의학)');
      }
      const typeVariants = [type];
      if (type === '특성화고교출신자전형') {
        typeVariants.push('특성화고교졸업자전형 (외)');
      }
      for (const departmentVariant of departmentVariants) {
        for (const typeVariant of typeVariants) {
          routingKeys.push(exactCampusRoutingKey(
            group, departmentVariant, typeVariant, recruit
          ));
        }
      }
    }

    if (resolved === '경북대학교') {
      // 운영자료는 경북대 본교명으로 합쳐져 있고 상세 원문은 상주캠퍼스를
      // 별도 파일로 둔다. 공식 모집요강의 표기 차이만 보정한 뒤에도 한
      // 캠퍼스에 학과·전형·인원이 모두 정확히 있어야 라우팅한다.
      const departmentVariants = [department];
      if (department === '말/특수동물학과') departmentVariants.push('말특수동물학과');
      const textile = department.match(/^섬유패션디자인학부 (섬유공학전공|패션디자인전공)$/);
      if (textile) departmentVariants.push(`섬유패션디자인학부(${textile[1]})`);

      const typeVariants = [type];
      if (type === '기초생활수급자등대상자전형(정원외)') {
        typeVariants.push('기초생활등대상자전형 (외)');
      }
      if (type === '특성화고졸업자전형(정원외)') {
        typeVariants.push('특성화고졸업자전형 (외)');
      }
      for (const departmentVariant of departmentVariants) {
        for (const typeVariant of typeVariants) {
          routingKeys.push(exactCampusRoutingKey(
            group, departmentVariant, typeVariant, recruit
          ));
        }
      }
    }

    for (const exactKey of [...new Set(routingKeys.filter(Boolean))]) {
      const candidateNames = exactCampusCandidates.get(exactKey);
      if (resolved === '강원대학교') {
        const explicitCampus = department.match(/\((강릉|원주|도계)\)\s*$/)?.[1];
        const explicitCampusName = explicitCampus
          ? `강원대학교(${explicitCampus})`
          : null;
        if (explicitCampusName && candidateNames?.has(explicitCampusName)) {
          return explicitCampusName;
        }
      }
      if (candidateNames?.size === 1) return [...candidateNames][0];
    }
  }

  if (resolved !== '부산대학교') return resolved;

  const department = String(operationalRow?.['계열학과'] || '').trim();
  if (department.startsWith('생명자원과학대학 ')) return '부산대학교(밀양)';

  const yangsanPrefixes = ['간호대학 ', '의과대학 ', '치과대학 ', '한의학전문대학원 '];
  const yangsanDepartments = [
    '공과대학 바이오메디컬공학과',
    '학부대학 응용생명융합학부',
    'AI대학 데이터사이언스학부'
  ];
  if (
    yangsanPrefixes.some(prefix => department.startsWith(prefix))
    || yangsanDepartments.some(name => department.startsWith(name))
  ) return '부산대학교(양산)';

  return resolved;
}

const operationalByUniversity = new Map();
let operationalTotal = 0;
let operationalFileMissing = 0;

if (fs.existsSync(operationalPath)) {
  const operationalRoot = JSON.parse(fs.readFileSync(operationalPath, 'utf8'));
  const operationalData = operationalRoot && operationalRoot.data ? operationalRoot.data : {};

  Object.entries(operationalData).forEach(([universityKey, rows]) => {
    if (universityKey === '대학' || !Array.isArray(rows)) return;
    rows.forEach(row => {
      operationalTotal++;
      const sourceName = resolveOperationalSourceUniversityName(
        row['대학명'] || universityKey,
        row
      );
      if (!sourceName) {
        operationalFileMissing++;
        return;
      }
      if (!operationalByUniversity.has(sourceName)) operationalByUniversity.set(sourceName, []);
      operationalByUniversity.get(sourceName).push(row);
    });
  });
}

const index = {
  version: 1,
  year: 2027,
  generatedAt: new Date().toISOString(),
  universityCount: 0,
  rowCount: 0,
  mappedOperationalRows: 0,
  operationalRowCount: operationalTotal,
  operationalFileMissing,
  manualMappedOperationalRows: 0,
  publicFields: PUBLIC_FIELDS,
  universities: []
};

const review = {
  version: 1,
  year: 2027,
  generatedAt: index.generatedAt,
  description: '자동 확정하지 않은 대학별 상세정보 매칭 후보. 공개 배포 대상이 아님.',
  items: []
};

const normalizedNames = new Map();

for (const fileName of sourceFiles) {
  const sourcePath = path.join(sourceDir, fileName);
  const university = fileName.replace(/\.json$/i, '');
  const normalized = normalizeUniversity(university);

  if (normalizedNames.has(normalized)) {
    throw new Error(`대학명 정규화 충돌: ${normalizedNames.get(normalized)} / ${university}`);
  }
  normalizedNames.set(normalized, university);

  const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${fileName}: 최상위 데이터가 배열이 아닙니다.`);

  fillHistoricalDuplicateGaps(parsed);
  const rows = parsed.map((row, index) => publicRow(row, fileName, index));
  const sourceIndexById = new Map();
  parsed.forEach((row, rowIndex) => {
    const sourceId = String(row['ID'] ?? '').trim();
    if (!sourceId) return;
    if (sourceIndexById.has(sourceId)) {
      throw new Error(`${fileName}: ID 중복 ${sourceId}`);
    }
    sourceIndexById.set(sourceId, rowIndex);
  });
  const lookup = {};
  const conflictedKeys = new Set();

  (operationalByUniversity.get(university) || []).forEach(operationalRow => {
    const confirmed = manualMappings.get(manualKey(university, operationalRow));
    const ruleKey = `${university}\t${String(operationalRow['전형명'] || '').trim()}`;
    const confirmedRule = manualRules.get(ruleKey);
    let matched = null;
    if (confirmed) {
      const rowIndex = sourceIndexById.get(confirmed.sourceId);
      if (rowIndex === undefined) {
        throw new Error(`${fileName}: 수동 매칭 ID를 찾을 수 없음 ${confirmed.sourceId}`);
      }
      matched = { index: rowIndex, score: 'manual' };
      index.manualMappedOperationalRows++;
    } else {
      matched = matchOperationalRow(parsed, operationalRow, university);
      if (matched && isRejectedPair(university, operationalRow, parsed[matched.index])) {
        matched = null;
      }

      // 자동 매칭되지 않은 행에만 확인 규칙을 적용한다.
      if (!matched && confirmedRule) {
        const rankedCandidates = rankOperationalRows(parsed, operationalRow, normalizeType, true, university)
          .filter(candidate => !isRejectedPair(university, operationalRow, parsed[candidate.index]));
        // 공식자료나 교사 확인으로 전형명이 확정된 규칙은 같은 학과 안에서
        // 승인된 전형명 후보만 다시 유일성 검사할 수 있다. 이 옵션이 없는
        // 기존 규칙은 종전처럼 전체 1순위 후보가 유일할 때만 적용한다.
        const ruleCandidates = confirmedRule.resolveTypeTies
          ? rankedCandidates.filter(candidate => (
              String(parsed[candidate.index]['세부전형'] || '').trim() === confirmedRule.candidateType
            ))
          : rankedCandidates;
        const topCandidate = ruleCandidates[0];
        const topCandidateType = topCandidate
          ? String(parsed[topCandidate.index]['세부전형'] || '').trim()
          : '';
        // 교사나 공식자료로 확인한 1순위 후보만 적용한다. 2·3순위까지 임의 확대하지 않는다.
        matched = topCandidate && topCandidateType === confirmedRule.candidateType
          ? uniqueCandidate(ruleCandidates, 0)
          : null;
        if (matched) {
          manualRuleAppliedCounts.set(ruleKey, manualRuleAppliedCounts.get(ruleKey) + 1);
          index.manualMappedOperationalRows++;
        }
      }
    }

    if (!matched) {
      const candidates = rankOperationalRows(parsed, operationalRow, normalizeType, true, university)
        .filter(candidate => !isRejectedPair(university, operationalRow, parsed[candidate.index]))
        .slice(0, 3)
        .map(candidate => {
          const row = parsed[candidate.index];
          return {
            sourceId: row['ID'] ?? '',
            department: row['세부전공'] ?? '',
            group: row['전형'] ?? '',
            type: row['세부전형'] ?? '',
            recruit27: row['모집인원27'] ?? '',
            score: candidate.score
          };
        });

      review.items.push({
        university,
        operationalKey: operationalKey(operationalRow),
        department: operationalRow['계열학과'] ?? '',
        group: operationalRow['전형선택'] ?? '',
        type: operationalRow['전형명'] ?? '',
        recruit: operationalRow['모집인원'] ?? '',
        candidates
      });
      return;
    }

    const key = operationalKey(operationalRow);
    if (Object.prototype.hasOwnProperty.call(lookup, key) && lookup[key] !== matched.index) {
      delete lookup[key];
      conflictedKeys.add(key);
      return;
    }
    if (!conflictedKeys.has(key)) lookup[key] = matched.index;
  });

  index.mappedOperationalRows += Object.keys(lookup).length;
  const payload = { rows, lookup };
  const json = JSON.stringify(payload);
  const outputPath = path.join(universityDir, fileName);
  fs.writeFileSync(outputPath, json + '\n', 'utf8');

  index.universities.push({
    name: university,
    normalized,
    path: `universities/${fileName}`,
    rows: rows.length,
    bytes: Buffer.byteLength(json),
    sha256: sha256(json)
  });
  index.rowCount += rows.length;
}

index.universityCount = index.universities.length;
const manualCountMismatches = [];
for (const [key, rule] of manualRules) {
  const appliedCount = manualRuleAppliedCounts.get(key);
  if (appliedCount !== rule.expectedCount) {
    manualCountMismatches.push(
      `${rule.university} / ${rule.operationalType} (예상 ${rule.expectedCount}, 실제 ${appliedCount})`
    );
  }
}
if (manualCountMismatches.length) {
  throw new Error(`확인된 수동 매칭 건수 변경:\n${manualCountMismatches.join('\n')}`);
}
fs.writeFileSync(path.join(outputDir, 'index.json'), JSON.stringify(index) + '\n', 'utf8');
fs.rmSync(reviewDir, { recursive: true, force: true });
fs.mkdirSync(reviewDir, { recursive: true });
fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  universityCount: index.universityCount,
  rowCount: index.rowCount,
  mappedOperationalRows: index.mappedOperationalRows,
  operationalRowCount: index.operationalRowCount,
  operationalFileMissing: index.operationalFileMissing,
  manualMappedOperationalRows: index.manualMappedOperationalRows,
  reviewItemCount: review.items.length,
  outputDir,
  outputBytes: index.universities.reduce((sum, item) => sum + item.bytes, 0),
  indexBytes: fs.statSync(path.join(outputDir, 'index.json')).size
}, null, 2));
