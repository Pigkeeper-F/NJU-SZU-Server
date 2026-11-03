"""Shared foreground-only access guard for source navigation and form submission."""
import re
from urllib.parse import urlsplit


ACCESS_STATE_JS = r"""/* literature_snapshot_access_state */ ({source,limit}) => {
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const head = (document.body?.innerText || '').slice(0,1600);
  const status = Array.from(document.querySelectorAll('h1,h2,[role="alert"],.error-message,.error-title'))
    .filter(visible).map(el => el.innerText || el.textContent || '').join(' ').slice(0,1600);
  const captcha = Array.from(document.querySelectorAll('iframe[src*="captcha"],iframe[src*="recaptcha"],.geetest_panel,.verifybox,#captcha,.captcha,#challenge-running,.cf-turnstile')).some(visible)
    || /人机验证|滑动验证|请完成(?:安全)?验证|安全验证|滑块|拖动到最右|访问验证|验证码|unusual traffic|verify you are human|are you a robot|verify your identity|checking your browser/i.test(head);
  const password = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
  const loginPrompt = /请先登录|请登录后|登录后方可|登录后检索|请通过机构登录|需要机构登录|sign in to access|sign in to search|log in to access|please sign in|please log in|access through your institution|institutional sign in/i.test(head);
  const accessRequired = /您所在的机构未订购|没有访问权限|无访问权限|不在授权范围|机构没有订购|your institution does not have|institutional access is required|not entitled|subscription required|access is not available|you do not have access|not authorized to access/i.test(head);
  const rateLimited = /too many requests|request limit (?:exceeded|reached)|rate limit exceeded|访问(?:过于|太过|太)?频繁|请求(?:过于|太过|太)?频繁|操作(?:过于|太过|太)?频繁|请求次数(?:过多|超过|已达)|访问次数(?:过多|超过|已达)|temporarily blocked due to|(?:HTTP|error|status)(?:\s+code)?\s*:?\s*429\b/i.test(head + ' ' + status)
    || /^\s*429\b/.test(status);
  const accessBlocked = /access denied|(?:your (?:ip|access)|this request|your request).{0,70}(?:has been|was|is) blocked|request blocked|访问(?:已)?被(?:拒绝|限制)|请求(?:已)?被(?:拒绝|阻止)|IP.{0,20}(?:被封|已封|被限制)/i.test(head);
  const resultsLoading = Array.from(document.querySelectorAll('[aria-busy="true"],.loading-mask,.el-loading-mask,.loading-overlay,[data-testid="loading-spinner"],.skeleton,.skeleton-loader')).some(visible);
  return {captcha,password,loginPrompt,accessRequired,rateLimited,accessBlocked,resultsLoading};
}"""


def submission_allowed(page, source):
    """Read status immediately before submitting; never solve or retry a block."""
    state = page.evaluate(ACCESS_STATE_JS, {"source": source, "limit": 1})
    if any(state.get(key) for key in ("captcha", "password", "loginPrompt", "accessRequired", "rateLimited", "accessBlocked")):
        return False
    parsed = urlsplit(str(getattr(page, "url", "") or ""))
    return not (re.search(r"(?:^|[/_.-])(?:login|signin|sign-in|authorize|oauth|saml|sso|callback)(?:$|[/_.-])", parsed.path, re.I)
                or re.search(r"(?:^|\.)(?:login|auth|sso|passport)(?:\.|$)", parsed.hostname or "", re.I))
