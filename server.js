import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { createClient } from '@libsql/client';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
// 영수증 원본 이미지 보관 기간(해당 월 종료일 기준). 클라이언트(index.html)의 RETENTION_DAYS와 반드시 동일하게 유지한다.
const RETENTION_DAYS = 90;
// 휴지통 보관 기간. 이 기간이 지난 삭제 전표는 영구 파기된다. 클라이언트의 TRASH_DAYS와 동일하게 유지한다.
const TRASH_DAYS = 30;
// 일괄 요청 1회에 처리할 수 있는 전표 수 상한. 한 달치를 한 번에 담고도 남는다.
const MAX_BULK_IDS = 500;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ 치명적 오류: JWT_SECRET 환경변수가 설정되지 않았습니다. 서버를 종료합니다.');
  process.exit(1);
}

// 비밀번호 해시 비용 (무차별 대입 내성 강화)
const PWD_COST = 12;

// --- 회원정보(PII: 이름/팀) 필드 암호화 (AES-256-GCM) ---
// PII_ENCRYPTION_KEY 환경변수가 있으면 활성화. 어떤 문자열이든 SHA-256으로 32바이트 키로 정규화한다.
// 키가 없으면 기존처럼 평문으로 동작(경고 출력)하며, 레거시 평문 데이터도 그대로 읽힌다.
const PII_KEY = process.env.PII_ENCRYPTION_KEY
  ? crypto.createHash('sha256').update(process.env.PII_ENCRYPTION_KEY).digest()
  : null;
const ENC_PREFIX = 'enc:v1:';
if (!PII_KEY) {
  console.warn('⚠️ PII_ENCRYPTION_KEY 미설정: 이름/팀이 평문으로 저장됩니다. 운영에서는 키 설정을 권장합니다.');
}

function encryptPII(plain) {
  if (!PII_KEY || plain == null || plain === '') return plain == null ? '' : plain;
  if (typeof plain === 'string' && plain.startsWith(ENC_PREFIX)) return plain; // 이미 암호화됨
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PII_KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptPII(stored) {
  if (stored == null || stored === '') return '';
  // 레거시 평문(접두사 없음)은 그대로 반환 → 마이그레이션 없이도 호환
  if (typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) return stored;
  if (!PII_KEY) return '';
  try {
    const raw = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', PII_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('PII 복호화 실패:', e.message);
    return '';
  }
}

// Render 등 리버스 프록시 뒤에서 클라이언트 실제 IP(X-Forwarded-For)를 신뢰 (레이트 리밋용)
app.set('trust proxy', 1);

// --- 보안 헤더 (helmet) ---
// CSP는 앱이 실제 사용하는 출처만 허용하도록 구성한다.
// - 인라인 스크립트/핸들러(27곳) 및 인라인 스타일이 많아 'unsafe-inline' 불가피
// - Tesseract.js(OCR 폴백)가 WASM과 Blob 워커를 사용하므로 wasm-unsafe-eval / blob: 허용
// - XLSX·Tesseract 코어는 cdnjs / jsdelivr, 학습 데이터는 tessdata 에서 로드
const CDN = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'];
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'blob:', ...CDN],
      // 인라인 이벤트 핸들러(onclick 등 27곳) 허용 — helmet 기본값('none')은 이를 차단함
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", ...CDN],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'blob:', 'data:', ...CDN, 'https://tessdata.projectnaptha.com'],
      workerSrc: ["'self'", 'blob:'],
      fontSrc: ["'self'", 'data:', ...CDN],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  // 영수증 이미지를 data:/blob:로 표시하므로 리소스 차단 정책은 완화
  crossOriginEmbedderPolicy: false
}));

// 개별 영수증 이미지(base64 data URL) 최대 허용 길이 (~약 3.7MB 디코딩). 저장공간 고갈 방지.
const MAX_IMAGE_CHARS = 5_000_000;

// JSON 파싱 미들웨어 (이미지 Base64 처리를 위해 10MB로 증가)
app.use(express.json({ limit: '10mb' }));

