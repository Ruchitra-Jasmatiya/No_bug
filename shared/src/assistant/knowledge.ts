import { describeLocation, type Located } from './locate.js';

/**
 * Debugging knowledge for the checks this platform produces. Each rule explains why such a problem happens and
 * how to fix it. The text is general engineering knowledge; the facts about THIS website (URL, file, line,
 * element, message) come only from the stored evidence and are added by the answer builder.
 */

export interface AssistantIssue {
  code: string;
  severity: string;
  confidence: string;
  category: string;
  title: string;
  description: string;
  affectedUrl: string | null;
  suggestedFix: string;
  evidence: Record<string, unknown>;
  checkKey?: string | null;
  moduleId?: string | null;
  ai?: { explanation?: string; fix?: string } | null;
}

export interface Explanation {
  topic: string;
  cause: string;
  steps: string[];
  example?: { lang: string; code: string };
  /** Concrete "what to change" line. Uses file and line only when the evidence has them. */
  change?: string;
  verify?: string;
}

interface Rule {
  id: string;
  test: RegExp;
  build: (i: AssistantIssue, loc: Located) => Explanation;
}

const ev = (i: AssistantIssue, k: string): string => {
  const v = i.evidence?.[k];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
};
const where = (loc: Located): string | null => (loc.locations[0] ? describeLocation(loc.locations[0]) : null);
const keyOf = (i: AssistantIssue): string => `${i.checkKey ?? ''} ${i.title}`.toLowerCase();

/* ------------------------------------------------------------------------------- JavaScript errors */

