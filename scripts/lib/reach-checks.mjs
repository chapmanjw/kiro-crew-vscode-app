// Smoke checks for a dashboard viewed at an address that is not a local port
// (0.7.1), the way a tunnel's https address is. From there neither the frame
// port (the viewer's own 127.0.0.1) nor the app's web origin (the viewer's own
// loopback) leads to the workbench, and the page used to frame 127.0.0.1 anyway
// and show the browser's connection error in an otherwise blank pane. The page
// now says so and names the port forward that works.
//
// The viewer is reached by a name Chrome maps to 127.0.0.1 (REACH_HOST_ARG,
// given to the browser at launch): not a loopback name, so the page cannot use
// the web origin. It is plain http here so the check needs no certificate;
// the https case is the same branch (test/weborigin.test.mjs, canUseWebOrigin).

/** A host name that is not a loopback name; the smoke's browser resolves it to 127.0.0.1. */
export const REACH_HOST = 'tunnel-viewer.test';
export const REACH_HOST_ARG = `--host-resolver-rules=MAP ${REACH_HOST} 127.0.0.1`;

const NOTICE = '[data-testid="vscode-pane-unreachable"]';

/**
 * @param {object} o
 * @param {import('playwright-core').BrowserContext} o.browser  the smoke's browser context (launched with REACH_HOST_ARG)
 * @param {number} o.hostPort       the dashboard stand-in's port
 * @param {number} o.framePort      the launcher's frame port
 * @param {string} o.gatewayOrigin  the gateway the launcher was started with
 */
export async function reachChecks({ browser, hostPort, framePort, gatewayOrigin, check }) {
  const url = `http://${REACH_HOST}:${hostPort}/apps/vscode-pane`;
  const gatewayPort = new URL(gatewayOrigin).port;

  // 1. No route: the frame port does not answer from this viewer (the probe fails).
  {
    const page = await browser.newPage();
    try {
      let probes = 0;
      await page.route('**/_vscp-probe', (route) => {
        probes++;
        return route.abort('connectionrefused');
      });
      await page.goto(url);
      const notice = page.locator(NOTICE);
      await notice.waitFor({ timeout: 30_000 }).catch(() => {});
      const text = (await notice.innerText().catch(() => '')) || '';
      check(
        'a viewer at an address that is not a local port gets a "cannot load" notice naming that address, not a blank pane',
        /cannot load at this address/.test(text) && text.includes(`${REACH_HOST}:${hostPort}`),
        text.slice(0, 160),
      );
      // (Copy command needs the async clipboard API, which a plain http page at this name does not get; an https tunnel's does.)
      check(
        'the notice gives the port forward for the gateway\'s own port, and the Check again button',
        text.includes(`ssh -L ${gatewayPort}:127.0.0.1:${gatewayPort}`) && /Check again/.test(text),
        `gateway port ${gatewayPort}: ${text.split('\n').find((l) => /ssh -L/.test(l)) || '(no command)'}`,
      );
      const frames = await page.evaluate(() => document.querySelectorAll('iframe[title="VS Code"]').length);
      check('no VS Code frame is created for that viewer (it would only show the browser\'s connection error)', frames === 0, String(frames));
      // Check again clears the verdict and probes again; the notice is back once that probe has failed too.
      const before = probes;
      await page.locator('[data-testid="vscode-pane-unreachable-again"]').click();
      for (const t0 = Date.now(); probes === before && Date.now() - t0 < 15_000;) await page.waitForTimeout(100);
      await notice.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
      check('Check again probes again, and with no route the notice comes back', probes > before && (await page.locator(NOTICE).count()) === 1, `probes ${before} -> ${probes}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  // 2. The same address, but the frame port answers: the probe is the proof, so the
  //    workbench is framed and there is no notice. The workbench document itself is
  //    stubbed, so no second VS Code window joins the run.
  {
    const page = await browser.newPage();
    try {
      await page.route(new RegExp(`^http://127\\.0\\.0\\.1:${framePort}/vsc-`), (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>workbench stand-in</title>' }));
      await page.goto(url);
      const frame = page.locator('iframe[title="VS Code"]');
      await frame.waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {});
      const src = (await frame.first().getAttribute('src').catch(() => '')) || '';
      const notices = await page.locator(NOTICE).count();
      check(
        'at the same kind of address, a frame port that answers is used and no notice is shown',
        src.startsWith(`http://127.0.0.1:${framePort}/vsc-`) && notices === 0,
        `${src.replace(/vsc-[^/?]+/, 'vsc-<key>').slice(0, 80)}; notices ${notices}`,
      );
    } finally {
      await page.close().catch(() => {});
    }
  }
}
