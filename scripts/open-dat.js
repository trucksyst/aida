/**
 * Открывает браузер с расширением AIDA и переходит на one.dat.com/search-loads.
 * Запуск: npm run open-dat (предварительно: npm install && npx playwright install chromium)
 */
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const EXTENSION_PATH = path.join(__dirname, '..');
const USER_DATA_DIR = path.join(__dirname, '../.playwright-user-data');

async function launchContext() {
    const opts = {
        headless: false,
        channel: 'chromium',
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
        ],
        ignoreDefaultArgs: ['--disable-extensions'],
    };
    try {
        return await chromium.launchPersistentContext(USER_DATA_DIR, opts);
    } catch (e) {
        if (e.message && (e.message.includes('ProcessSingleton') || e.message.includes('SingletonLock'))) {
            const fallbackDir = path.join(os.tmpdir(), `aida-pw-${Date.now()}`);
            console.warn('[AIDA] Profile in use, using temp profile:', fallbackDir);
            return await chromium.launchPersistentContext(fallbackDir, opts);
        }
        throw e;
    }
}

async function main() {
    const context = await launchContext();

    let page = context.pages()[0];
    if (!page) page = await context.waitForEvent('page');
    await page.goto('https://one.dat.com/search-loads', { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Краткая проверка: страница DAT загрузилась
    const url = page.url();
    const datOk = url.includes('one.dat.com');
    console.log('[AIDA CHECK] DAT page loaded:', datOk ? 'OK' : 'FAIL', `(${url})`);

    // Расширение: ждём появления service worker (фоновый скрипт AIDA)
    let extOk = false;
    try {
        await Promise.race([
            context.waitForEvent('serviceworker', { timeout: 5000 }).then(() => { extOk = true; }),
            new Promise(r => setTimeout(r, 5000)),
        ]);
    } catch (_) {}
    if (!extOk && context.serviceWorkers().length > 0) extOk = true;
    console.log('[AIDA CHECK] Extension service worker:', extOk ? 'OK' : 'not detected');

    // Скриншот страницы — ассистент сможет посмотреть файл в проекте
    const screenshotPath = path.join(__dirname, '..', 'aida-last-screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    console.log('[AIDA CHECK] Screenshot saved:', screenshotPath);

    // Даём время залогиниться и сделать поиск, потом повторный скриншот
    console.log('[AIDA] You have 45s to run a search on DAT — then a second screenshot will be taken.');
    await new Promise(r => setTimeout(r, 45000));
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    console.log('[AIDA CHECK] Second screenshot (after 45s) saved:', screenshotPath);

    console.log('[AIDA] Now open AIDA tab (extension icon), click Search. Close browser when done.');
    // Держим процесс живым, чтобы браузер не закрылся
    await new Promise(() => {});
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