// --- 레이트 리미팅 (무차별 대입 / 메일 폭탄 방어) ---
// 로그인·회원가입: IP당 15분에 20회
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
});
// 비밀번호 재설정(메일 발송 동반): IP당 1시간에 5회
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
});

// 데이터베이스 설정
const dbUrl = process.env.TURSO_DATABASE_URL || 'file:local.db';
const dbAuthToken = process.env.TURSO_AUTH_TOKEN || '';

const db = createClient({
  url: dbUrl,
  authToken: dbAuthToken
});

// 테이블 초기화
async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try { await db.execute("ALTER TABLE users ADD COLUMN name TEXT"); } catch(e) {}
  // 토큰 무효화용 버전. 비밀번호 변경 시 증가시켜 기존 발급 토큰을 모두 무효화한다.
  try { await db.execute("ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0"); } catch(e) {}
  // team 기능 제거: 기존 DB에 남아있는 team 컬럼 정리 (미지원 버전이면 무시)
  try { await db.execute("ALTER TABLE users DROP COLUMN team"); } catch(e) {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      account TEXT NOT NULL,
      debit INTEGER DEFAULT 0,
      credit INTEGER DEFAULT 0,
      memo TEXT,
      vendor TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // expenses 테이블 생성 이후에 추가 컬럼을 보강 (신규 DB에서도 컬럼이 누락되지 않도록 순서 보장)
  try { await db.execute("ALTER TABLE expenses ADD COLUMN department TEXT"); } catch(e) {}
  try { await db.execute("ALTER TABLE expenses ADD COLUMN employeeName TEXT"); } catch(e) {}
  // 휴지통: 삭제는 즉시 파기가 아니라 시각 기록(soft delete)으로 처리한다. NULL이면 정상 전표.
  try { await db.execute("ALTER TABLE expenses ADD COLUMN deleted_at TEXT"); } catch(e) {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS receipt_images (
      expense_id INTEGER PRIMARY KEY,
      image_data TEXT NOT NULL,
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
    )
  `);

  // 비밀번호 재설정 인증 코드 (이메일당 1건, 재요청 시 덮어씀)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS password_resets (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0
    )
  `);

  console.log('✅ 데이터베이스 테이블 확인 완료');

  // 일회성 마이그레이션: 키가 설정돼 있으면 기존 평문 이름을 암호화한다.
  if (PII_KEY) {
    try {
      const users = await db.execute('SELECT id, name FROM users');
      let migrated = 0;
      for (const u of users.rows) {
        const nameNeedsEnc = (typeof u.name === 'string' && u.name && !u.name.startsWith(ENC_PREFIX));
        if (nameNeedsEnc) {
          await db.execute({
            sql: 'UPDATE users SET name = ? WHERE id = ?',
            args: [encryptPII(u.name || ''), u.id]
          });
          migrated++;
        }
      }
      if (migrated > 0) console.log(`🔐 PII 마이그레이션: 이름 ${migrated}건 암호화 완료`);
    } catch (e) {
      console.error('PII 마이그레이션 실패:', e.message);
    }
  }
}
initDb().then(() => {
  // 시작 시 1회 실행 후 12시간마다 실행
  cleanupServerImages();
  setInterval(cleanupServerImages, 12 * 60 * 60 * 1000);
}).catch(err => {
  console.error('❌ 데이터베이스 초기화 실패:', err);
});

