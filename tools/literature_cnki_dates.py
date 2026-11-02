"""CNKI publication dates selected through the visible calendar UI only.

No readonly attribute, value, calendar state or scroll style is modified by
script. A successful return proves the requested complete calendar boundary
was read back from the visible publication-date input, not merely its year.
"""
from __future__ import annotations

from datetime import date
import re
import time
from urllib.parse import urlsplit

from literature_source_access import submission_allowed


_IDS = {"from": "datebox0", "to": "datebox1"}
_MAX_WHEELS = 160
_OPERATION_SECONDS = 30
READ_DATES_JS = r'''/* literature_cnki_visible_dates */ () => {
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const result = {};
  for(const [role,id] of [['from','datebox0'],['to','datebox1']]) {
    const found = Array.from(document.querySelectorAll('.tit-date-box input.publishdate#'+id)).filter(visible);
    if(found.length!==1 || found[0].disabled) return {};
    result[role] = String(found[0].value || '');
  }
  return result;
}'''


def year_bound_value(role, year):
    """The inclusive whole-year boundary; invalid parameters return None."""
    if role not in _IDS or isinstance(year, bool) or not isinstance(year, int) or not 1 <= year <= 9999:
        return None
    return f"{year:04d}-01-01" if role == "from" else f"{year:04d}-12-31"


def parse_date_value(value):
    """Parse a complete unambiguous date; a bare year is insufficient proof."""
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})\s*", value)
    if not match:
        return None
    try:
        return date(int(match[1]), int(match[3]), int(match[4]))
    except ValueError:
        return None


def bounds_match(values, year_from=None, year_to=None):
    """Validate requested complete bounds, including ordering when both exist."""
    if not isinstance(values, dict):
        return False
    if year_from is not None and year_to is not None:
        if year_bound_value("from", year_from) is None or year_bound_value("to", year_to) is None or year_from > year_to:
            return False
    for role, year in (("from", year_from), ("to", year_to)):
        if year is None:
            continue
        expected = year_bound_value(role, year)
        if expected is None or parse_date_value(values.get(role)) != parse_date_value(expected):
            return False
    return True


def _allowed(page):
    try:
        parsed = urlsplit(str(page.url or ""))
        host = (parsed.hostname or "").lower()
        return (parsed.scheme in {"http", "https"} and not parsed.username and not parsed.password
                and (host == "cnki.net" or host.endswith(".cnki.net"))
                and submission_allowed(page, "cnki"))
    except Exception:
        return False


def read_date_bounds(page):
    """Read only the two uniquely visible CNKI publication-date input values."""
    if not _allowed(page):
        return {}
    try:
        result = page.evaluate(READ_DATES_JS)
        if not isinstance(result, dict) or set(result) != {"from", "to"}:
            return {}
        return {role: value for role, value in result.items() if isinstance(value, str)}
    except Exception:
        return {}


def _visible_unique(page, selector):
    target = page.locator(selector)
    return target if target.count() == 1 and target.is_visible() else None


def _timeout(deadline):
    return max(1, min(3_000, int((deadline - time.monotonic()) * 1_000)))


def _click(page, target, deadline):
    if (time.monotonic() >= deadline or target is None or not _allowed(page) or not target.is_visible() or not target.is_enabled()
            or target.get_attribute("aria-disabled") == "true"):
        return False
    if "xdsoft_disabled" in (target.get_attribute("class") or "").split():
        return False
    target.click(timeout=_timeout(deadline))
    return _allowed(page)


def _inside(option, container):
    if not option or not container or min(option["width"], option["height"], container["width"], container["height"]) <= 0:
        return False
    x = option["x"] + option["width"] / 2
    y = option["y"] + option["height"] / 2
    return (container["x"] + 1 <= x <= container["x"] + container["width"] - 1
            and container["y"] + 1 <= y <= container["y"] + container["height"] - 1)


