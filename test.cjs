const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('Navigating to http://localhost:12345');
  await page.goto('http://localhost:12345', { waitUntil: 'networkidle0' });

  // 1. Take screenshot of guest mode
  await page.screenshot({ path: '/Users/artwool/.gemini/antigravity-ide/brain/50ff4b93-6beb-4209-a9d0-e221f16e6fc9/guest_mode.png' });
  console.log('Guest mode screenshot saved.');

  // 2. Add an expense in guest mode
  console.log('Clicking add button...');
  await page.click('#openAddBtn');
  await page.waitForSelector('#overlay.open');
  await page.type('#fMemo', 'Guest Test Expense');
  await page.type('#fDebit', '1000');
  await page.click('#addBtn');
  
  // Wait for modal to close
  await page.waitForFunction(() => !document.querySelector('#overlay').classList.contains('open'));

  // 3. Open Login modal
  console.log('Opening login modal...');
  await page.click('#navLoginBtn');
  await page.waitForSelector('#authOverlay.open');
  
  const randomEmail = `testsync_${Date.now()}@example.com`;

  // Switch to Register tab
  await page.click('#tabRegisterBtn');
  await page.type('#authEmail', randomEmail);
  await page.type('#authPassword', 'password123');
  await page.type('#authPasswordConfirm', 'password123');
  
  console.log('Registering user...');
  await page.click('#authSubmitBtn');
  
  // wait for success message
  await page.waitForFunction(() => {
    const el = document.querySelector('#authMessage');
    return el && el.classList.contains('success') && el.textContent.includes('회원가입이 완료되었습니다');
  });

  console.log('Switching to login...');
  await page.click('#tabLoginBtn');
  await page.evaluate(() => {
    document.querySelector('#authEmail').value = '';
    document.querySelector('#authPassword').value = '';
  });
  await page.type('#authEmail', randomEmail);
  await page.type('#authPassword', 'password123');
  await page.click('#authSubmitBtn');

  // Wait for login to complete and sync overlay to appear
  console.log('Waiting for sync overlay...');
  await page.waitForSelector('#syncOverlay.open', { timeout: 10000 });
  
  await page.screenshot({ path: '/Users/artwool/.gemini/antigravity-ide/brain/50ff4b93-6beb-4209-a9d0-e221f16e6fc9/sync_overlay.png' });
  console.log('Sync overlay screenshot saved.');

  // Click sync confirm
  console.log('Clicking sync confirm...');
  await page.click('#syncConfirmBtn');
  
  // Wait for reload and the guest banner to disappear
  await page.waitForNavigation({ waitUntil: 'networkidle0' });
  
  await page.screenshot({ path: '/Users/artwool/.gemini/antigravity-ide/brain/50ff4b93-6beb-4209-a9d0-e221f16e6fc9/synced_state.png' });
  console.log('Synced state screenshot saved.');

  await browser.close();
  console.log('Test completed successfully.');
})();
