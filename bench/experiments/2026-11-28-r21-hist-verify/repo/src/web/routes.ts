export interface Route {
  readonly path: string;
  readonly handler: () => Promise<void>;
}

export const routes: Route[] = [];

export function register(route: Route): void {
  routes.push(route);
}
