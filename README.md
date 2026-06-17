# 영수증 스캔하면 끝! 초간단 전표 정리 (Expense Tracker)

영수증 이미지를 업로드하면 OCR 기술(Tesseract.js)을 이용해 금액, 가맹점, 일자 등을 자동 인식하고, 달력 UI 기반으로 직관적인 전표 관리 및 지출 내역을 관리할 수 있는 하이브리드 가계부 웹 애플리케이션입니다.

## ✨ 주요 기능 (Features)

- **📸 영수증 자동 스캔 (OCR)**
  - Tesseract.js를 활용하여 영수증 이미지에서 날짜, 금액, 사용처(상호명)를 자동으로 추출 및 입력합니다.
  - 다중 이미지 일괄 스캔을 지원합니다.
- **📅 달력 기반 직관적 UI**
  - 달력 형태로 일별 지출 내역 및 합계를 한눈에 파악할 수 있습니다.
  - 깔끔한 다크/라이트 모드 테마를 지원합니다.
- **🔐 로그인 및 데이터 동기화 (Multi-tenancy)**
  - **게스트 모드**: 로그인 없이도 브라우저(`localStorage`, `IndexedDB`)에 데이터를 저장하고 즉시 사용할 수 있습니다.
  - **계정 동기화**: 게스트 상태에서 작성한 모든 전표와 영수증 이미지는 회원가입/로그인 시 사용자 계정 클라우드 DB로 원클릭 동기화됩니다.
  - JWT 기반 인증으로 각 사용자의 데이터는 안전하게 분리 및 보호됩니다.
- **🗑 영수증 이미지 자동 파기 (60일 정책)**
  - 기기 용량 관리를 위해 로컬 브라우저 및 서버에 저장된 영수증 이미지는 60일이 경과하면 자동으로 삭제(파기)됩니다.
- **📥 데이터 내보내기**
  - 등록된 전표 내역을 엑셀(Excel, xlsx) 파일로 월별 혹은 전체 다운로드할 수 있습니다.
  - 첨부했던 영수증 이미지 원본들을 ZIP 파일로 일괄 압축하여 다운로드할 수 있습니다.

## 🛠 기술 스택 (Tech Stack)

- **Frontend**: HTML5, Vanilla JavaScript, CSS3
  - Tesseract.js (광학 문자 인식)
  - JSZip (이미지 일괄 다운로드)
  - SheetJS (엑셀 내보내기)
- **Backend**: Node.js, Express.js
- **Database**: SQLite (LibSQL / Turso)
- **Auth**: JWT (JSON Web Tokens), bcrypt
- **Deployment**: Render (Web Service Blueprint), GitHub

## 🚀 로컬 실행 방법 (Local Development)

### 1. 패키지 설치
```bash
npm install
```

### 2. 환경 변수 설정
프로젝트 루트에 `.env` 파일을 생성하고 아래의 값을 입력합니다. (Turso DB 정보는 [Turso 대시보드](https://turso.tech/)에서 발급)

```env
# 포트 번호
PORT=12345

# Turso SQLite 연결 정보
TURSO_DATABASE_URL=libsql://[your-db-name].turso.io
TURSO_AUTH_TOKEN=[your-turso-auth-token]

# JWT 시크릿 키 (보안을 위해 복잡한 문자열 사용)
JWT_SECRET=my_super_secret_jwt_key
```

### 3. 서버 실행
```bash
npm start
```
서버가 실행되면 브라우저에서 `http://localhost:12345` 로 접속하여 앱을 이용할 수 있습니다.

## ☁️ 배포 가이드 (Deployment via Render)

이 프로젝트는 `render.yaml` (Blueprints)를 포함하고 있어 **Render.com**에서 쉽게 자동 배포할 수 있습니다.

1. **Render.com** 대시보드 로그인
2. **Blueprints** 탭 이동 후 **New Blueprint Instance** 클릭
3. 현재 GitHub 레포지토리 연결
4. 배포 과정 중 요구하는 환경변수(`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `JWT_SECRET`) 입력
5. **Apply** 클릭 시 자동으로 서비스가 빌드되고 배포됩니다.

## 📝 데이터베이스 스키마
- **users**: `id`, `email`, `password_hash`, `created_at`
- **expenses**: `id`, `user_id`, `date`, `account`, `debit`, `credit`, `memo`, `vendor`, `created_at`
- (영수증 이미지는 DB 과부하를 막기 위해 클라이언트 단의 IndexedDB를 활용하거나 필요시 Blob Storage 확장이 가능하도록 분리 설계되어 있습니다.)

---
**Note:** 이 프로젝트는 사용자의 기기 자원을 효율적으로 사용하기 위해 클라이언트 로컬 저장소와 서버 저장소를 동시에 활용하는 하이브리드 아키텍처를 채택하였습니다.
