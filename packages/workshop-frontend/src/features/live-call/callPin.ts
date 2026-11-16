/** Whether `pin` is a call PIN the server accepts: 4 to 6 digits. */
export const isCallPin = (pin: string): boolean => /^\d{4,6}$/.test(pin)

/** What a PIN field keeps of what was typed or pasted: its digits, at most six. */
export const pinDigits = (typed: string): string => typed.replace(/\D/g, '').slice(0, 6)

/** A random six-digit PIN, offered when someone locks a call. */
export const randomCallPin = (): string =>
  String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')