export function explainJsMessage(message: string, loc: Located): Explanation {
  const m = message;
  const at = where(loc);
  const place = at ? `at ${at}` : 'where the error is raised';
  let r: RegExpMatchArray | null;

  if ((r = /([\w$.]+) is not defined/.exec(m))) {
    return {
      topic: 'ReferenceError: name is not defined',
      cause: `The code uses \`${r[1]}\`, but nothing with that name exists at that moment. Usually the script or library that defines it failed to load (check for a 404 on a script), loads later than the code that needs it, or the name is misspelled.`,
      steps: [`Open DevTools → Network and look for a failed or blocked script that should define \`${r[1]}\`.`, `Check the order of your <script> tags: the library must load before the code that uses it (or use \`defer\`/modules consistently).`, `Search your code for \`${r[1]}\` and confirm it is declared, imported or exported with exactly this spelling.`],
      example: { lang: 'html', code: `<script src="/vendor/library.js" defer></script>\n<script src="/app.js" defer></script> <!-- runs after library.js -->` },
      change: at ? `In ${at}, make sure \`${r[1]}\` is declared or imported before this line runs.` : `Declare or import \`${r[1]}\` where it is used.`,
    };
  }
  if ((r = /Cannot read propert(?:y|ies) of (undefined|null)(?: \(reading '([^']+)'\))?/.exec(m)) || (r = /(?:undefined|null) is not an object \(evaluating '([^']+)'\)/.exec(m))) {
    const prop = r[2] ?? r[1] ?? 'a property';
    return {
      topic: `TypeError: reading "${prop}" of ${r[1] === 'null' ? 'null' : 'undefined'}`,
      cause: `A value was ${r[1] === 'null' ? 'null' : 'undefined'} when the code tried to read \`${prop}\` from it. Typical reasons: data from an API has not arrived yet, an element was looked up before it exists in the page, or an object is missing a field.`,
      steps: ['Find the expression that reads this property and log the value just before it.', 'If it is an element lookup (`querySelector`), run the code after the DOM is ready or check the selector.', 'If it is API data, wait for the response and handle an empty or failed result before using it.'],
      example: { lang: 'js', code: `// before: user.profile.name\nconst name = user?.profile?.name ?? 'Guest'; // safe when profile is missing\nconst el = document.querySelector('#menu');\nif (el) el.classList.add('open'); // guard against a missing element` },
      change: at ? `In ${at}, guard the value (optional chaining or an \`if\` check) before reading \`${prop}\`.` : `Guard the value before reading \`${prop}\`.`,
    };
  }
  if ((r = /([\w$.]+) is not a function/.exec(m))) {
    return {
      topic: 'TypeError: not a function',
      cause: `\`${r[1]}\` exists but is not callable. Common reasons: a library loaded a different version than expected, a default and a named import were mixed up, or a variable was overwritten with a non-function.`,
      steps: [`Log \`typeof ${r[1]}\` right before the call.`, 'Check the library version and how it is imported (`import x from` versus `import { x } from`).', 'Look for another variable with the same name that shadows it.'],
      change: at ? `In ${at}, verify what \`${r[1]}\` actually is at runtime before calling it.` : `Verify what \`${r[1]}\` is at runtime before calling it.`,
    };
  }
  if (/Unexpected token '?<'?/.test(m)) {
    return {
      topic: 'Received HTML where JavaScript or JSON was expected',
      cause: 'The browser asked for a script or an API response and got an HTML page (usually a 404 or an error page that starts with "<"). The file path or API route is wrong, or a rewrite rule returns index.html for everything.',
      steps: ['Open DevTools → Network, find the request that returned HTML and look at its URL and status.', 'Correct the path of the script or API route, or fix the server rewrite so real files and /api routes are not replaced by index.html.', 'For `fetch`, check `response.ok` before calling `response.json()`.'],
      example: { lang: 'js', code: `const res = await fetch('/api/items');\nif (!res.ok) throw new Error('Request failed: ' + res.status);\nconst data = await res.json();` },
    };
  }
  if (/JSON|Unexpected end of/.test(m) && /parse|token|valid|end/i.test(m)) {
    return {
      topic: 'Invalid or empty JSON',
      cause: 'JSON.parse or response.json() received text that is not valid JSON: an empty body, an HTML error page, or a truncated response.',
      steps: ['Open the failing request in DevTools → Network → Response and read what the server really returned.', 'Make the server always answer with valid JSON and the right Content-Type.', 'Wrap parsing in try/catch and show a clear error to users.'],
    };
  }
  if (/blocked by CORS|Access-Control-Allow-Origin|CORS policy/i.test(m)) {
    return corsExplanation();
  }
  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(m)) {
    return {
      topic: 'Network request failed',
      cause: 'The browser could not complete a request: the server is down or unreachable, DNS failed, the certificate is invalid, the request was blocked by CORS or mixed content, or an extension blocked it.',
      steps: ['Open DevTools → Network and read the failure reason next to the red request.', 'Request the same URL directly in a browser tab or with curl to see whether the server answers.', 'If the console mentions CORS, fix the response headers (see the CORS fix).'],
    };
  }
  if (/Mixed Content/i.test(m)) return mixedContentExplanation();
  if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(m)) {
    return {
      topic: 'Blocked by Content Security Policy',
      cause: 'The page\'s Content-Security-Policy does not allow the script, style, image or connection that the page tried to use, so the browser refused it.',
      steps: ['Read the console message: it names the blocked URL and the directive (for example `script-src`).', 'Add only the trusted origin that is needed to that directive, or load the resource from your own origin.', 'Avoid `unsafe-inline` and `unsafe-eval`; use nonces or hashes for inline code.'],
      example: { lang: 'http', code: `Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com; img-src 'self' data:` },
    };
  }
  if (/^Script error\.?$/i.test(m.trim())) {
    return {
      topic: 'Script error (details hidden by the browser)',
      cause: 'An error happened in a script served from another origin without CORS permission, so the browser hides the message, file and line.',
      steps: ['Add `crossorigin="anonymous"` to the <script> tag.', 'Make the script host send `Access-Control-Allow-Origin`.', 'Reproduce the error with the script served from your own origin to see the real stack trace.'],
      example: { lang: 'html', code: `<script src="https://cdn.example.com/lib.js" crossorigin="anonymous"></script>` },
    };
  }
  if (/Maximum call stack size exceeded/i.test(m)) {
    return { topic: 'RangeError: infinite recursion', cause: 'A function keeps calling itself (directly or through another function) without a stopping condition.', steps: [`Look at the stack trace ${place}: the repeating function names show the loop.`, 'Add a base case, or break the cycle (for example a setter that triggers itself).'], change: at ? `In ${at}, add a stopping condition to the recursive call.` : undefined };
  }
  if (/SyntaxError/i.test(m)) {
    return { topic: 'SyntaxError', cause: 'The browser could not parse the script. Often a missing bracket or comma, modern syntax that the build did not transpile, or a file that was cut off.', steps: [at ? `Open ${at} and check the line (and the line before it).` : 'Open the script named in the console and check the reported line.', 'Run your linter or build to catch the syntax error before deployment.', 'Confirm the file is served completely (compare file sizes) and with `application/javascript`.'], change: at ? `Fix the syntax at ${at}.` : undefined };
  }
  if (/Uncaught \(in promise\)|unhandled.*rejection|promise/i.test(m)) {
    return { topic: 'Unhandled promise rejection', cause: 'An async operation failed and nothing handled the error (no `catch`, no `try/catch` around `await`).', steps: ['Add `.catch()` or wrap the `await` in try/catch where the promise is created.', 'Show the user a clear message and log the error.'], example: { lang: 'js', code: `try {\n  const data = await loadData();\n} catch (err) {\n  console.error(err);\n  showError('Could not load data. Please try again.');\n}` } };
  }
  if (/hydrat/i.test(m)) {
    return { topic: 'Hydration mismatch', cause: 'The HTML rendered on the server differs from what the browser renders first, often because of dates, random values or `window` checks.', steps: ['Render the same output on server and client for the first paint.', 'Move browser-only values (time, random, localStorage) into an effect that runs after mount.'] };
  }
  if (/ResizeObserver loop/i.test(m)) {
    return { topic: 'ResizeObserver loop notification', cause: 'A harmless browser notice: a resize callback changed layout in the same frame. It rarely affects users.', steps: ['If you want it gone, wrap the callback work in `requestAnimationFrame`.'] };
  }
  return {
    topic: 'JavaScript error',
    cause: `The page raised an error while running: "${message.slice(0, 160)}". The message and the stack trace show which code failed and with which value.`,
    steps: [at ? `Open ${at} and read the code around that line.` : 'Open DevTools → Console on the page and reproduce the error to see the full stack trace.', 'Log the values used on that line to find the one that is wrong.', 'Fix the cause (missing data, wrong name, wrong order) and handle the failure case.'],
    change: at ? `Start at ${at}.` : undefined,
  };
}

