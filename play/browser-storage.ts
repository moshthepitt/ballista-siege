/** Reading a saved burner must not load the chain implementation. */
export const BURNER_KEY = 'ballista-siege.v1.burner';
export function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