// --- 서버 스토리지 보관기간(RETENTION_DAYS) 경과 자동 삭제 로직 ---
async function cleanupServerImages() {
  try {
    const sql = `
      DELETE FROM receipt_images 
      WHERE expense_id IN (
        SELECT id FROM expenses 
        WHERE date(date, 'start of month', '+1 month', '-1 day', '+${RETENTION_DAYS} days') < date('now')
      )
    `;
    const res = await db.execute(sql);
    if (res.rowsAffected > 0) {
      console.log(`🧹 서버 자동 삭제: ${RETENTION_DAYS}일 경과 영수증 이미지 ${res.rowsAffected}개 삭제 완료`);
    }

    // 휴지통 보관 기간이 지난 전표는 영수증까지 영구 파기한다 (receipt_images는 CASCADE)
    const purged = await db.execute(
      `DELETE FROM expenses WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-${TRASH_DAYS} days')`
    );
    if (purged.rowsAffected > 0) {
      console.log(`🗑️ 휴지통 영구 파기: ${TRASH_DAYS}일 경과 전표 ${purged.rowsAffected}건`);
    }
  } catch (err) {
    console.error('서버 영수증 이미지 자동 정리 실패:', err);
  }
}


// --- 이메일 발송 설정 ---
// Brevo HTTP API(443 포트) 연동. API 키가 없으면 콘솔에 출력(개발/테스트용 폴백)
// HTTP 기반이라 회사망/Render 무료 플랜의 SMTP 포트 차단을 우회하며, 도메인 없이도
// Brevo에서 인증한 발신자 주소로 누구에게나 발송할 수 있습니다.
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM; // Brevo에서 인증한 발신자 이메일
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || '경비 전표';

async function sendResetCodeMail(email, code) {
  const subject = '[경비 전표] 비밀번호 재설정 인증 코드';
  const html = `
    <div style="font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <h2 style="font-size:18px;color:#1d1d1f;">비밀번호 재설정 인증 코드</h2>
      <p style="font-size:14px;color:#6e6e73;">아래 인증 코드를 입력해 비밀번호를 재설정하세요. (유효시간 10분)</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0071e3;text-align:center;padding:20px;background:#f0f0f3;border-radius:12px;margin:16px 0;">${code}</div>
      <p style="font-size:12px;color:#a1a1a6;">본인이 요청하지 않았다면 이 메일을 무시하세요.</p>
    </div>`;

  if (!BREVO_API_KEY || !MAIL_FROM) {
    console.log(`📧 [메일 폴백] ${email} 비밀번호 재설정 인증 코드: ${code} (유효 10분)`);
    return;
  }

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: MAIL_FROM_NAME, email: MAIL_FROM },
      to: [{ email }],
      subject,
      htmlContent: html
    })
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Brevo 발송 실패 (${resp.status}): ${detail}`);
  }
}

// 인증 미들웨어
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: '인증 토큰이 필요합니다.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(403).json({ error: '유효하지 않거나 만료된 토큰입니다.' });
  }

  // 토큰 무효화 검사: 비밀번호 변경/탈퇴 시 token_version이 올라가 기존 토큰이 무효화된다.
  db.execute({ sql: 'SELECT token_version FROM users WHERE id = ?', args: [payload.id] })
    .then(result => {
      if (result.rows.length === 0) {
        return res.status(403).json({ error: '유효하지 않은 토큰입니다.' });
      }
      const currentTv = Number(result.rows[0].token_version || 0);
      if (Number(payload.tv || 0) !== currentTv) {
        return res.status(403).json({ error: '세션이 만료되었습니다. 다시 로그인해주세요.' });
      }
      req.user = payload;
      next();
    })
    .catch(err => {
      console.error('Auth check error:', err);
      return res.status(500).json({ error: '인증 처리 중 오류가 발생했습니다.' });
    });
}

// --- 인증 API ---

// 회원가입
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
  }
  const pwdRegex = /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
  if (!pwdRegex.test(password)) {
    return res.status(400).json({ error: '비밀번호는 영문, 숫자, 특수문자를 포함해 최소 8자 이상이어야 합니다.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, PWD_COST);
    await db.execute({
      sql: 'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)',
      args: [email, passwordHash, encryptPII(name || '')]
    });
    res.status(201).json({ message: '회원가입이 완료되었습니다.' });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: '이미 사용 중인 이메일입니다.' });
    }
    console.error(err);
    res.status(500).json({ error: '회원가입 중 오류가 발생했습니다.' });
  }
});

// 로그인
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
  }

  try {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [email]
    });

    if (result.rows.length === 0) {
      return res.status(400).json({ error: '이메일 또는 비밀번호가 잘못되었습니다.' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(400).json({ error: '이메일 또는 비밀번호가 잘못되었습니다.' });
    }

    const name = decryptPII(user.name);
    const token = jwt.sign({ id: user.id, email: user.email, name, tv: Number(user.token_version || 0) }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: user.email, name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '로그인 중 오류가 발생했습니다.' });
  }
});

// 비밀번호 재설정 - 인증 코드 요청
app.post('/api/auth/forgot-password', passwordResetLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: '이메일 주소를 올바르게 입력해주세요.' });
  }

  try {
    const userResult = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [email]
    });

    if (userResult.rows.length > 0) {
      // Node 구버전 호환성을 위해 Math.random 사용 (보안상 매우 중요한 키가 아니므로 무방)
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeHash = await bcrypt.hash(code, 10);
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10분

      try {
        await db.execute({
          sql: `INSERT INTO password_resets (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
                ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
          args: [email, codeHash, expiresAt]
        });
      } catch (dbErr) {
        console.error('DB Error:', dbErr);
        return res.status(500).json({ error: '인증 코드 처리 중 오류가 발생했습니다.' });
      }

      try {
        await sendResetCodeMail(email, code);
      } catch (mailErr) {
        console.error('Mail Error:', mailErr);
        return res.status(500).json({ error: '이메일 발송 중 오류가 발생했습니다.' });
      }
    }

    res.json({ message: '가입된 이메일이라면 인증 코드를 보내드렸습니다. 메일함을 확인해주세요.' });
  } catch (err) {
    console.error('General Error:', err);
    res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
  }
});

