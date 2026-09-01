/* 오프라인 지원 서비스워커.
   영수증은 식당 안·지하 주차장처럼 신호가 약한 곳에서 그 자리에 찍는 경우가 많다.
   최소한 앱 셸은 네트워크 없이 떠야 하고, 게스트 모드는 IndexedDB라 그 상태로 입력까지 된다.

   캐시 이름을 바꾸면 이전 캐시는 activate에서 모두 삭제된다. */
const CACHE = 'expense-shell-v1';

// 앱 셸. 이것만 있으면 오프라인에서 화면이 뜬다.
// 무거운 라이브러리(xlsx/tesseract/jszip)는 외부 CDN에서 사용 시점에 지연 로드되므로 여기 없다.
const SHELL = [
  '/',
  '/manifest.json',
  '/favicon.jpg',
  '/apple-touch-icon.png?v=3',
  '/icon-192.png?v=3',
  '/icon-512.png?v=3'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 아이콘 하나가 실패해도 설치 자체는 진행되도록 개별 처리한다.
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 전표 저장·삭제 등 변경 요청은 절대 가로채지 않는다.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 외부 CDN(xlsx·tesseract 등)은 브라우저 기본 캐시에 맡긴다.
  // no-cors 응답은 성공 여부를 알 수 없어 오류 페이지를 캐싱할 위험이 있다.
  if (url.origin !== self.location.origin) return;

  // API 응답은 캐시하지 않는다. 오래된 전표 목록을 보여주는 편이 못 보여주는 것보다 위험하다.
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // HTML은 network-first. cache-first로 하면 배포해도 사용자가 옛 버전에 갇힌다.
    // waitUntil은 반드시 동기적으로 호출해야 한다. await 뒤에서 부르면 이벤트가
    // 이미 비활성이라 InvalidStateError가 나고 셸 캐시가 갱신되지 않는다.
    const fromNetwork = fetch(req);

    event.waitUntil(
      fromNetwork
        .then(res => {
          if (!res.ok) return;
          // 브라우저가 본문을 읽기 시작하면 clone()이 실패한다.
          // caches.open()을 기다린 뒤 복제하면 늦으므로 여기서 즉시 복제해 둔다.
          const copy = res.clone();
          return caches.open(CACHE).then(c => c.put('/', copy));
        })
        .catch(() => {})
    );

    event.respondWith(
      fromNetwork.catch(() => caches.match('/').then(cached => {
        if (cached) return cached;
        throw new Error('오프라인이며 캐시된 앱 셸이 없습니다.');
      }))
    );
    return;
  }

  // 문서 자체를 navigate가 아닌 방식으로 요청하는 경우(예: fetch('/'))는
  // 낡은 사본을 돌려주지 않도록 그대로 네트워크에 맡긴다.
  if (url.pathname === '/') return;

  // 아이콘·매니페스트는 cache-first. 내용이 바뀌면 ?v= 가 올라가 URL 자체가 달라진다.
  event.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
