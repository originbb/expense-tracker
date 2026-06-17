# 경비 전표 장부 + 영수증 자동 입력

애플 스타일의 회사 경비 전표 가계부. 영수증 사진을 찍거나 첨부하면 Claude 비전 API가 날짜·금액·사용처·계정과목을 자동 추출해 입력 폼을 채운다.

## 구조
- `index.html` — 정적 페이지 (캘린더·전표 리스트·입력 모달·엑셀 내보내기). 데이터는 브라우저 localStorage(`expense_ledger_v4`)에 저장.
- `api/extract-receipt.js` — Vercel 서버리스 함수. 영수증 이미지를 Claude(`claude-haiku-4-5`)로 보내 구조화 추출. **API 키는 이 서버에만 존재**한다.

## 보안 모델
- `ANTHROPIC_API_KEY` 는 서버 환경변수에만 두고 브라우저에 노출하지 않는다(프록시 구조).
- 공개 프록시 남용 방지를 위해 `ACCESS_PASSWORD` 로 보호한다. 앱 첫 사용 시 비밀번호를 한 번 입력하면 localStorage(`expense_proxy_pw`)에 저장되고 매 요청 헤더(`x-access-password`)로 전송된다.
- 첨부 이미지는 추출 목적으로 프록시 → Anthropic 으로 전송된다.

## 환경변수
| 이름 | 설명 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 키 (서버 전용) |
| `ACCESS_PASSWORD` | 앱 접근 비밀번호 (사용자가 앱에서 입력) |

## 로컬 실행
```bash
npm i -g vercel          # 최초 1회
cd /Users/artwool/dev/expense-tracker
vercel link              # 프로젝트 연결
vercel env add ANTHROPIC_API_KEY    # Production/Preview/Development 모두
vercel env add ACCESS_PASSWORD
vercel env pull          # .env.local 로 내려받기
vercel dev               # http://localhost:3000
```
`vercel dev` 는 정적 페이지와 `/api/*` 함수를 함께 띄운다. localhost 는 보안 컨텍스트라 카메라 촬영도 동작한다.

## 배포
```bash
vercel deploy            # preview
vercel deploy --prod     # production
```
배포 후 휴대폰으로 접속하면 `capture` 속성으로 카메라 촬영 입력이 가능하다(HTTPS).

## 사용 흐름
1. 캘린더에서 + 또는 날짜 클릭 → 입력 모달
2. **📷 영수증으로 채우기** → 사진 촬영/첨부
3. 자동 채워진 날짜·금액·사용처·계정과목 검토 후 **전표 추가**
4. 비밀번호 변경/삭제는 모달 우측 상단 ⚙

## 영수증 인식 동작
- 클라이언트가 이미지를 최대 1600px JPEG로 축소해 업로드(용량·토큰 절감, Vercel 함수 본문 한도 대비).
- 함수가 강제 도구 호출(`record_receipt`)로 `{date, amount, vendor, memo, account}` 구조화 출력을 받는다.
- 추출 단위는 영수증 1장 = 전표 1건(합계 기준).
# expense-tracker
