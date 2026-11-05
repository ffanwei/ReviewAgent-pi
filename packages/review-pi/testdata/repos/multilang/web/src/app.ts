export interface Renderer {
  render(name: string): string;
}

export class Greeter implements Renderer {
  private prefix = "Hello";
  count = 0;

  constructor(public name: string) {}

  render(name: string): string {
    return this.renderName(name);
  }

  private renderName(name: string): string {
    return `${this.prefix}, ${name}`;
  }
}

export function greetAll(names: string[]): string[] {
  return names.map((name) => new Greeter(name).render(name));
}

export const shout = (text: string): string => text.toUpperCase();