// 비밀번호 재설정 - 코드 검증 및 새 비밀번호 설정
app.post('/api/auth/reset-password', passwordResetLimiter, async (req, res) => {
  const { email, code, password } = req.body;
  if (!email || !code || !password) {
    return res.status(400).json({ error: '이메일, 인증 코드, 새 비밀번호를 모두 입력해주세요.' });
  }
  const pwdRegex = /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
  if (!pwdRegex.test(password)) {
    return res.status(400).json({ error: '비밀번호는 영문, 숫자, 특수문자를 포함해 최소 8자 이상이어야 합니다.' });
  }

  try {
    const result = await db.execute({
      sql: 'SELECT code_hash, expires_at, attempts FROM password_resets WHERE email = ?',
      args: [email]
    });

    if (result.rows.length === 0) {
      return res.status(400).json({ error: '인증 코드를 먼저 요청해주세요.' });
    }

    const row = result.rows[0];
    if (Number(row.expires_at) < Date.now()) {
      await db.execute({ sql: 'DELETE FROM password_resets WHERE email = ?', args: [email] });
      return res.status(400).json({ error: '인증 코드가 만료되었습니다. 다시 요청해주세요.' });
    }
    if (Number(row.attempts) >= 5) {
      await db.execute({ sql: 'DELETE FROM password_resets WHERE email = ?', args: [email] });
      return res.status(400).json({ error: '인증 시도 횟수를 초과했습니다. 코드를 다시 요청해주세요.' });
    }

    const validCode = await bcrypt.compare(String(code), row.code_hash);
    if (!validCode) {
      await db.execute({
        sql: 'UPDATE password_resets SET attempts = attempts + 1 WHERE email = ?',
        args: [email]
      });
      return res.status(400).json({ error: '인증 코드가 일치하지 않습니다.' });
    }

    const passwordHash = await bcrypt.hash(password, PWD_COST);
    // 비밀번호 변경 시 token_version을 올려 기존에 발급된 모든 토큰을 무효화한다.
    await db.execute({
      sql: 'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE email = ?',
      args: [passwordHash, email]
    });
    await db.execute({ sql: 'DELETE FROM password_resets WHERE email = ?', args: [email] });

    res.json({ message: '비밀번호가 변경되었습니다. 새 비밀번호로 로그인해주세요.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '비밀번호 변경 중 오류가 발생했습니다.' });
  }
});

// 회원 탈퇴
app.delete('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'DELETE FROM users WHERE id = ?',
      args: [req.user.id]
    });
    
    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }
    
    res.json({ message: '회원 탈퇴가 완료되었습니다.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '회원 탈퇴 중 오류가 발생했습니다.' });
  }
});