/* ---------------------------------------------------------------------------------- shared pieces */

function corsExplanation(): Explanation {
  return {
    topic: 'CORS (cross-origin request blocked)',
    cause: 'The page called an API on a different origin, and that API did not send an Access-Control-Allow-Origin header that allows the page\'s origin, so the browser blocks the response.',
    steps: ['On the API, allow the exact origin of your site (not `*` when credentials are used).', 'Answer the browser\'s preflight `OPTIONS` request with 204 and the allowed methods and headers.', 'Or route the call through your own origin (a proxy or rewrite) so no cross-origin request is needed.'],
    example: { lang: 'js', code: `// Express\nimport cors from 'cors';\napp.use(cors({ origin: 'https://www.example.com', credentials: true }));` },
    verify: 'Reload the page and confirm the request shows an Access-Control-Allow-Origin header in DevTools → Network.',
  };
}

function mixedContentExplanation(): Explanation {
  return {
    topic: 'Mixed content (HTTP resource on an HTTPS page)',
    cause: 'The page is served over HTTPS but loads a script, image, stylesheet or request over plain HTTP. Browsers block or warn about it because attackers could alter that resource.',
    steps: ['Change every `http://` resource URL to `https://` (or to a protocol-relative path like `/assets/x.png`).', 'Confirm the other host supports HTTPS; if it does not, self-host the file.', 'Add `Content-Security-Policy: upgrade-insecure-requests` as a safety net.'],
    example: { lang: 'html', code: `<img src="https://cdn.example.com/logo.png" alt="Logo">` },
  };
}

function statusExplanation(status: number, error: string, url: string, loc: Located): Explanation {
  const u = url || loc.urls[0] || 'this URL';
  if (status === 404 || status === 410) return { topic: `HTTP ${status}: resource not found`, cause: `The server has nothing at ${u}. The link or reference has a typo, the file was moved or deleted, or a deployment did not include it.`, steps: ['Open the URL directly to confirm it fails.', 'Find where it is referenced (the page that links to it) and correct the path, or restore the missing file or route.', 'If the page moved permanently, add a 301 redirect from the old address.'], example: { lang: 'nginx', code: `location = /old-page { return 301 /new-page; }` }, change: `Fix or remove the reference to ${u}.`, verify: 'Open the URL again: it should return 200, or redirect with 301 to the new page.' };
  if (status === 401 || status === 403) return { topic: `HTTP ${status}: access refused`, cause: 'The server refused the request: the resource needs a login, or a firewall or bot protection blocks automated visitors.', steps: ['If the page should be public, remove the login requirement or the firewall rule for it.', 'If it is private on purpose, this is expected; link to it only for signed-in users.'] };
  if (status === 429) return { topic: 'HTTP 429: too many requests', cause: 'The server rate-limited the test requests.', steps: ['Allow the tester through the rate limiter or retest later.'] };
  if (status >= 500) return { topic: `HTTP ${status}: server error`, cause: 'The application crashed or an upstream service failed while building the response. The cause is in the server, not the browser.', steps: ['Open the server logs for the time of the request and find the exception for this route.', 'Reproduce the request with the same URL and parameters locally.', 'Fix the failing code or dependency (database, API call), then add error handling so users see a friendly page.'], change: `Check the server route that serves ${u}.`, verify: 'Request the URL again and confirm a 2xx status.' };
  if (status === 0) {
    const e = error.toLowerCase();
    const why = /enotfound|dns|name_not_resolved/.test(e) ? 'The domain name does not resolve (DNS).' : /cert|ssl|tls/.test(e) ? 'The TLS certificate is invalid, expired or incomplete.' : /refused/.test(e) ? 'The server refused the connection (it is down or the port is closed).' : /timeout|timed/.test(e) ? 'The server did not answer in time.' : 'The request could not be completed.';
    return { topic: 'URL could not be reached', cause: `${why} ${error ? `(reported: ${error})` : ''}`.trim(), steps: ['Open the URL in a browser to see whether it works for you.', 'Check DNS records, the certificate chain and that the server is running.', 'If it is a third-party URL, replace or remove the reference.'], change: `Fix the host behind ${u} or remove the reference.` };
  }
  return { topic: `HTTP ${status}`, cause: `The URL answered with status ${status}, which is not a success.`, steps: ['Open the URL and check why it answers this way.', 'Fix the route or remove the reference.'] };
}

function headerFix(name: string, value: string, why: string): Explanation {
  return {
    topic: `Missing security header: ${name}`,
    cause: why,
    steps: [`Add the \`${name}\` response header on your web server or in your app.`, 'Test the page after the change, because strict values can block legitimate resources.'],
    example: { lang: 'js', code: `// Express (helmet sets this and other safe defaults)\nimport helmet from 'helmet';\napp.use(helmet());\n\n// or manually\nres.setHeader('${name}', '${value}');` },
    verify: `Reload the page and confirm \`${name}\` appears in DevTools → Network → Response Headers.`,
  };
}

/* ------------------------------------------------------------------------------------------ rules */

