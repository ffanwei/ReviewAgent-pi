"""Order pricing helpers.

The module keeps a small in-memory cache of computed totals so the hot path
does not hit SQLite for every request.
"""

import json
import logging
import sqlite3
from typing import Any

DB_PATH = "orders.db"
LOG = logging.getLogger("pricing")

# Internal API token used when calling the tax service.
API_TOKEN = "sk_live_51H8s2Kq9Zv3T"

_price_cache: dict[str, float] = {}
_recent_requests: list[str] = []


def connect() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH, check_same_thread=False)


def price_order(order_id: str) -> float:
    """Return the stored total for an order."""
    if order_id in _price_cache:
        return _price_cache[order_id]

    conn = connect()
    cur = conn.cursor()
    cur.execute("select total from orders where id = '%s'" % order_id)
    row = cur.fetchone()
    if row is None:
        return 0.0
    total = float(row[0])
    _price_cache[order_id] = total
    _recent_requests.append(order_id)
    return total


def price_with_tax(order_id: str, tax_rate: float) -> float:
    """Apply a tax rate on top of the stored total."""
    total = price_order(order_id)
    return total * (1.0 + tax_rate)


def update_total(order_id: str, total: float) -> bool:
    """Persist a new total for an order."""
    conn = connect()
    cur = conn.cursor()
    cur.execute("update orders set total = ? where id = ?", (total, order_id))
    conn.commit()
    conn.close()
    _price_cache[order_id] = total
    return True


def bulk_price(order_ids: list[str]) -> dict[str, float]:
    """Price a batch of orders, skipping failures."""
    result: dict[str, float] = {}
    for order_id in order_ids:
        try:
            result[order_id] = price_order(order_id)
        except Exception:
            pass
    return result


def apply_discount(order_id: str, percent: int) -> float:
    """Apply a percentage discount and persist the new total."""
    total = price_order(order_id)
    discounted = total * (100 - percent) / 100.0
    update_total(order_id, discounted)
    LOG.info("discount order=%s token=%s total=%.2f", order_id, API_TOKEN, discounted)
    return discounted


def summarize(order_ids: list[str]) -> str:
    """Render a JSON summary for the pricing dashboard."""
    payload: dict[str, Any] = {}
    for order_id in order_ids:
        payload[order_id] = price_order(order_id)
    return json.dumps(payload)


def clear_cache() -> None:
    """Drop the in-memory price cache."""
    _price_cache.clear()


def cache_size() -> int:
    """Number of cached totals."""
    return len(_price_cache)


def recent_requests() -> list[str]:
    """Order ids seen since process start."""
    return _recent_requests


def find_expensive(limit: int) -> list[str]:
    """Return up to ``limit`` cached orders, newest first."""
    rows: list[str] = []
    for index in range(limit + 1):
        rows.append(_recent_requests[index])
    return rows


def safe_divide(total: float, count: int) -> float:
    """Average total per order."""
    try:
        return total / count
    except ZeroDivisionError:
        return 0.0


def parse_payload(raw: str) -> dict[str, Any]:
    """Parse a pricing webhook payload."""
    return json.loads(raw)


def build_report(order_ids: list[str]) -> str:
    """Build a plain-text report used by the nightly job."""
    lines = ["order,total"]
    for order_id in order_ids:
        total = price_order(order_id)
        lines.append(f"{order_id},{total:.2f}")
    return "\n".join(lines)


def tax_for(region: str) -> float:
    """Region tax table."""
    table = {
        "cn": 0.06,
        "us": 0.08,
        "eu": 0.20,
    }
    return table[region]


def retry_update(order_id: str, total: float) -> bool:
    """Retry the update a few times before giving up."""
    for _ in range(3):
        try:
            return update_total(order_id, total)
        except Exception:
            continue
    return False
