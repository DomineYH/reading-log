# 책갈피 · 초등학생 독서 기록장

한국어 모바일 대응 독서 기록 앱입니다. GitHub Pages는 시작 페이지, Apps Script HTML Service는 실제 로그인·기록 화면, 비공개 Google Sheets는 데이터 저장소를 맡습니다.

**설치: [app_setup.md](app_setup.md)** · **검증 범위: [TEST_REPORT.md](TEST_REPORT.md)**

- 로그인 이름 + 학생별 비밀번호
- 읽기 시작한 날 / 다 읽은 날 / 책 제목 / 출판사 / 책 쪽수 / 감상
- 등록한 모든 책의 쪽수 합계 자동 계산, 나만의 기록 조회·수정·삭제
- 미완독도 총 쪽수에 포함 (실제로 읽은 쪽수와는 다름)
- 비밀번호 원문 저장 없음, 세션별 학생 권한 검사

아직 Google/GitHub에 배포하지 않았으며 실제 서비스 연동은 설치 후 확인해야 합니다. 이 코드는 소규모 학급용 시작점입니다. 교육기관의 개인정보 처리 검토와 운영 책임자를 정한 뒤 실제 학생 정보를 입력하세요.

## 로컬 확인

Node.js 18 이상과 Python 3가 필요합니다. `npm test`. `npm run serve` 후 http://localhost:8000 에서 시작 페이지를 확인하세요. 시작 페이지의 체험 링크는 가상 데이터로만 동작하며 새로고침하면 초기화됩니다. 실제 저장·로그인은 Apps Script 배포가 필요합니다. 교사 발급 도구는 `provision.html`입니다.

## 파일

- `index.html`, `config.js`: GitHub Pages 시작 화면과 공개 웹 앱 주소
- `apps-script/Index.html`: 실제 학생용 UI
- `apps-script/Code.gs`: 인증·기록·교사용 초기화 함수
- `apps-script/appsscript.json`: 권한/서비스 설정
- `provision.html`: 비밀번호에서 발급 값 생성, 네트워크 통신 없음
- `tests/`: 외부 서비스 없이 실행하는 테스트

학생 데이터, 비밀번호, 발급 값, 세션 토큰, 시트 ID, 스크립트 속성은 저장소에 넣지 마세요.
