# 영수증 스캔하면 끝! 초간단 전표 정리 (Expense Tracker)

영수증 이미지를 업로드하면 OCR로 금액·가맹점·일자를 자동 인식하고, 달력 UI 기반으로 직관적인 전표 관리 및 지출 내역을 관리할 수 있는 하이브리드 가계부 웹 애플리케이션입니다.

<!-- 앱 스크린샷이나 동작 GIF를 여기에 추가하면 좋습니다. -->
<!-- ![App Screenshot](./docs/screenshot.png) -->

## ✨ 주요 기능 (Features)

- **📸 영수증 자동 스캔 (OCR)**
  - **Google Cloud Vision API**(`DOCUMENT_TEXT_DETECTION`)로 영수증 이미지에서 날짜, 금액, 사용처(상호명)를 자동 추출합니다. 한글 인식률이 높습니다.
  - API 키가 없으면 클라이언트의 **Tesseract.js**로 자동 폴백하므로, 별도 세팅 없이도 동작합니다.
  - 다중 이미지 일괄 스캔을 지원하며, 인식 결과로 메모를 자동 생성합니다.
  - *Tip: 선명하게 촬영되고 구겨짐이 없는 영수증일수록 인식률이 크게 향상됩니다.*
- **📅 달력 기반 직관적 UI**
  - 달력 형태로 일별 지출 내역 및 합계를 한눈에 파악할 수 있습니다.
  - 깔끔한 다크/라이트 모드 테마를 지원하며, 모바일 환경에 맞춘 Apple 디자인 시스템을 적용했습니다.
- **🔐 로그인 및 데이터 동기화 (Multi-tenancy)**
  - **게스트 모드**: 로그인 없이도 브라우저(`localStorage`, `IndexedDB`)에 데이터를 저장하고 즉시 사용할 수 있습니다.
  - **계정 동기화**: 게스트 상태에서 작성한 모든 전표와 영수증 이미지는 회원가입/로그인 시 사용자 계정 클라우드 DB로 원클릭 동기화됩니다.
  - JWT 기반 인증으로 각 사용자의 데이터는 안전하게 분리·보호됩니다.
- **🔑 비밀번호 재설정 (이메일 인증)**
  - 비밀번호를 잊은 경우, 이메일로 인증 코드를 받아 재설정할 수 있습니다.
  - 메일 발송은 **Brevo HTTP API**(443 포트)를 사용합니다. API 키 미설정 시 인증 코드가 서버 콘솔에 출력되어 개발/테스트가 가능합니다.
- **🗑 영수증 이미지 자동 파기 (60일 정책)**
  - 기기 용량 관리를 위해 로컬 브라우저 및 서버에 저장된 영수증 이미지는 60일이 경과하면 자동으로 삭제(파기)됩니다.
- **📥 데이터 내보내기**
  - 등록된 전표 내역을 엑셀(Excel, xlsx) 파일로 월별 혹은 전체 다운로드할 수 있습니다. (비용구분 컬럼 포함)
  - 첨부했던 영수증 이미지 원본들을 ZIP 파일로 일괄 압축하여 다운로드할 수 있습니다.

## 🛠 기술 스택 (Tech Stack)

- **Frontend**: HTML5, Vanilla JavaScript, CSS3
  - Google Cloud Vision API + Tesseract.js (광학 문자 인식 / 폴백)
  - JSZip (이미지 일괄 다운로드)
  - SheetJS (엑셀 내보내기)
- **Backend**: Node.js, Express.js
- **Database**: SQLite (LibSQL / Turso, 미설정 시 로컬 `local.db`)
- **Auth**: JWT (JSON Web Tokens), bcrypt
- **Mail**: Brevo HTTP API (비밀번호 재설정 코드 발송)
- **Deployment**: Render (Web Service Blueprint), GitHub

## 🚀 로컬 실행 방법 (Local Development)

### 1. 패키지 설치
```bash
npm install
```

### 2. 환경 변수 설정
프로젝트 루트에 `.env` 파일을 생성합니다. ([`.env.example`](.env.example) 참고)

> **💡 Tip:** `TURSO_DATABASE_URL`이 비어 있으면 로컬 파일 DB(`local.db`)가 자동 생성되어 클라우드 세팅 없이 즉시 실행·테스트할 수 있습니다.
> 마찬가지로 `GOOGLE_VISION_API_KEY`가 없으면 Tesseract.js 폴백으로, `BREVO_API_KEY`가 없으면 인증 코드 콘솔 출력으로 동작합니다.

```env
# 포트 번호
PORT=10000

# JWT 시크릿 키 (보안을 위해 복잡한 문자열 사용)
JWT_SECRET=my_super_secret_jwt_key

# Turso SQLite 연결 정보 (비워두면 local.db 사용)
TURSO_DATABASE_URL=libsql://[your-db-name].turso.io
TURSO_AUTH_TOKEN=[your-turso-auth-token]

# Google Cloud Vision API (없으면 Tesseract.js로 자동 폴백)
GOOGLE_VISION_API_KEY=

# 비밀번호 재설정 메일 발송용 Brevo (없으면 코드가 서버 콘솔에 출력)
BREVO_API_KEY=
MAIL_FROM=          # Brevo에서 인증한 발신자 이메일과 동일해야 함
MAIL_FROM_NAME=     # 발신자 표시 이름 (선택, 기본값 "경비 전표")
```

### 3. 서버 실행
```bash
npm start
```
서버가 실행되면 브라우저에서 `http://localhost:10000` 으로 접속하여 앱을 이용할 수 있습니다.

> Render의 IPv6 환경(`ENETUNREACH`) 대응을 위해 시작 스크립트에 `--dns-result-order=ipv4first` 옵션이 적용되어 있습니다.

## ☁️ 배포 가이드 (Deployment via Render)

이 프로젝트는 `render.yaml` (Blueprints)를 포함하고 있어 **Render.com**에서 쉽게 자동 배포할 수 있습니다.

1. **Render.com** 대시보드 로그인
2. **Blueprints** 탭 이동 후 **New Blueprint Instance** 클릭
3. 현재 GitHub 레포지토리 연결
4. 배포 과정 중 요구하는 환경변수 입력
   (`JWT_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `GOOGLE_VISION_API_KEY`, `BREVO_API_KEY`, `MAIL_FROM` 등)
5. **Apply** 클릭 시 자동으로 서비스가 빌드되고 배포됩니다.

## 📝 데이터베이스 스키마
- **users**: `id`, `email`, `password_hash`, `created_at`
- **expenses**: `id`, `user_id`, `date`, `account`, `debit`, `credit`, `memo`, `vendor`, `created_at`
- **password_resets**: `email`, `code_hash`, `expires_at`, `attempts` (비밀번호 재설정 인증 코드 관리)
- (영수증 이미지는 DB 과부하를 막기 위해 클라이언트 단의 IndexedDB를 활용하거나 필요시 Blob Storage 확장이 가능하도록 분리 설계되어 있습니다.)

---
**Note:** 이 프로젝트는 사용자의 기기 자원을 효율적으로 사용하기 위해 클라이언트 로컬 저장소와 서버 저장소를 동시에 활용하는 하이브리드 아키텍처를 채택하였습니다.

## 📄 라이선스 (License)

이 프로젝트는 [MIT 라이선스](LICENSE)를 따릅니다.
