# 🧾 초간단 전표 정리 (Expense Tracker)

영수증 이미지를 업로드하면 OCR을 통해 정보를 자동 인식하고, 달력 및 ERP 형식으로 직관적인 지출 내역 관리를 돕는 웹 애플리케이션입니다.

## ✨ 주요 기능

1. **📸 영수증 일괄 스캔 (OCR)**
   - 여러 장의 영수증을 한 번에 스캔하여 금액, 가맹점, 일자 자동 추출
   - Google Cloud Vision API 사용 (실패 시 Tesseract.js로 자동 폴백)
2. **💻 직관적인 전표 관리 UI**
   - **달력 뷰**: 일별 지출 내역을 달력에서 한눈에 확인
   - **분개전표 및 ERP 패널**: 회계 시스템 스타일의 전표 관리 및 상세 내역(사원, 거래처 등) 미리보기 제공
   - **분할 레이아웃**: 좌측에서 전표를 관리하며 우측에서 영수증 원본을 상시 확인
3. **🔄 자동 동기화 및 내보내기**
   - **게스트 & 로그인**: 로그인 없이도 로컬에 즉시 사용 가능하며, 로그인 시 클라우드로 자동 동기화
   - **다운로드**: 월별 전표 내역 엑셀(`xlsx`) 추출 및 영수증 원본 `ZIP` 일괄 다운로드

## 🛡️ 보안 및 프라이버시 (Security & Privacy)

민감한 지출 내역과 영수증 데이터를 안전하게 보호하기 위해 다음과 같은 보안 체계를 갖추고 있습니다.

- **데이터 암호화 및 보호**: 사용자 비밀번호는 `bcrypt` 알고리즘을 통해 강력하게 단방향 암호화되어 데이터베이스에 저장됩니다.
- **안전한 세션 관리**: JSON Web Token(`JWT`)을 사용하여 인가된 사용자만 본인의 데이터에 접근할 수 있도록 세션을 안전하게 관리하고 데이터를 격리(Multi-tenancy)합니다.
- **영수증 자동 파기 정책**: 클라이언트 기기 및 서버의 저장소 최적화와 개인정보 보호를 위해, 업로드된 영수증 원본 이미지는 **해당 월 종료 30일 이후 시스템에서 영구적으로 자동 파기**됩니다.
- **하이브리드 아키텍처**: 데이터 전송 및 중앙 DB 부하를 최소화하기 위해 영수증 이미지 등 일부 민감한 데이터는 우선적으로 브라우저 로컬 저장소(IndexedDB)에 보관됩니다.

## 🛠 기술 스택

- **Frontend**: HTML5, Vanilla JS, CSS3, JSZip, SheetJS
- **Backend**: Node.js, Express.js
- **Database**: SQLite (LibSQL / Turso 지원)
- **Auth**: JWT (JSON Web Tokens), bcrypt
- **Mail**: Brevo HTTP API (비밀번호 재설정 코드 발송)
- **Deployment**: Render (Web Service Blueprint), GitHub

## 🚀 로컬 실행 방법

**1. 패키지 설치**
```bash
npm install
```

**2. 환경 변수 설정**
루트 경로에 `.env` 파일을 생성하고 아래 항목을 입력합니다. (비워둘 경우 로컬/폴백 모드로 동작합니다)
```env
PORT=10000
JWT_SECRET=your_jwt_secret_key          # JWT 암호화에 쓰일 고유 키
TURSO_DATABASE_URL=                     # 비워두면 로컬 local.db 사용
TURSO_AUTH_TOKEN=
GOOGLE_VISION_API_KEY=                  # 비워두면 Tesseract.js 사용
BREVO_API_KEY=                          # 비밀번호 재설정 메일 발송용
MAIL_FROM=
```

**3. 서버 실행**
```bash
npm start
```
`http://localhost:10000`에 접속하여 앱을 사용할 수 있습니다.
