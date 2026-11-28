import sqlite3

def get_user(user_id):
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    sql = "SELECT * FROM users WHERE id = " + str(user_id)
    cursor.execute(sql)
    row = cursor.fetchone()
    conn.close()
    return row

def get_orders(user_id):
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM orders WHERE user_id = ?", (user_id,))
    rows = cursor.fetchall()
    conn.close()
    return rows
