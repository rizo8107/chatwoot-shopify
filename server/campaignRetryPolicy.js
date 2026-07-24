export const MAX_CAMPAIGN_DELIVERY_RETRIES = 2;
export const CAMPAIGN_RETRY_DELAYS_MS = [60 * 60 * 1000, 2 * 60 * 60 * 1000];

const PERMANENT_FAILURE_PATTERNS = [
  /missing (?:value|parameter)/i,
  /required parameter/i,
  /scientific notation/i,
  /no valid phone/i,
  /phone number is invalid/i,
  /invalid (?:phone|recipient|parameter|template)/i,
  /template requires/i,
  /template .* (?:not found|does not exist|not approved)/i,
  /no whatsapp template/i,
  /not configured/i,
  /not a whatsapp/i,
  /blocked/i,
  /opt(?:ed)?[- ]?out/i,
  /\b131008\b/,
  /\b131026\b/,
  /\b132000\b/,
  /\b132001\b/,
  /(?:HTTP|failed:)\s*(?:400|401|403|404|422)\b/i
];

export function campaignRetryDecision(error, completedRetries = 0, now = Date.now()) {
  const retryCount = Math.max(0, Number(completedRetries || 0));
  const errorText = typeof error === 'string' ? error : JSON.stringify(error || '');
  if (PERMANENT_FAILURE_PATTERNS.some(pattern => pattern.test(errorText))) {
    return { shouldRetry: false, reason: 'permanent_failure', retryCount };
  }
  if (retryCount >= MAX_CAMPAIGN_DELIVERY_RETRIES) {
    return { shouldRetry: false, reason: 'retry_limit_reached', retryCount };
  }
  const delayMs = CAMPAIGN_RETRY_DELAYS_MS[retryCount];
  return {
    shouldRetry: true,
    reason: 'scheduled',
    retryCount: retryCount + 1,
    delayMs,
    runAt: new Date(now + delayMs).toISOString()
  };
}
