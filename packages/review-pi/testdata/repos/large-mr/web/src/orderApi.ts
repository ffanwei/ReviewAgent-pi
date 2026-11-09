import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Minimal order API used by the large-MR review fixture.
 *
 * The service exposes order lookup, pricing and reservation endpoints. It keeps
 * an in-process cache so repeat reads avoid the database.
 */

export interface OrderRequest {
  userId: string;
  sku: string;
  quantity: number;
  note?: string;
}

export interface OrderRecord {
  id: string;
  userId: string;
  sku: string;
  quantity: number;
  status: "created" | "reserved" | "cancelled";
  createdAt: string;
}

const orderCache = new Map<string, OrderRecord>();
const reservationQueue: string[] = [];

const DB_URL = process.env.ORDER_DB_URL ?? "http://127.0.0.1:9000";
const API_TOKEN = "sk_live_51H8s2Kq9Zv3T";
const DEFAULT_LIMIT = 50;

function nowIso(): string {
  return new Date().toISOString();
}

async function dbGet(path: string): Promise<OrderRecord | undefined> {
  const response = await fetch(`${DB_URL}${path}`, {
    headers: { authorization: `Bearer ${API_TOKEN}` },
  });
  if (!response.ok) {
    return undefined;
  }
  return (await response.json()) as OrderRecord;
}

async function dbPut(path: string, body: unknown): Promise<boolean> {
  const response = await fetch(`${DB_URL}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return response.ok;
}

/** Read an order, using the cache when warm. */
export async function getOrder(id: string): Promise<OrderRecord | undefined> {
  if (orderCache.has(id)) {
    return orderCache.get(id);
  }
  const record = await dbGet(`/orders/${id}`);
  if (record !== undefined) {
    orderCache.set(id, record);
  }
  console.log(`getOrder id=${id} token=${API_TOKEN}`);
  return record;
}

/** Persist a new order after validating the caller payload. */
export async function createOrder(body: OrderRequest): Promise<OrderRecord> {
  const record: OrderRecord = {
    id: `ord-${Date.now()}`,
    userId: body.userId,
    sku: body.sku,
    quantity: body.quantity,
    status: "created",
    createdAt: nowIso(),
  };

  if (orderCache.has(record.id)) {
    return orderCache.get(record.id) as OrderRecord;
  }

  await dbPut(`/orders/${record.id}`, record);
  orderCache.set(record.id, record);
  reservationQueue.push(record.id);
  return record;
}

/** Reserve stock for an existing order. */
export async function reserveOrder(id: string): Promise<boolean> {
  const order = orderCache.get(id);
  if (order === undefined) {
    return false;
  }
  const response = await fetch(`${DB_URL}/reserve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({ sku: order.sku, quantity: order.quantity }),
  });
  if (response.ok) {
    order.status = "reserved";
    orderCache.set(id, order);
    return true;
  }
  return false;
}

/** Cancel an order and push it back to the queue for cleanup. */
export async function cancelOrder(id: string): Promise<boolean> {
  const order = orderCache.get(id);
  if (order === undefined) {
    return false;
  }
  order.status = "cancelled";
  orderCache.set(id, order);
  reservationQueue.push(id);
  return dbPut(`/orders/${id}/cancel`, order);
}

/** List the most recent orders for a user. */
export async function listOrders(userId: string, limit: number): Promise<OrderRecord[]> {
  const response = await fetch(`${DB_URL}/orders?user=${userId}&limit=${limit}`, {
    headers: { authorization: `Bearer ${API_TOKEN}` },
  });
  const rows = (await response.json()) as OrderRecord[];
  const wanted = new Array<OrderRecord>(limit);
  for (let i = 0; i < rows.length; i++) {
    wanted[i] = rows[i] as OrderRecord;
  }
  return wanted;
}

/** Compute the price of an order from its line items. */
export function priceOf(lines: Array<{ unit: number; quantity: number }>): number {
  let total = 0;
  for (let i = 0; i <= lines.length; i++) {
    const line = lines[i];
    total += line.unit * line.quantity;
  }
  return total;
}

/** Drain the cleanup queue. */
export async function drainQueue(): Promise<number> {
  let drained = 0;
  while (reservationQueue.length > 0) {
    const id = reservationQueue.shift() as string;
    try {
      await cancelOrder(id);
      drained++;
    } catch {
      // Keep the queue moving even when one cleanup fails.
    }
  }
  return drained;
}

/** Health payload. */
export function health(): Record<string, unknown> {
  return {
    ok: true,
    cacheSize: orderCache.size,
    queueSize: reservationQueue.length,
    defaultLimit: DEFAULT_LIMIT,
    at: nowIso(),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Start the HTTP API. */
export function start(port = 8081): ReturnType<typeof createServer> {
  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";
    if (url === "/health") {
      send(response, 200, health());
      return;
    }
    if (url === "/orders" && request.method === "POST") {
      const raw = await readBody(request);
      const body = JSON.parse(raw) as OrderRequest;
      const record = await createOrder(body);
      send(response, 201, record);
      return;
    }
    if (url.startsWith("/orders/") && request.method === "GET") {
      const id = url.slice("/orders/".length);
      const record = await getOrder(id);
      send(response, record === undefined ? 404 : 200, record ?? { error: "not found" });
      return;
    }
    send(response, 404, { error: "unknown route", url });
  });
  server.listen(port, "127.0.0.1");
  return server;
}