// 프로필 수정
app.put('/api/auth/profile', authenticateToken, async (req, res) => {
  const { name } = req.body;
  try {
    await db.execute({
      sql: 'UPDATE users SET name = ? WHERE id = ?',
      args: [encryptPII(name || ''), req.user.id]
    });
    const token = jwt.sign({ id: req.user.id, email: req.user.email, name: name || '', tv: Number(req.user.tv || 0) }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, name: name || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '프로필 수정 중 오류가 발생했습니다.' });
  }
});

// --- 지출 데이터 API ---

// 지출 내역 전체 조회
app.get('/api/expenses', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT id, date, account, debit, credit, memo, vendor, department, employeeName FROM expenses WHERE user_id = ? AND deleted_at IS NULL ORDER BY date ASC, id ASC',
      args: [req.user.id]
    });
    const list = result.rows.map(row => ({
      id: row.id,
      date: row.date,
      account: row.account,
      debit: Number(row.debit || 0),
      credit: Number(row.credit || 0),
      memo: row.memo || '',
      vendor: row.vendor || '',
      department: row.department || '',
      employeeName: row.employeeName || ''
    }));
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '조회 중 오류가 발생했습니다.' });
  }
});

// 지출 내역 추가
app.post('/api/expenses', authenticateToken, async (req, res) => {
  const { date, account, debit, credit, memo, vendor, department, employeeName } = req.body;
  if (!date || !account || memo === undefined) {
    return res.status(400).json({ error: '필수 항목이 누락되었습니다.' });
  }

  try {
    const result = await db.execute({
      sql: 'INSERT INTO expenses (user_id, date, account, debit, credit, memo, vendor, department, employeeName) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [req.user.id, date, account, debit || 0, credit || 0, memo, vendor || '', department || '', employeeName || '']
    });
    const newId = Number(result.lastInsertRowid);
    res.status(201).json({ id: newId, date, account, debit, credit, memo, vendor, department, employeeName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '추가 중 오류가 발생했습니다.' });
  }
});

// 지출 내역 수정
app.put('/api/expenses/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { date, account, debit, credit, memo, vendor, department, employeeName } = req.body;

  try {
    const check = await db.execute({
      sql: 'SELECT id FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      args: [id, req.user.id]
    });
    if (check.rows.length === 0) {
      return res.status(404).json({ error: '해당 지출 내역을 찾을 수 없거나 권한이 없습니다.' });
    }

    await db.execute({
      sql: 'UPDATE expenses SET date = ?, account = ?, debit = ?, credit = ?, memo = ?, vendor = ?, department = ?, employeeName = ? WHERE id = ? AND user_id = ?',
      args: [date, account, debit || 0, credit || 0, memo, vendor || '', department || '', employeeName || '', id, req.user.id]
    });
    res.json({ id: Number(id), date, account, debit, credit, memo, vendor, department, employeeName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '수정 중 오류가 발생했습니다.' });
  }
});

// 휴지통 조회 (:id 라우트보다 먼저 선언해 경로가 가로채이지 않게 한다)
app.get('/api/expenses/trash', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT id, date, account, debit, credit, memo, vendor, department, employeeName, deleted_at
            FROM expenses WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
      args: [req.user.id]
    });
    res.json(result.rows.map(row => ({
      id: row.id,
      date: row.date,
      account: row.account,
      debit: Number(row.debit || 0),
      credit: Number(row.credit || 0),
      memo: row.memo || '',
      vendor: row.vendor || '',
      department: row.department || '',
      employeeName: row.employeeName || '',
      deletedAt: row.deleted_at
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '휴지통 조회 중 오류가 발생했습니다.' });
  }
});

