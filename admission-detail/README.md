# 2027 대학별 전형 상세정보

수시지원카드에서 사용하는 공개용 정적 JSON입니다.

- `2027/index.json`: 대학 목록, 파일 경로, 버전, 해시
- `2027/universities/*.json`: 대학별 전형 상세정보
- 학생은 선택한 대학 파일 하나만 다운로드합니다.

## 공개 제외 정보

다음 정보는 생성 과정에서 제외합니다.

- 학번, 이름, 연락처, 이메일, 비밀번호 등 개인정보
- 학생상담, 교사메모 등 지원카드 내부 정보
- 교사 내부 참고 성격의 `입결예상`
- 2020~2023 과거 항목

## 생성

Drive 원본을 `admission-detail-source/2027` 폴더에 준비한 다음 실행합니다.

```bash
node scripts/build-admission-detail.mjs
```

생성 스크립트는 JSON 문법, 개인정보 의심 필드/형식, 대학명 충돌을 검사하고 문제가 있으면 중단합니다.

## 매칭 원칙

- 확실한 대학·학과·전형만 자동 연결합니다.
- 자동 판단이 애매한 항목은 `admission-detail-review/2027/matching-review.json`에 기록하며 공개하지 않습니다.
- 교사가 확인한 항목만 `scripts/admission-detail-manual-crosswalk.json`에 추가해 다음 생성부터 고정 적용합니다.
- 공식 모집요강에서 서로 다른 전형으로 확인된 조합은 `rejections`에 근거 링크와 함께 기록해 다시 추천하지 않습니다.
