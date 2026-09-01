/* 전표 API 스모크 테스트.
 *
 * 실행: npm test
 *
 * 삭제가 soft delete(휴지통)로 바뀌면서 "목록 조회에서 deleted_at을 걸러야 한다"는
 * 암묵적 규칙이 생겼다. 이런 조건은 나중에 쿼리를 손볼 때 조용히 빠지기 쉽고,
 * 그러면 삭제한 전표가 목록에 되살아나도 아무도 모른다. 그 회귀를 잡는 것이 목적이다.
 *
 * 실제 서버 프로세스를 임시 SQLite 파일로 띄워 HTTP로 검증한다.
 * 운영 DB(TURSO_DATABASE_URL)는 환경변수를 덮어써서 절대 건드리지 않는다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rm } from 'node:fs/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = join(ROOT, 'test-api.db');

let server, BASE, token, otherToken;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// 서버는 initDb()를 기다리지 않고 listen하므로, 테이블 준비 로그까지 확인해야
// 첫 요청이 "no such table"로 실패하지 않는다.
function waitForReady(proc) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('서버 기동 시간 초과:\n' + out)), 15000);
    const onData = (buf) => {
      out += buf.toString();
      if (out.includes('데이터베이스 테이블 확인 완료') && out.includes('경비 전표 서버 실행')) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`서버가 코드 ${code}로 종료됨:\n` + out)));
  });
}

async function api(path, { method = 'GET', body, auth } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) headers['Authorization'] = `Bearer ${auth}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML 등 JSON이 아닌 응답 */ }
  return { status: res.status, json, text };
}

const newExpense = (over = {}) => ({
  date: '2026-08-14', account: '(판)복리후생비', debit: 9000, credit: 0,
  memo: '점심', vendor: '김밥천국', department: '개발', employeeName: '테스터', ...over
});

before(async () => {
  await rm(DB_FILE, { force: true });
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), TURSO_DATABASE_URL: `file:${DB_FILE}`, TURSO_AUTH_TOKEN: '', JWT_SECRET: 'test-secret-for-api-tests' }
  });
  await waitForReady(server);

  // 레이트 리밋(IP당 15분 20회)에 걸리지 않도록 인증 호출은 최소로 유지한다.
  const cred = { email: 'api-test@example.local', password: 'Test1234!@', name: '테스터' };
  assert.equal((await api('/api/auth/register', { method: 'POST', body: cred })).status, 201);
  const login = await api('/api/auth/login', { method: 'POST', body: { email: cred.email, password: cred.password } });
  assert.equal(login.status, 200);
  token = login.json.token;

  const other = { email: 'api-other@example.local', password: 'Test1234!@', name: '남' };
  await api('/api/auth/register', { method: 'POST', body: other });
  const otherLogin = await api('/api/auth/login', { method: 'POST', body: { email: other.email, password: other.password } });
  otherToken = otherLogin.json.token;
});

after(async () => {
  if (server) server.kill();
  await rm(DB_FILE, { force: true });
  await rm(DB_FILE + '-journal', { force: true });
  await rm(DB_FILE + '-wal', { force: true });
  await rm(DB_FILE + '-shm', { force: true });
});