def _wait_year(page, picker, year, deadline):
    until = min(deadline, time.monotonic() + 2)
    while time.monotonic() < until:
        if not _allowed(page):
            return False
        label = _visible_unique(page, f"{picker} .xdsoft_label.xdsoft_year > span")
        if label is not None and label.inner_text().strip() in {str(year), f"{year}年"}:
            return True
        time.sleep(0.05)
    return False


def _select_option(page, picker, component, value, deadline):
    """Expose a clipped option by real wheel events, then perform a normal click."""
    dropdown_selector = f"{picker} .xdsoft_{component}select"
    dropdown = _visible_unique(page, dropdown_selector)
    if dropdown is None:
        if not _click(page, _visible_unique(page, f"{picker} .xdsoft_label.xdsoft_{component}"), deadline):
            return False
        page.locator(dropdown_selector).wait_for(state="visible", timeout=_timeout(deadline))
        dropdown = _visible_unique(page, dropdown_selector)
    if dropdown is None or not _allowed(page):
        return False
    option = _visible_unique(page, f'{dropdown_selector} .xdsoft_option[data-value="{value}"]')
    if option is None:
        return False
    previous_y, stationary, hovered = None, 0, False
    for attempt in range(_MAX_WHEELS + 1):
        if time.monotonic() >= deadline or not _allowed(page) or not dropdown.is_visible() or not option.is_visible():
            return False
        box, target_box = dropdown.bounding_box(), option.bounding_box()
        if _inside(target_box, box):
            return _click(page, option, deadline)
        if not box or not target_box or attempt == _MAX_WHEELS:
            return False
        if previous_y is not None and abs(target_box["y"] - previous_y) < 0.5:
            stationary += 1
            if stationary >= 3:
                return False
        else:
            stationary = 0
        previous_y = target_box["y"]
        direction = -1 if target_box["y"] + target_box["height"] / 2 < box["y"] else 1
        if not hovered:
            dropdown.hover(timeout=_timeout(deadline))
            if not _allowed(page):
                return False
            hovered = True
        page.mouse.wheel(0, direction * 500)
        time.sleep(0.05)
    return False


def set_year_bound(page, role, year):
    """Set a CNKI whole-year boundary through its linked visible calendar.

    Return False on ambiguous controls, blocked access or incomplete readback.
    Existing matching values require no click. This never submits a search.
    """
    expected = year_bound_value(role, year)
    if expected is None or not _allowed(page):
        return False
    deadline = time.monotonic() + _OPERATION_SECONDS
    try:
        values = read_date_bounds(page)
        if role not in values:
            return False
        if parse_date_value(values[role]) == parse_date_value(expected):
            return True
        field_id = _IDS[role]
        input_selector = f".tit-date-box input.publishdate#{field_id}"
        picker = f'.xdsoft_datetimepicker[date-id="{field_id}"]:visible'
        # Clicking the already-open input toggles this picker closed. Resume
        # its visible UI state, including a partially scrolled year dropdown.
        if _visible_unique(page, picker) is None:
            if not _click(page, _visible_unique(page, input_selector), deadline):
                return False
        page.locator(picker).wait_for(state="visible", timeout=_timeout(deadline))
        if _visible_unique(page, picker) is None or not _allowed(page):
            return False
        year_label = _visible_unique(page, f"{picker} .xdsoft_label.xdsoft_year > span")
        if year_label is None:
            return False
        if year_label.inner_text().strip() not in {str(year), f"{year}年"}:
            if not _select_option(page, picker, "year", year, deadline):
                return False
        if not _wait_year(page, picker, year, deadline):
            return False
        month, day = (0, 1) if role == "from" else (11, 31)
        if not _select_option(page, picker, "month", month, deadline):
            return False
        day_selector = (f'{picker} .xdsoft_calendar td[data-year="{year}"]'
                        f'[data-month="{month}"][data-date="{day}"]')
        if time.monotonic() >= deadline or not _allowed(page):
            return False
        page.locator(day_selector).wait_for(state="visible", timeout=_timeout(deadline))
        if not _click(page, _visible_unique(page, day_selector), deadline):
            return False
        return parse_date_value(read_date_bounds(page).get(role)) == parse_date_value(expected)
    except Exception:
        return False
