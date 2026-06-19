import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createClient } from '@libsql/client';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'local-jwt-secret-key-1234567890';

// JSON 파싱 미들웨어 (이미지 Base64 처리를 위해 10MB로 증가)
app.use(express.json({ limit: '10mb' }));

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
      team TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try { await db.execute("ALTER TABLE users ADD COLUMN name TEXT"); } catch(e) {}
  try { await db.execute("ALTER TABLE users ADD COLUMN team TEXT"); } catch(e) {}
  try { await db.execute("ALTER TABLE expenses ADD COLUMN department TEXT"); } catch(e) {}
  try { await db.execute("ALTER TABLE expenses ADD COLUMN employeeName TEXT"); } catch(e) {}

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
}
initDb().then(() => {
  // 시작 시 1회 실행 후 12시간마다 실행
  cleanupServerImages();
  setInterval(cleanupServerImages, 12 * 60 * 60 * 1000);
}).catch(err => {
  console.error('❌ 데이터베이스 초기화 실패:', err);
});

// --- 서버 스토리지 60일 경과 자동 삭제 로직 ---
async function cleanupServerImages() {
  try {
    const sql = `
      DELETE FROM receipt_images 
      WHERE expense_id IN (
        SELECT id FROM expenses 
        WHERE date(date, 'start of month', '+1 month', '-1 day', '+60 days') < date('now')
      )
    `;
    const res = await db.execute(sql);
    if (res.rowsAffected > 0) {
      console.log(`🧹 서버 자동 삭제: 60일 경과 영수증 이미지 ${res.rowsAffected}개 삭제 완료`);
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

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: '유효하지 않거나 만료된 토큰입니다.' });
    }
    req.user = user;
    next();
  });
}

// --- 인증 API ---

// 회원가입
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, team } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
  }
  const pwdRegex = /^(?=.*[a-zA-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
  if (!pwdRegex.test(password)) {
    return res.status(400).json({ error: '비밀번호는 영문, 숫자, 특수문자를 포함해 최소 8자 이상이어야 합니다.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.execute({
      sql: 'INSERT INTO users (email, password_hash, name, team) VALUES (?, ?, ?, ?)',
      args: [email, passwordHash, name || '', team || '']
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
app.post('/api/auth/login', async (req, res) => {
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

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, team: user.team }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, email: user.email, name: user.name, team: user.team });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '로그인 중 오류가 발생했습니다.' });
  }
});

// 비밀번호 재설정 - 인증 코드 요청
app.post('/api/auth/forgot-password', async (req, res) => {
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
        return res.status(500).json({ error: 'DB에 인증 코드를 저장하는 중 오류 발생: ' + (dbErr.message || dbErr) });
      }

      try {
        await sendResetCodeMail(email, code);
      } catch (mailErr) {
        console.error('Mail Error:', mailErr);
        return res.status(500).json({ error: '이메일 발송 실패 (SMTP 설정 확인 필요): ' + (mailErr.message || mailErr) });
      }
    }

    res.json({ message: '가입된 이메일이라면 인증 코드를 보내드렸습니다. 메일함을 확인해주세요.' });
  } catch (err) {
    console.error('General Error:', err);
    res.status(500).json({ error: '서버 내부 오류: ' + (err.message || err) });
  }
});

// 비밀번호 재설정 - 코드 검증 및 새 비밀번호 설정
app.post('/api/auth/reset-password', async (req, res) => {
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

    const passwordHash = await bcrypt.hash(password, 10);
    await db.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE email = ?',
      args: [passwordHash, email]
    });
    await db.execute({ sql: 'DELETE FROM password_resets WHERE email = ?', args: [email] });

    res.json({ message: '비밀번호가 변경되었습니다. 새 비밀번호로 로그인해주세요.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '비밀번호 변경 중 오류: ' + (err.message || err) });
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
  const { name, team } = req.body;
  try {
    await db.execute({
      sql: 'UPDATE users SET name = ?, team = ? WHERE id = ?',
      args: [name || '', team || '', req.user.id]
    });
    const token = jwt.sign({ id: req.user.id, email: req.user.email, name: name || '', team: team || '' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, name: name || '', team: team || '' });
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
      sql: 'SELECT id, date, account, debit, credit, memo, vendor, department, employeeName FROM expenses WHERE user_id = ? ORDER BY date ASC, id ASC',
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
      sql: 'SELECT id FROM expenses WHERE id = ? AND user_id = ?',
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

// 지출 내역 삭제
app.delete('/api/expenses/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.execute({
      sql: 'DELETE FROM expenses WHERE id = ? AND user_id = ?',
      args: [id, req.user.id]
    });
    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: '해당 지출 내역을 찾을 수 없거나 권한이 없습니다.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '삭제 중 오류가 발생했습니다.' });
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
      
      if (exp.dataUrl) {
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
app.post('/api/ocr', async (req, res) => {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;

  // API 키 미설정 시 클라이언트가 Tesseract.js로 폴백하도록 안내
  if (!apiKey) {
    return res.json({ fallback: true, reason: 'GOOGLE_VISION_API_KEY가 설정되지 않았습니다.' });
  }

  const { imageBase64 } = req.body;
  if (!imageBase64) {
    return res.status(400).json({ error: '이미지 데이터가 없습니다.' });
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

// 정적 파일 서빙 (index.html 등)
app.use(express.static(__dirname, {
  index: 'index.html',
  extensions: ['html'],
}));

// 404 및 SPA 라우팅 지원: 존재하지 않는 경로로 접근 시 index.html 반환
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ 경비 전표 서버 실행 → http://localhost:${PORT}`);
});
