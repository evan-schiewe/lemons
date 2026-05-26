export function queryRequired<T extends Element>(
  selector: string,
  root: ParentNode = document,
): T {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element as T;
}

export function closestElement<T extends Element>(
  target: EventTarget | null,
  selector: string,
): T | null {
  return target instanceof Element
    ? (target.closest(selector) as T | null)
    : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
