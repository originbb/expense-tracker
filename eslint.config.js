/* 린트 설정.
 *
 * index.html의 인라인 <script>가 이 프로젝트 JS의 대부분(약 2,000줄)이라
 * eslint-plugin-html로 HTML 안의 스크립트까지 검사 대상에 포함한다.
 * .js만 보면 코드의 3분의 1만 검사하면서 "통과"라고 말하게 된다.
 *
 * 스타일 규칙(따옴표·세미콜론·들여쓰기)은 일부러 넣지 않았다. 3천 줄짜리
 * 파일을 대량 재포맷하면 diff가 폭발하고 회귀 위험만 커진다.
 * 지금은 버그를 잡는 규칙만 켠다.
 */
import html from 'eslint-plugin-html';

// 브라우저 / 서비스워커 / Node 전역
const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', indexedDB: 'readonly', caches: 'readonly',
  fetch: 'readonly', Response: 'readonly', Request: 'readonly', Headers: 'readonly', URL: 'readonly',
  console: 'readonly', performance: 'readonly', alert: 'readonly', confirm: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  Image: 'readonly', FileReader: 'readonly', Blob: 'readonly', File: 'readonly', FormData: 'readonly',
  Intl: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly', btoa: 'readonly', atob: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', matchMedia: 'readonly',
  HTMLElement: 'readonly', Element: 'readonly', Node: 'readonly', Event: 'readonly',
  // 사용 시점에 CDN에서 지연 로드되는 라이브러리 (loadScriptOnce)
  XLSX: 'readonly', JSZip: 'readonly', saveAs: 'readonly', Tesseract: 'readonly'
};

const nodeGlobals = {
  process: 'readonly', Buffer: 'readonly', console: 'readonly', URL: 'readonly',
  fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly'
};

const bugRules = {
  'no-undef': 'error',              // 오타난 변수명 — 실제 버그일 가능성이 가장 높다
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-self-assign': 'error',
  'no-fallthrough': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  'no-async-promise-executor': 'error',
  'require-atomic-updates': 'warn',
  // caughtErrors: 이 코드베이스는 try{...}catch(e){} 로 실패를 의도적으로 무시하는 곳이
  // 많다(localStorage 접근 등). 전부 경고로 띄우면 진짜 신호가 묻힌다.
  // ignoreRestSiblings: const { deletedAt, ...entry } = it 처럼 필드를 빼내는 관용구를 허용한다.
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
  'no-empty': ['warn', { allowEmptyCatch: true }]
};

export default [
  { ignores: ['node_modules/**', '.playwright-mcp/**', 'test.cjs'] },

  // 브라우저에서 도는 코드 (app.js와 index.html에 남은 인라인 스크립트)
  {
    files: ['app.js', 'index.html'],
    plugins: { html },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: browserGlobals
    },
    rules: bugRules
  },

  // 서비스워커
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...browserGlobals, self: 'readonly', clients: 'readonly', skipWaiting: 'readonly' }
    },
    rules: bugRules
  },

  // 서버 / 테스트 (ESM)
  {
    files: ['server.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: bugRules
  }
];
