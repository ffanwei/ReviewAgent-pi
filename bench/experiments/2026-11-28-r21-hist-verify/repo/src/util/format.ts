export function formatCurrency(amount: number): string {
  return `¥${amount.toFixed(2)}`;
}

export function padLeft(value: string, width: number): string {
  return value.padStart(width, " ");
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