const RULES: Rule[] = [
  {
    id: 'js-error',
    test: /exception_|unhandled javascript exception|console_error|console error|unhandled_exceptions/,
    build: (i, loc) => explainJsMessage(ev(i, 'message') || ev(i, 'text') || i.description, loc),
  },
  {
    id: 'click-error',
    test: /click_error|error when clicking/,
    build: (i, loc) => ({ ...explainJsMessage(ev(i, 'error') || i.description, loc), topic: 'JavaScript error when a button is clicked', change: `Fix the click handler of the button "${ev(i, 'button') || 'shown in the evidence'}".` }),
  },
  { id: 'mixed', test: /mixed_content|mixed content/, build: () => mixedContentExplanation() },
  { id: 'cors', test: /\bcors\b|api_cors/, build: () => corsExplanation() },
  {
    id: 'http-status',
    test: /http_error_|page_http_|returns http|broken_link|broken link|pagination_broken|pagination link|request_failed|failed .* request|could not be reached|page_unreachable|navigation menu/,
    build: (i, loc) => statusExplanation(Number(i.evidence?.status ?? /HTTP (\d{3})/.exec(i.title + ' ' + i.description)?.[1] ?? 0), ev(i, 'error') || ev(i, 'failure'), ev(i, 'url') || ev(i, 'href') || i.affectedUrl || '', loc),
  },
  {
    id: 'images-broken',
    test: /broken_images|broken images|images? (fail|did not load)/,
    build: (i, loc) => ({ topic: 'Broken images', cause: 'The image URLs return an error or cannot be reached, so visitors see empty boxes. Typical reasons: a wrong path or file name (case matters on Linux), files missing from the deployment, or a deleted CDN asset.', steps: ['Open each broken image URL in a new tab to see the error.', 'Correct the `src` path or restore the file.', 'Add meaningful `alt` text so the page still makes sense if an image fails.'], example: { lang: 'html', code: `<img src="/images/team.jpg" alt="The team at the 2025 offsite" width="800" height="450">` }, change: loc.urls.length ? `Fix these image URLs: ${loc.urls.slice(0, 3).join(', ')}.` : undefined }),
  },
  { id: 'images-heavy', test: /heavy_images|oversized images|page_weight/, build: () => ({ topic: 'Oversized images / heavy page', cause: 'Large files slow loading, especially on mobile networks.', steps: ['Resize images to the size they are displayed at.', 'Serve WebP or AVIF and compress them.', 'Lazy-load images below the fold with `loading="lazy"`.'], example: { lang: 'html', code: `<img src="hero.webp" width="1200" height="600" loading="lazy" alt="...">` } }) },
  { id: 'redirect', test: /redirect_loop|redirect_chain|redirect loop|redirect chain|redirect chains|behind redirect/, build: () => ({ topic: 'Redirect loops and chains', cause: 'Each redirect costs a full round trip; a loop never ends and the page never loads.', steps: ['Link directly to the final URL.', 'Find the rules that bounce a URL back and forth (www/non-www, http/https, trailing slash).', 'Keep a single redirect from the old URL to the final one.'] }) },
  { id: 'hsts', test: /\bhsts\b|strict-transport/, build: () => headerFix('Strict-Transport-Security', 'max-age=31536000; includeSubDomains', 'Without HSTS, a first visit over plain HTTP can be intercepted and downgraded.') },
  { id: 'csp', test: /\bcsp\b|content-security-policy/, build: () => ({ ...headerFix('Content-Security-Policy', "default-src 'self'", 'Without a Content-Security-Policy the browser will run injected scripts, which turns any XSS bug into a full compromise.'), steps: ['Start in report-only mode: `Content-Security-Policy-Report-Only`, collect violations, then enforce.', 'Allow only the origins you really use for scripts, styles, images and connections.', 'Avoid `unsafe-inline` and `unsafe-eval`; use nonces or hashes.'] }) },
  { id: 'xfo', test: /clickjacking|x-frame/, build: () => headerFix('X-Frame-Options', 'DENY', 'Without frame protection another site can embed yours invisibly and trick users into clicking (clickjacking). Prefer CSP `frame-ancestors`.') },
  { id: 'nosniff', test: /nosniff|x-content-type/, build: () => headerFix('X-Content-Type-Options', 'nosniff', 'Browsers may guess file types and execute a file that was served as something harmless.') },
  { id: 'referrer', test: /referrer_policy|referrer-policy/, build: () => headerFix('Referrer-Policy', 'strict-origin-when-cross-origin', 'Full URLs (which can include tokens or ids) may be sent to other sites when users follow links.') },
  { id: 'permissions', test: /permissions_policy|permissions-policy/, build: () => headerFix('Permissions-Policy', 'camera=(), microphone=(), geolocation=()', 'Restrict powerful browser features that the site does not use.') },
  {
    id: 'cookie',
    test: /cookie_|cookie/,
    build: (i) => ({ topic: 'Cookie missing security flags', cause: 'A cookie without `Secure`, `HttpOnly` or `SameSite` can be read by scripts, sent over plain HTTP or sent with cross-site requests.', steps: ['Set `HttpOnly` for session cookies so scripts cannot read them.', 'Set `Secure` so the cookie is sent only over HTTPS.', 'Set `SameSite=Lax` (or `Strict`) to reduce cross-site request forgery.'], example: { lang: 'js', code: `res.cookie('${(i.checkKey ?? 'session').replace(/^cookie_/, '') || 'session'}', value, { httpOnly: true, secure: true, sameSite: 'lax' });` } }),
  },
  { id: 'exposed', test: /exposed_|sensitive files|publicly downloadable/, build: (i) => ({ topic: 'Sensitive file is publicly downloadable', cause: 'A file that should never be public (environment variables, git data, backups) is inside the web root. Anyone can download it and may find passwords or keys.', steps: ['Remove the file from the web root or block the path on the server immediately.', 'Treat every secret in it as compromised: rotate keys, passwords and tokens.', 'Add a deployment check so such files never ship again.'], example: { lang: 'nginx', code: `location ~ /\\.(env|git) { deny all; return 404; }` }, change: i.affectedUrl ? `Block ${i.affectedUrl} and rotate any secret it exposed.` : undefined }) },
  { id: 'version', test: /version_disclosure|x-powered-by/, build: () => ({ topic: 'Server reveals its software version', cause: 'Headers like `X-Powered-By` tell attackers exactly which version to target.', steps: ['Remove the header.'], example: { lang: 'js', code: `app.disable('x-powered-by'); // Express` } }) },
  { id: 'https', test: /https_upgrade|https_available|http_redirect|\bhttps\b/, build: () => ({ topic: 'HTTPS not enforced', cause: 'Visitors can reach the site over unencrypted HTTP, so traffic can be read or changed.', steps: ['Install a valid TLS certificate (Let\'s Encrypt is free).', 'Redirect all HTTP requests to HTTPS with a 301.', 'Then enable HSTS.'], example: { lang: 'nginx', code: `server { listen 80; return 301 https://$host$request_uri; }` } }) },
  {
    id: 'seo-title',
    test: /(^| )title( |$)|page title|pages_missing_title|pages without a title|duplicate_titles|share the same title/,
    build: () => ({ topic: 'Page title', cause: 'The <title> is what appears in browser tabs and search results. Missing, duplicate or very long/short titles hurt clicks and ranking.', steps: ['Give every page a unique title of roughly 30–60 characters.', 'Put the page\'s main topic first and the brand last.'], example: { lang: 'html', code: `<title>Pricing – Acme Analytics</title>` } }),
  },
  { id: 'seo-description', test: /meta_description|meta description/, build: () => ({ topic: 'Meta description', cause: 'Search engines show this text under the title. Missing descriptions are replaced by random page text.', steps: ['Write a unique 70–160 character summary per page.'], example: { lang: 'html', code: `<meta name="description" content="Track errors across your site with daily automated tests.">` } }) },
  { id: 'seo-h1', test: /(^| )h1( |$)|heading_order|heading order/, build: () => ({ topic: 'Headings', cause: 'Each page should have one <h1> that names the page, and headings should not skip levels; screen-reader users navigate by them.', steps: ['Use exactly one <h1> per page.', 'Use h2 for sections and h3 for subsections without skipping levels.'], example: { lang: 'html', code: `<h1>Pricing</h1>\n<h2>Free plan</h2>\n<h3>Limits</h3>` } }) },
  { id: 'seo-viewport', test: /viewport_meta|no_viewport_meta|viewport meta/, build: () => ({ topic: 'Missing viewport meta tag', cause: 'Without it phones render the page at desktop width and shrink it, so text is tiny and layouts look broken.', steps: ['Add the viewport tag inside <head>.'], example: { lang: 'html', code: `<meta name="viewport" content="width=device-width, initial-scale=1">` } }) },
  { id: 'seo-lang', test: /html_lang|lang attribute|html-has-lang/, build: () => ({ topic: 'Missing language attribute', cause: 'Screen readers and translators need the page language to pick the right pronunciation.', steps: ['Set `lang` on the <html> element.'], example: { lang: 'html', code: `<html lang="en">` } }) },
  { id: 'seo-alt', test: /img_alt|alt text|image-alt|missing alt/, build: () => ({ topic: 'Images without alt text', cause: 'Screen readers cannot describe the image and search engines cannot index it.', steps: ['Describe the image\'s purpose in `alt`.', 'Use an empty `alt=""` for purely decorative images.'], example: { lang: 'html', code: `<img src="chart.png" alt="Sales grew 20% in Q3">` } }) },
  { id: 'seo-misc', test: /canonical|robots_txt|robots\.txt|sitemap|og:|open graph|pages_noindex|noindex/, build: (i) => ({ topic: 'Search engine signals', cause: i.description || 'A search-related tag or file is missing or misconfigured.', steps: ['Add a `<link rel="canonical">` pointing at the preferred URL.', 'Serve `/robots.txt` and a `/sitemap.xml`, and make sure robots.txt does not block the whole site.'], example: { lang: 'html', code: `<link rel="canonical" href="https://www.example.com/page">` } }) },
  {
    id: 'a11y-axe',
    test: /^axe_|axe_|color-contrast|button-name|link-name|label|aria-|landmark|empty_buttons|empty buttons/,
    build: (i, loc) => {
      const rule = (i.checkKey ?? '').replace(/^axe_/, '') || ev(i, 'rule');
      const sel = loc.elements[0]?.selector;
      const common = { change: sel ? `Fix the element \`${sel}\`.` : undefined, verify: 'Run the accessibility test again; the rule should no longer be reported.' };
      if (/color-contrast/.test(rule + i.title.toLowerCase())) return { topic: 'Low colour contrast', cause: 'Text and its background are too similar, so people with low vision or in bright light cannot read it. WCAG requires 4.5:1 for normal text and 3:1 for large text.', steps: ['Darken the text or lighten the background until the ratio passes (use a contrast checker).', 'Do not rely on colour alone to convey meaning.'], example: { lang: 'css', code: `.muted { color: #595959; background: #ffffff; } /* contrast 7:1 */` }, ...common };
      if (/button-name|empty_buttons|empty buttons/.test(rule + i.title.toLowerCase())) return { topic: 'Button without an accessible name', cause: 'An icon-only button has no text, so screen readers announce just "button".', steps: ['Add visible text, or an `aria-label` that says what the button does.'], example: { lang: 'html', code: `<button aria-label="Close dialog"><svg aria-hidden="true">…</svg></button>` }, ...common };
      if (/link-name/.test(rule)) return { topic: 'Link without a name', cause: 'A link with no text or label cannot be understood by screen-reader users.', steps: ['Give the link meaningful text or an `aria-label`.'], example: { lang: 'html', code: `<a href="/cart" aria-label="Shopping cart"><svg aria-hidden="true">…</svg></a>` }, ...common };
      if (/label/.test(rule + i.title.toLowerCase())) return { topic: 'Form field without a label', cause: 'Without a label, screen readers cannot tell users what to type and tapping the text does not focus the field.', steps: ['Connect a <label> to the input using `for` and `id`.'], example: { lang: 'html', code: `<label for="email">Email</label>\n<input id="email" type="email" name="email">` }, ...common };
      return { topic: i.title, cause: ev(i, 'description') || i.description, steps: ['Read the rule explanation (link in the evidence) and apply the suggested change to the listed elements.', i.suggestedFix].filter(Boolean), ...common };
    },
  },
  { id: 'a11y-keyboard', test: /keyboard_nav|focus_visible|positive_tabindex|clickable_non_interactive|main_landmark|keyboard|focus indicator/, build: () => ({ topic: 'Keyboard and focus', cause: 'Some users navigate only with the keyboard; controls need a visible focus outline, a logical tab order and real interactive elements.', steps: ['Never remove the focus outline without a replacement style.', 'Use <button> and <a href> instead of clickable <div>s.', 'Avoid positive `tabindex` values; use 0 or -1.'], example: { lang: 'css', code: `:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; }` } }) },
  {
    id: 'perf',
    test: /metric_|opportunity_|performance_score|lighthouse|load_event_time|page_load/,
    build: (i) => {
      const k = (i.checkKey ?? '') + ' ' + i.title.toLowerCase();
      if (/largest-contentful|lcp/.test(k)) return { topic: 'Largest Contentful Paint (slow main content)', cause: 'The biggest visible element (hero image or headline) appears late: slow server response, render-blocking CSS/JS or an unoptimised image.', steps: ['Compress and size the hero image; preload it with `<link rel="preload" as="image">`.', 'Reduce render-blocking CSS and JavaScript (defer scripts).', 'Improve server response time with caching or a CDN.'] };
      if (/layout-shift|cls/.test(k)) return { topic: 'Cumulative Layout Shift (content jumps)', cause: 'Elements change size or move while the page loads: images without dimensions, late-loading ads or fonts.', steps: ['Set `width` and `height` (or `aspect-ratio`) on images and embeds.', 'Reserve space for banners and ads.', 'Use `font-display: swap` with a similar fallback font.'], example: { lang: 'html', code: `<img src="a.jpg" width="800" height="450" alt="…">` } };
      if (/blocking-time|tbt|interactive/.test(k)) return { topic: 'Total Blocking Time (page busy)', cause: 'Long JavaScript tasks keep the main thread busy so taps and clicks feel slow.', steps: ['Split large bundles and load code on demand.', 'Remove unused JavaScript and heavy third-party scripts.', 'Move heavy work off the main thread (Web Workers).'] };
      if (/first-contentful|fcp|speed-index/.test(k)) return { topic: 'Slow first paint', cause: 'Nothing is shown for a while because CSS, fonts or scripts block rendering.', steps: ['Inline critical CSS and defer the rest.', 'Preconnect to required origins.', 'Avoid large render-blocking scripts in <head>.'] };
      if (/server-response|ttfb/.test(k)) return { topic: 'Slow server response (TTFB)', cause: 'The server takes long to answer: slow database queries, no caching or a distant server.', steps: ['Cache rendered pages or API responses.', 'Profile slow queries and add indexes.', 'Serve static content through a CDN.'] };
      return { topic: 'Performance', cause: i.description || 'The page loads slower than recommended.', steps: ['Work through the Lighthouse opportunities, largest saving first.', i.suggestedFix].filter(Boolean) };
    },
  },
  {
    id: 'ui-overflow',
    test: /horizontal_overflow|horizontal scroll|overflow/,
    build: (i, loc) => ({ topic: 'Horizontal overflow (sideways scrolling)', cause: 'Something is wider than the screen: a fixed pixel width, an image without `max-width`, or a long unbroken word, so the page scrolls sideways.', steps: ['Find the element that sticks out (listed below) and remove its fixed width.', 'Add `max-width: 100%` to images and media.', 'Use `overflow-wrap: anywhere` for long text.'], example: { lang: 'css', code: `img, video { max-width: 100%; height: auto; }\n.container { width: 100%; max-width: 1200px; }` }, change: loc.elements[0] ? `Fix \`${loc.elements[0].selector}\`.` : undefined }),
  },
  { id: 'ui-overlap', test: /overlap|ui_fixed_cover|covers/, build: (i, loc) => ({ topic: 'Overlapping or covered content', cause: 'Elements sit on top of each other or a fixed header/banner hides content, so users cannot read or click it.', steps: ['Check `position: absolute/fixed` and `z-index` on the listed elements.', 'Add padding to the page so fixed bars do not cover content.'], change: loc.elements[0] ? `Review \`${loc.elements[0].selector}\`.` : undefined }) },
  { id: 'ui-tap', test: /tap_targets|tap target|small_text|small text/, build: () => ({ topic: 'Controls and text too small on mobile', cause: 'Tap targets under about 44×44 px and text under 12 px are hard to use on phones.', steps: ['Make buttons and links at least 44×44 px with spacing between them.', 'Use at least 16px body text on mobile.'], example: { lang: 'css', code: `button, a.btn { min-width: 44px; min-height: 44px; }` } }) },
  { id: 'ui-img-dim', test: /ui_image_dimensions|image dimensions|layout_shift/, build: () => ({ topic: 'Images without dimensions', cause: 'The browser does not know how much space an image needs, so the layout shifts when it loads.', steps: ['Add `width` and `height` attributes (or CSS `aspect-ratio`).'], example: { lang: 'html', code: `<img src="a.jpg" width="800" height="450" alt="…">` } }) },
  { id: 'form', test: /form_no_submit|form_labels|form_email_type|form without|form fields|email field/, build: (i) => ({ topic: 'Form structure', cause: i.description, steps: ['Give every field a <label>.', 'Use the right input type (`email`, `tel`, `number`) so phones show the correct keyboard.', 'Add a submit button so keyboard and mobile users can send the form.'], example: { lang: 'html', code: `<form>\n  <label for="email">Email</label>\n  <input id="email" type="email" name="email" required>\n  <button type="submit">Send</button>\n</form>` } }) },
  { id: 'tabs', test: /tabs_state|tabs update/, build: () => ({ topic: 'Tabs do not update their state', cause: 'Clicking a tab does not set `aria-selected="true"`, so assistive technology and styles do not follow the active tab.', steps: ['In the click handler, set `aria-selected` on the active tab and `false` on the others, and show the matching panel.'] }) },
  { id: 'pag-same', test: /pagination_same_content|identical content/, build: () => ({ topic: 'Pagination shows the same content on every page', cause: 'The server ignores the page parameter, or the list is rendered by JavaScript that always loads page 1.', steps: ['Confirm the route reads `?page=` (or the path number) and applies an offset/limit to the query.', 'Open page 2 and 3 manually and compare the items.'], example: { lang: 'js', code: `const page = Math.max(1, Number(req.query.page) || 1);\nconst items = await db.items.find().skip((page - 1) * 20).limit(20);` } }) },
  { id: 'pag-self', test: /pagination_next_self|same page/, build: () => ({ topic: '"Next" points at the current page', cause: 'The next link was built with the current page number instead of page + 1.', steps: ['Build the next URL from `page + 1` and omit it on the last page.'], example: { lang: 'js', code: `const next = page < totalPages ? \`?page=\${page + 1}\` : null;` } }) },
  { id: 'pag-loop', test: /pagination_next_loop|loops back/, build: () => ({ topic: 'Pagination loops', cause: 'Following "next" links returns to a page that was already visited, so crawlers and users cycle forever.', steps: ['Check how the last page builds its "next" link and make sure it ends the chain.'] }) },
  { id: 'pag-js', test: /pagination_js_control|control changed nothing|load more/, build: () => ({ topic: '"Load more" / "Next" button does nothing', cause: 'Clicking the control produced no visible change: the handler throws, the request fails, or the button is disabled because no more items exist.', steps: ['Click the button with DevTools → Network and Console open and look for a failed request or an error.', 'Confirm the handler requests the next page and appends the results.', 'Disable and hide the button on the last page so it is never a dead control.'] }) },
  { id: 'pages-slow', test: /pages_slow|slow pages/, build: () => ({ topic: 'Slow pages', cause: 'These pages took over three seconds to download: uncached rendering or slow database queries.', steps: ['Cache the rendered HTML or API results.', 'Profile slow queries and add indexes.'] }) },
  { id: 'pwa', test: /manifest|service_worker|service worker|theme_color|pwa/, build: () => ({ topic: 'Installable web app (PWA)', cause: 'A valid manifest and a service worker are needed for installability and offline use.', steps: ['Serve `manifest.webmanifest` with `name`, `start_url`, `display` and 192/512 px icons.', 'Register a service worker over HTTPS.'], example: { lang: 'html', code: `<link rel="manifest" href="/manifest.webmanifest">` } }) },
  { id: 'visual', test: /visual_|visual change|baseline/, build: () => ({ topic: 'Visual change from the baseline', cause: 'The page looks different from the saved reference screenshot. That is expected after a redesign and a problem after an unintended CSS change.', steps: ['Open the page at the same width and compare it with the last version.', 'If the change is intended, reset the baseline so it becomes the new reference.'] }) },
  { id: 'untested', test: /permission_|file_upload|not tested/, build: () => ({ topic: 'Feature that needs a real user permission', cause: 'Camera, microphone, location, notifications and file uploads need a person to grant or perform them, so the tester never does. This was NOT tested and is not counted as passed.', steps: ['Test this feature manually on a real device and browser.'] }) },
  { id: 'links-misc', test: /placeholder_links|javascript_links|target_blank|empty or "#"|javascript: links/, build: () => ({ topic: 'Links that go nowhere', cause: 'Links with `href="#"` or `javascript:` break middle-click, crawling and accessibility.', steps: ['Point links at real URLs, or use <button> for actions.', 'Add `rel="noopener noreferrer"` to `target="_blank"` links.'], example: { lang: 'html', code: `<a href="/pricing">Pricing</a>\n<button type="button" onclick="openMenu()">Menu</button>` } }) },
  {
    id: 'api',
    test: /api_4xx|api_5xx|api_badjson|api_slow|api_insecure|api call/,
    build: (i) => ({ topic: 'API call problem', cause: i.description, steps: ['Open the call in DevTools → Network and read the status and response body.', 'Fix the route or payload, always return valid JSON with the right Content-Type, and use HTTPS.'], change: i.affectedUrl ? `Check the endpoint ${i.affectedUrl}.` : undefined }),
  },
];