// 일괄 처리 공용 헬퍼. 건당 왕복하던 것을 요청 1회로 줄인다.
// id 배열을 그대로 SQL에 넣지 않고 플레이스홀더로 바인딩한다.
function parseBulkIds(body) {
  const ids = body && body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return { error: '처리할 전표 id 목록이 필요합니다.' };
  if (ids.length > MAX_BULK_IDS) return { error: `한 번에 최대 ${MAX_BULK_IDS}건까지 처리할 수 있습니다.` };
  const nums = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (nums.length !== ids.length) return { error: '유효하지 않은 전표 id가 포함되어 있습니다.' };
  return { ids: nums };
}

// 일괄 삭제 (휴지통으로 이동)
app.post('/api/expenses/bulk-delete', authenticateToken, async (req, res) => {
  const parsed = parseBulkIds(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    const holes = parsed.ids.map(() => '?').join(',');
    const result = await db.execute({
      sql: `UPDATE expenses SET deleted_at = datetime('now')
            WHERE user_id = ? AND deleted_at IS NULL AND id IN (${holes})`,
      args: [req.user.id, ...parsed.ids]
    });
    res.json({ success: true, affected: result.rowsAffected });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '삭제 중 오류가 발생했습니다.' });
  }
});

// 일괄 복원
app.post('/api/expenses/bulk-restore', authenticateToken, async (req, res) => {
  const parsed = parseBulkIds(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    const holes = parsed.ids.map(() => '?').join(',');
    await db.execute({
      sql: `UPDATE expenses SET deleted_at = NULL
            WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${holes})`,
      args: [req.user.id, ...parsed.ids]
    });
    // 복원된 전표를 그대로 돌려줘 클라이언트가 재조회 없이 목록에 넣을 수 있게 한다.
    const rows = await db.execute({
      sql: `SELECT id, date, account, debit, credit, memo, vendor, department, employeeName
            FROM expenses WHERE user_id = ? AND deleted_at IS NULL AND id IN (${holes})`,
      args: [req.user.id, ...parsed.ids]
    });
    res.json({
      success: true,
      restored: rows.rows.map(e => ({
        id: e.id, date: e.date, account: e.account,
        debit: Number(e.debit || 0), credit: Number(e.credit || 0),
        memo: e.memo || '', vendor: e.vendor || '',
        department: e.department || '', employeeName: e.employeeName || ''
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '복원 중 오류가 발생했습니다.' });
  }
});

// 일괄 영구 삭제 (휴지통에 있는 것만)
app.post('/api/expenses/bulk-purge', authenticateToken, async (req, res) => {
  const parsed = parseBulkIds(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    const holes = parsed.ids.map(() => '?').join(',');
    const result = await db.execute({
      sql: `DELETE FROM expenses WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${holes})`,
      args: [req.user.id, ...parsed.ids]
    });
    res.json({ success: true, affected: result.rowsAffected });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '영구 삭제 중 오류가 발생했습니다.' });
  }
});

// 지출 내역 삭제 — 즉시 파기하지 않고 휴지통으로 보낸다(soft delete)
app.delete('/api/expenses/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.execute({
      sql: "UPDATE expenses SET deleted_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
      args: [id, req.user.id]
    });
    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: '해당 지출 내역을 찾을 수 없거나 권한이 없습니다.' });
    }
    res.json({ success: true, trashed: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '삭제 중 오류가 발생했습니다.' });
  }
});

// 휴지통에서 복원 — id와 영수증이 그대로 남아 있어 원래 상태로 되돌아간다
app.post('/api/expenses/:id/restore', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.execute({
      sql: 'UPDATE expenses SET deleted_at = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL',
      args: [id, req.user.id]
    });
    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: '복원할 전표를 찾을 수 없습니다. 보관 기간이 지나 파기되었을 수 있습니다.' });
    }
    const row = await db.execute({
      sql: 'SELECT id, date, account, debit, credit, memo, vendor, department, employeeName FROM expenses WHERE id = ? AND user_id = ?',
      args: [id, req.user.id]
    });
    const e = row.rows[0];
    res.json({
      id: e.id, date: e.date, account: e.account,
      debit: Number(e.debit || 0), credit: Number(e.credit || 0),
      memo: e.memo || '', vendor: e.vendor || '',
      department: e.department || '', employeeName: e.employeeName || ''
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '복원 중 오류가 발생했습니다.' });
  }
});