test('인증 없이는 전표 API에 접근할 수 없다', async () => {
  for (const [path, method] of [['/api/expenses', 'GET'], ['/api/expenses/trash', 'GET'], ['/api/expenses/bulk-delete', 'POST']]) {
    const res = await api(path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('전표를 만들고 목록에서 조회한다', async () => {
  const created = await api('/api/expenses', { method: 'POST', body: newExpense(), auth: token });
  assert.equal(created.status, 201);
  assert.ok(created.json.id);

  const list = await api('/api/expenses', { auth: token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map(e => e.id), [created.json.id]);
  assert.equal(list.json[0].memo, '점심');
});

test('삭제하면 목록에서 빠지고 휴지통에 남는다', async () => {
  const { json: e } = await api('/api/expenses', { method: 'POST', body: newExpense({ memo: '삭제대상' }), auth: token });
  await api(`/api/expenses/${e.id}/image`, { method: 'POST', body: { dataUrl: 'data:image/jpeg;base64,AAAA' }, auth: token });

  assert.equal((await api(`/api/expenses/${e.id}`, { method: 'DELETE', auth: token })).status, 200);

  const list = await api('/api/expenses', { auth: token });
  assert.ok(!list.json.some(x => x.id === e.id), '삭제한 전표가 목록에 남아 있다');

  const trash = await api('/api/expenses/trash', { auth: token });
  const item = trash.json.find(x => x.id === e.id);
  assert.ok(item, '삭제한 전표가 휴지통에 없다');
  assert.ok(item.deletedAt, 'deletedAt이 기록되지 않았다');

  // 휴지통에 있는 동안에도 영수증은 보존되어야 복원이 의미가 있다.
  const img = await api(`/api/expenses/${e.id}/image`, { auth: token });
  assert.equal(img.status, 200);
  assert.equal(img.json.dataUrl, 'data:image/jpeg;base64,AAAA');
});

test('복원하면 id와 영수증이 그대로 돌아온다', async () => {
  const { json: e } = await api('/api/expenses', { method: 'POST', body: newExpense({ memo: '복원대상' }), auth: token });
  await api(`/api/expenses/${e.id}/image`, { method: 'POST', body: { dataUrl: 'data:image/jpeg;base64,BBBB' }, auth: token });
  await api(`/api/expenses/${e.id}`, { method: 'DELETE', auth: token });

  const restored = await api(`/api/expenses/${e.id}/restore`, { method: 'POST', auth: token });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.id, e.id, '복원 시 id가 바뀌었다');
  assert.equal(restored.json.memo, '복원대상');

  const list = await api('/api/expenses', { auth: token });
  assert.ok(list.json.some(x => x.id === e.id));
  assert.ok(!(await api('/api/expenses/trash', { auth: token })).json.some(x => x.id === e.id));

  const img = await api(`/api/expenses/${e.id}/image`, { auth: token });
  assert.equal(img.json.dataUrl, 'data:image/jpeg;base64,BBBB');
});

test('영구 삭제하면 휴지통에서도 사라지고 복원할 수 없다', async () => {
  const { json: e } = await api('/api/expenses', { method: 'POST', body: newExpense({ memo: '파기대상' }), auth: token });
  await api(`/api/expenses/${e.id}`, { method: 'DELETE', auth: token });

  assert.equal((await api(`/api/expenses/${e.id}/purge`, { method: 'DELETE', auth: token })).status, 200);
  assert.ok(!(await api('/api/expenses/trash', { auth: token })).json.some(x => x.id === e.id));
  assert.equal((await api(`/api/expenses/${e.id}/restore`, { method: 'POST', auth: token })).status, 404);
});

test('일괄 삭제·복원·영구삭제가 요청 한 번으로 처리된다', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const { json } = await api('/api/expenses', { method: 'POST', body: newExpense({ memo: `일괄${i}` }), auth: token });
    ids.push(json.id);
  }

  const del = await api('/api/expenses/bulk-delete', { method: 'POST', body: { ids }, auth: token });
  assert.equal(del.status, 200);
  assert.equal(del.json.affected, 3);
  const afterDelete = await api('/api/expenses', { auth: token });
  assert.ok(!afterDelete.json.some(x => ids.includes(x.id)));

  const restore = await api('/api/expenses/bulk-restore', { method: 'POST', body: { ids }, auth: token });
  assert.equal(restore.status, 200);
  assert.deepEqual(restore.json.restored.map(e => e.id).sort(), [...ids].sort(), '복원된 전표가 요청과 다르다');

  await api('/api/expenses/bulk-delete', { method: 'POST', body: { ids }, auth: token });
  const purge = await api('/api/expenses/bulk-purge', { method: 'POST', body: { ids }, auth: token });
  assert.equal(purge.json.affected, 3);
  assert.equal((await api('/api/expenses/trash', { auth: token })).json.filter(x => ids.includes(x.id)).length, 0);
});

test('일괄 요청의 잘못된 입력을 거부한다', async () => {
  const bad = [
    { ids: [] },
    { ids: 'not-an-array' },
    { ids: ['abc'] },
    { ids: [-1] },
    { ids: Array.from({ length: 501 }, (_, i) => i + 1) }
  ];
  for (const body of bad) {
    const res = await api('/api/expenses/bulk-delete', { method: 'POST', body, auth: token });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
  }
});

test('남의 전표는 조회·삭제·복원할 수 없다', async () => {
  const { json: mine } = await api('/api/expenses', { method: 'POST', body: newExpense({ memo: '내것' }), auth: token });

  assert.ok(!(await api('/api/expenses', { auth: otherToken })).json.some(x => x.id === mine.id));
  assert.equal((await api(`/api/expenses/${mine.id}`, { method: 'DELETE', auth: otherToken })).status, 404);
  assert.equal((await api(`/api/expenses/${mine.id}/image`, { auth: otherToken })).status, 404);

  const bulk = await api('/api/expenses/bulk-delete', { method: 'POST', body: { ids: [mine.id] }, auth: otherToken });
  assert.equal(bulk.json.affected, 0, '남의 전표가 일괄 삭제되었다');
  assert.ok((await api('/api/expenses', { auth: token })).json.some(x => x.id === mine.id));
});

test('휴지통에 있는 전표는 수정할 수 없다', async () => {
  const { json: e } = await api('/api/expenses', { method: 'POST', body: newExpense({ memo: '수정대상' }), auth: token });
  await api(`/api/expenses/${e.id}`, { method: 'DELETE', auth: token });
  const put = await api(`/api/expenses/${e.id}`, { method: 'PUT', body: newExpense({ memo: '몰래수정' }), auth: token });
  assert.equal(put.status, 404);
});

test('서비스워커가 자바스크립트로 서빙된다', async () => {
  const res = await fetch(BASE + '/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(await res.text(), /addEventListener\('fetch'/);
});