const CATEGORY_FALLBACK: Record<string, string> = {
  console: 'Open DevTools → Console on the page, reproduce the problem and read the stack trace.',
  security: 'Review the header or setting named in the finding and apply the standard hardening for it.',
  accessibility: 'Follow the WCAG guidance linked in the evidence and retest.',
  seo: 'Fix the tag or file named in the finding so search engines can read the page.',
  performance: 'Follow the Lighthouse recommendation, largest saving first.',
  links: 'Open each affected URL and fix or remove the reference.',
};

export function explainIssue(issue: AssistantIssue, loc: Located): Explanation {
  const text = `${issue.checkKey ?? ''} ${issue.title} ${issue.description}`.toLowerCase();
  const head = keyOf(issue);
  const rule = RULES.find((r) => r.test.test(head)) ?? RULES.find((r) => r.test.test(text));
  if (rule) {
    const e = rule.build(issue, loc);
    return { ...e, steps: e.steps.filter(Boolean) };
  }
  return {
    topic: issue.title,
    cause: issue.description || 'The test observed behaviour that does not match what it expected.',
    steps: [issue.suggestedFix, CATEGORY_FALLBACK[issue.category] ?? 'Review the evidence, correct the cause and run the test again.'].filter(Boolean),
  };
}

/** Short general explanations for questions asked without a test report (or about a topic by name). */
export const TOPICS: Array<{ test: RegExp; title: string; body: string }> = [
  { test: /\bcors\b/i, title: 'CORS', body: 'Browsers block a page from reading a response from another origin unless that server sends `Access-Control-Allow-Origin`. Fix it on the API that is being called: allow your site\'s exact origin and answer the `OPTIONS` preflight request.' },
  { test: /\b404\b|not found/i, title: 'HTTP 404', body: 'The server has nothing at that URL. Check for a typo in the link, a file missing from the deployment, or a page that moved without a redirect. Restore it or add a 301 redirect.' },
  { test: /\b500\b|server error|internal server/i, title: 'HTTP 500', body: 'The server crashed while building the response. The cause is in the server logs for that route: look for the exception, fix it and add error handling.' },
  { test: /\bcls\b|layout shift/i, title: 'Layout shift (CLS)', body: 'Content moves while loading. Give images and embeds `width` and `height`, reserve space for banners and ads, and use `font-display: swap`.' },
  { test: /\blcp\b|largest contentful/i, title: 'Largest Contentful Paint', body: 'The main content appears late. Compress and preload the hero image, defer render-blocking scripts and improve server response time.' },
  { test: /\bcsp\b|content security policy/i, title: 'Content Security Policy', body: 'A CSP header limits which scripts and resources the browser may load, which blunts XSS. Start with `Content-Security-Policy-Report-Only`, then enforce an allow-list.' },
  { test: /\bmixed content\b/i, title: 'Mixed content', body: 'An HTTPS page loads something over HTTP. Change those URLs to HTTPS (or self-host the file) and add `upgrade-insecure-requests`.' },
  { test: /\balt\b|alt text/i, title: 'Alt text', body: 'Give each meaningful image an `alt` that states its purpose, and use `alt=""` for decorations.' },
  { test: /contrast/i, title: 'Colour contrast', body: 'WCAG needs a contrast ratio of at least 4.5:1 for normal text and 3:1 for large text.' },
];