// 휴지통에서 영구 삭제 (단건, 또는 body.all=true 로 비우기)
app.delete('/api/expenses/:id/purge', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.execute({
      sql: 'DELETE FROM expenses WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL',
      args: [id, req.user.id]
    });
    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: '해당 전표를 찾을 수 없습니다.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '영구 삭제 중 오류가 발생했습니다.' });
  }
});

// 지출 내역 일괄 동기화 (게스트 모드 -> 회원 모드)
app.post('/api/expenses/sync', authenticateToken, async (req, res) => {
  const { expenses } = req.body;
  if (!Array.isArray(expenses) || expenses.length === 0) {
    return res.status(400).json({ error: '동기화할 지출 내역이 유효하지 않습니다.' });
  }

  try {
    const syncedItems = [];
    for (const exp of expenses) {
      const result = await db.execute({
        sql: 'INSERT INTO expenses (user_id, date, account, debit, credit, memo, vendor, department, employeeName) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [
          req.user.id,
          exp.date,
          exp.account,
          exp.debit || 0,
          exp.credit || 0,
          exp.memo || '',
          exp.vendor || '',
          exp.department || '',
          exp.employeeName || ''
        ]
      });
      const newId = Number(result.lastInsertRowid);
      syncedItems.push({
        id: newId,
        date: exp.date,
        account: exp.account,
        debit: exp.debit || 0,
        credit: exp.credit || 0,
        memo: exp.memo || '',
        vendor: exp.vendor || '',
        department: exp.department || '',
        employeeName: exp.employeeName || ''
      });
      
      // 용량 초과 이미지는 건너뛴다 (전표 본문은 정상 동기화)
      if (exp.dataUrl && typeof exp.dataUrl === 'string' && exp.dataUrl.length <= MAX_IMAGE_CHARS) {
        await db.execute({
          sql: `INSERT INTO receipt_images (expense_id, image_data) VALUES (?, ?)
                ON CONFLICT(expense_id) DO UPDATE SET image_data = excluded.image_data`,
          args: [newId, exp.dataUrl]
        });
      }
    }
    res.json({ message: '동기화 완료', syncedItems });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '동기화 중 오류가 발생했습니다.' });
  }
});

// 이미지 업로드/수정
app.post('/api/expenses/:id/image', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { dataUrl } = req.body;
  if (!dataUrl) return res.status(400).json({ error: '이미지 데이터가 없습니다.' });
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_IMAGE_CHARS) {
    return res.status(413).json({ error: '이미지 용량이 너무 큽니다. 더 작은 파일을 사용해주세요.' });
  }

  try {
    const check = await db.execute({
      sql: 'SELECT id FROM expenses WHERE id = ? AND user_id = ?',
      args: [id, req.user.id]
    });
    if (check.rows.length === 0) return res.status(404).json({ error: '해당 지출 내역을 찾을 수 없거나 권한이 없습니다.' });

    await db.execute({
      sql: `INSERT INTO receipt_images (expense_id, image_data) VALUES (?, ?)
            ON CONFLICT(expense_id) DO UPDATE SET image_data = excluded.image_data`,
      args: [id, dataUrl]
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '이미지 저장 중 오류가 발생했습니다.' });
  }
});

