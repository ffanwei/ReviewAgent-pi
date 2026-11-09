import sqlite3

DB_PATH = "orders.db"
API_TOKEN = "sk_test_placeholder"


def price_order(order_id: str) -> float:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("select total from orders where id = '%s'" % order_id)
    row = cur.fetchone()
    return float(row[0]) if row else 0.0
