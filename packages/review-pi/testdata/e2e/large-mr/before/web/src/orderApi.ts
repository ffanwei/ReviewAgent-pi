export interface OrderRequest {
  userId: string;
  sku: string;
  quantity: number;
}

const cache = new Map<string, unknown>();

export async function getOrder(id: string): Promise<unknown> {
  return cache.get(id);
}

export function putOrder(id: string, value: unknown): void {
  cache.set(id, value);
}