// 이미지 조회
app.get('/api/expenses/:id/image', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const check = await db.execute({
      sql: 'SELECT id FROM expenses WHERE id = ? AND user_id = ?',
      args: [id, req.user.id]
    });
    if (check.rows.length === 0) return res.status(404).json({ error: '해당 지출 내역을 찾을 수 없거나 권한이 없습니다.' });

    const result = await db.execute({
      sql: 'SELECT image_data FROM receipt_images WHERE expense_id = ?',
      args: [id]
    });
    if (result.rows.length === 0) return res.json({ dataUrl: null });
    
    res.json({ dataUrl: result.rows[0].image_data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '이미지 조회 중 오류가 발생했습니다.' });
  }
});
// --- Google Cloud Vision API OCR 프록시 ---
// POST /api/ocr
// body: { imageBase64: "data:image/jpeg;base64,..." }
// response: { text: "인식된 텍스트" } or { fallback: true }
app.post('/api/ocr', authenticateToken, async (req, res) => {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;

  // API 키 미설정 시 클라이언트가 Tesseract.js로 폴백하도록 안내
  if (!apiKey) {
    return res.json({ fallback: true, reason: 'GOOGLE_VISION_API_KEY가 설정되지 않았습니다.' });
  }

  const { imageBase64 } = req.body;
  if (!imageBase64) {
    return res.status(400).json({ error: '이미지 데이터가 없습니다.' });
  }
  if (typeof imageBase64 !== 'string' || imageBase64.length > MAX_IMAGE_CHARS) {
    return res.status(413).json({ error: '이미지 용량이 너무 큽니다.' });
  }

  try {
    // data URL에서 순수 base64 부분만 추출
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const requestBody = JSON.stringify({
      requests: [
        {
          image: { content: base64Data },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          imageContext: { languageHints: ['ko', 'en'] }
        }
      ]
    });

    // Google Cloud Vision REST API 호출
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Google Vision API 오류 (${response.status}):`, errText);
      return res.json({ fallback: true, reason: `API 오류: ${response.status}` });
    }

    const data = await response.json();

    // 응답에서 텍스트 추출
    const annotation = data.responses?.[0];
    if (annotation?.error) {
      console.error('Google Vision 인식 실패:', annotation.error.message);
      return res.json({ fallback: true, reason: annotation.error.message });
    }

    const text = annotation?.fullTextAnnotation?.text || '';
    if (!text) {
      return res.json({ fallback: true, reason: '텍스트를 인식하지 못했습니다.' });
    }

    console.log(`✅ Google Vision OCR 성공 - 인식 글자 수: ${text.length}`);
    return res.json({ text });

  } catch (err) {
    console.error('Google Vision OCR 처리 중 오류:', err);
    return res.json({ fallback: true, reason: err.message });
  }
});

// 서비스워커는 스코프가 '/'가 되도록 루트에서 서빙한다.
// 캐시를 막아야 새 버전이 즉시 반영된다(서비스워커가 옛 버전에 갇히면 배포가 먹히지 않는다).
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

// 정적 파일 서빙: 프로젝트 루트 전체를 노출하지 않도록 특정 파일들만 명시적으로 서빙한다.
// iOS Safari는 <link>와 별개로 루트의 /apple-touch-icon.png(및 -precomposed)를 관례적으로 직접 요청한다.
// 목록에서 빠지면 catch-all이 index.html(HTML)을 이미지로 응답 → iOS 디코딩 실패 → 홈 화면 아이콘 미표시.
const staticFiles = ['/app.js', '/styles.css', '/favicon.jpg', '/app-icon.png', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/icon-192.png', '/icon-512.png', '/manifest.json'];
staticFiles.forEach(file => {
  app.get(file, (req, res) => res.sendFile(path.join(__dirname, file)));
});

// API 경로는 catch-all보다 먼저 404 JSON으로 끊는다.
// 그렇지 않으면 /api 오타가 index.html(HTML 200)로 응답돼 클라이언트 버그를 찾기 어렵다.
app.use('/api', (req, res) => {
  res.status(404).json({ error: '존재하지 않는 API 경로입니다.' });
});

// 이렇게 하면 server.js / local.db / package.json 등 민감 파일이 정적으로 다운로드되는 것을 막는다.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ 경비 전표 서버 실행 → http://localhost:${PORT}`);
});
