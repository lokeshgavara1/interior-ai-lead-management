/**
 * Normalise a phone number to E.164 (e.g. "+919876543210").
 * Returns null when the input cannot be a valid number.
 *
 * Handles common Indian inputs: "98765 43210", "09876543210", "+91-98765-43210",
 * "919876543210" (WhatsApp wa_id format), "0091 98765 43210".
 */
export function normalizePhone(input: string | null | undefined, defaultCountryCode = '91'): string | null {
  if (!input) return null;
  let digits = input.replace(/[^\d+]/g, '');
  const hadPlus = digits.startsWith('+');
  digits = digits.replace(/\+/g, '');

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (!hadPlus) {
    // National formats
    if (digits.length === 11 && digits.startsWith('0')) digits = defaultCountryCode + digits.slice(1);
    else if (digits.length === 10) digits = defaultCountryCode + digits;
  }

  if (digits.length < 11 || digits.length > 15 || digits.startsWith('0')) return null;

  // Extra sanity check for India: mobile numbers start with 6-9
  if (digits.startsWith('91') && digits.length === 12 && !/^91[6-9]/.test(digits)) return null;

  return `+${digits}`;
}

/** WhatsApp Cloud API expects recipients without the leading "+". */
export function toWhatsAppId(e164: string): string {
  return e164.replace(/^\+/, '');
}
